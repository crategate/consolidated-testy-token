import { useCallback, useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import ammIdl from '../../../../target/idl/amm.json';
import stakingIdl from '../../../../target/idl/staking.json';
import type { DeploymentConfig } from '../../config';
import { lotTokens } from './offerMath.ts';

/* ── helpers ── */
function idlProgramId(idl: unknown): PublicKey {
    const meta = idl as { metadata?: { address?: string }; address?: string };
    const address = meta.metadata?.address ?? meta.address;
    if (!address) throw new Error('IDL missing program address');
    return new PublicKey(address);
}

function pk(value?: string): PublicKey | null {
    if (!value) return null;
    try { return new PublicKey(value); } catch { return null; }
}

function decode(coder: BorshAccountsCoder, name: string, data: Uint8Array) {
    try { return coder.decode(name, Buffer.from(data)) as Record<string, unknown> | null; }
    catch { return null; }
}

function pub(obj: Record<string, unknown> | null, name: string): PublicKey | null {
    const v = obj?.[name];
    return v instanceof PublicKey ? v : null;
}

function big(v: unknown): bigint {
    if (v === undefined || v === null) return 0n;
    return BigInt(v.toString());
}

async function fetchConfig(): Promise<DeploymentConfig> {
    const res = await fetch(`/deployment.json?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : {};
}

/* ── types ── */
export interface OfferTierData {
    key: 'sml' | 'med' | 'big';
    tier: number;          // on-chain tier arg: 0 = sml, 1 = med, 2 = big
    label: string;
    lotTier: number;       // raw lot_size field (tier index 0–21)
    lotTokens: number;     // translated via lot_sizer
    vestingDays: number;
    discountBps: number;   // stored tenths of a percent (115 = 11.5%)
    remaining: number;
    totalOffered: number;
}

// Every address offer_claim needs, resolved from on-chain state.
export interface ClaimAccounts {
    ammState: PublicKey;
    offerList: PublicKey;
    nysehMint: PublicKey;
    usdcMint: PublicKey;
    spotOracle: PublicKey;
    marketStatus: PublicKey;
    stakingPool: PublicKey;
    stakingVault: PublicKey;
    ammUsdcVault: PublicKey;
    usdcDip: PublicKey;
    usdcRewards: PublicKey;
    ammNysehVault: PublicKey;
}

export interface OfferDeskData {
    tiers: OfferTierData[];
    livePrice: bigint | null;    // raw u64 floor units from the spot oracle
    floorBasis: bigint;          // highest_buyback_basis ratchet floor
    nysehDecimals: number;
    usdcDecimals: number;
    marketState: number | null;  // 0 open · 1 after-hours · 2 closed · 3 halted
    tradingDay: number | null;
    sheetDay: number | null;
    deskOpen: boolean;           // state 1|2 AND tonight's sheet posted
    sheetStale: boolean;
    offersLive: boolean;         // any tier with remaining > 0
    accounts: ClaimAccounts | null;
    loading: boolean;
    error: string | null;
    updatedAt: string | null;
    refresh: () => void;
}

const AMM_PROGRAM_ID = idlProgramId(ammIdl);
const ammCoder = new BorshAccountsCoder(ammIdl as Idl);
const stakingCoder = new BorshAccountsCoder(stakingIdl as Idl);

const INITIAL: Omit<OfferDeskData, 'refresh'> = {
    tiers: [],
    livePrice: null,
    floorBasis: 0n,
    nysehDecimals: 9,
    usdcDecimals: 6,
    marketState: null,
    tradingDay: null,
    sheetDay: null,
    deskOpen: false,
    sheetStale: false,
    offersLive: false,
    accounts: null,
    loading: true,
    error: null,
    updatedAt: null,
};

function parseTier(key: 'sml' | 'med' | 'big', tier: number, label: string, raw: unknown): OfferTierData {
    const o = (raw ?? {}) as Record<string, unknown>;
    const lotTier = Number(o.lotSize ?? 0);
    return {
        key,
        tier,
        label,
        lotTier,
        lotTokens: lotTokens(lotTier),
        vestingDays: Number(o.vestingDays ?? 0),
        discountBps: Number(o.discountBps ?? 0),
        remaining: Number(o.remaining ?? 0),
        totalOffered: Number(o.totalOffered ?? 0),
    };
}

export function useAmmData(): OfferDeskData {
    const { connection } = useConnection();
    const [data, setData] = useState<Omit<OfferDeskData, 'refresh'>>(INITIAL);

    const load = useCallback(async () => {
        if (!connection) return;
        try {
            const config = await fetchConfig();
            const mint = pk(config.mint);
            if (!mint) throw new Error('Mint not configured in deployment.json');
            const ammProgram = pk(config.ammProgram) ?? AMM_PROGRAM_ID;

            const [ammStatePda] = PublicKey.findProgramAddressSync(
                [Buffer.from('amm_state'), mint.toBuffer()], ammProgram
            );
            const [offerListPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('offer_list'), mint.toBuffer()], ammProgram
            );

            const [stateInfo, sheetInfo] = await connection.getMultipleAccountsInfo([
                ammStatePda, offerListPda,
            ]);
            if (!stateInfo) throw new Error('AMM state not found on-chain — run anchor run amm-init first');
            const ammState = decode(ammCoder, 'AmmState', stateInfo.data);
            if (!ammState) throw new Error('Failed to decode AmmState');
            const offerList = sheetInfo ? decode(ammCoder, 'OfferList', sheetInfo.data) : null;

            const spotOracle = pub(ammState, 'spotOracle');
            const crankProgram = pub(ammState, 'crankProgram');
            const stakingPool = pub(ammState, 'stakingPool');
            if (!spotOracle || !crankProgram || !stakingPool) {
                throw new Error('AmmState missing oracle/crank/staking addresses');
            }
            const [marketStatusPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('market_status')], crankProgram
            );

            // dependent accounts: price oracle, market status, mints, staking pool
            const [spotInfo, statusInfo, nysehInfo, usdcInfo, poolInfo] =
                await connection.getMultipleAccountsInfo([
                    spotOracle,
                    marketStatusPda,
                    mint,
                    pub(ammState, 'usdcMint') ?? PublicKey.default,
                    stakingPool,
                ]);

            // spot oracle: raw-u64 mock price PDA, LE u64 at offset 0 (floor units)
            let livePrice: bigint | null = null;
            if (spotInfo && spotInfo.data.length >= 8) {
                livePrice = new DataView(spotInfo.data.buffer, spotInfo.data.byteOffset).getBigUint64(0, true);
            }

            // MarketStatus layout: disc(8) + state(1) + timestamp(8) + day(8)
            let marketState: number | null = null;
            let tradingDay: number | null = null;
            if (statusInfo && statusInfo.data.length >= 25) {
                const view = new DataView(statusInfo.data.buffer, statusInfo.data.byteOffset);
                marketState = view.getUint8(8);
                tradingDay = Number(view.getBigUint64(17, true));
            }

            // SPL mint layout: decimals byte at offset 44
            const nysehDecimals = nysehInfo && nysehInfo.data.length > 44 ? nysehInfo.data[44] : 9;
            const usdcDecimals = usdcInfo && usdcInfo.data.length > 44 ? usdcInfo.data[44] : 6;

            const pool = poolInfo ? decode(stakingCoder, 'StakePool', poolInfo.data) : null;
            const stakingVault = pub(pool, 'vault') ?? pk(config.vault);

            const tiers = offerList
                ? [
                    parseTier('big', 2, 'Bulk lot', offerList.bigOffer),
                    parseTier('med', 1, 'Medium lot', offerList.medOffer),
                    parseTier('sml', 0, 'Small lot', offerList.smlOffer),
                ]
                : [];

            const sheetDay = offerList ? Number(big(offerList.dayIndex)) : null;
            const offersLive = tiers.some((t) => t.remaining > 0);
            const nightGate = marketState === 1 || marketState === 2;
            const sheetStale = sheetDay !== null && tradingDay !== null && sheetDay !== tradingDay;
            const deskOpen = nightGate && offersLive && !sheetStale;

            const usdcMint = pub(ammState, 'usdcMint');
            const usdcVault = pub(ammState, 'usdcVault');
            const usdcDip = pub(ammState, 'usdcDip');
            const usdcRewards = pub(ammState, 'usdcRewards');
            const nysehVault = pub(ammState, 'nysehVault');
            const accounts: ClaimAccounts | null =
                usdcMint && usdcVault && usdcDip && usdcRewards && nysehVault && stakingVault
                    ? {
                        ammState: ammStatePda,
                        offerList: offerListPda,
                        nysehMint: mint,
                        usdcMint,
                        spotOracle,
                        marketStatus: marketStatusPda,
                        stakingPool,
                        stakingVault,
                        ammUsdcVault: usdcVault,
                        usdcDip,
                        usdcRewards,
                        ammNysehVault: nysehVault,
                    }
                    : null;

            setData({
                tiers,
                livePrice,
                floorBasis: big(ammState.highestBuybackBasis),
                nysehDecimals,
                usdcDecimals,
                marketState,
                tradingDay,
                sheetDay,
                deskOpen,
                sheetStale,
                offersLive,
                accounts,
                loading: false,
                error: null,
                updatedAt: new Date().toISOString(),
            });
        } catch (err) {
            setData((prev) => ({
                ...prev,
                loading: false,
                error: err instanceof Error ? err.message : 'RPC fetch failed',
            }));
        }
    }, [connection]);

    useEffect(() => {
        // Deferred to a microtask so no setState runs synchronously inside the effect
        void Promise.resolve().then(load);
        const timer = setInterval(load, 30_000);
        return () => clearInterval(timer);
    }, [load]);

    return { ...data, refresh: load };
}
