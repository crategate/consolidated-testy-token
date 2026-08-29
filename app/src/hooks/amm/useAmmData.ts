import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
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

function pub(obj: Record<string, unknown> | null, ...names: string[]): PublicKey | null {
    const v = field(obj, ...names);
    return v instanceof PublicKey ? v : null;
}

// Anchor 0.31 `anchor build` emits snake_case IDL field names, while
// Program-based accessors (and older coders) use camelCase — accept both so
// the desk works regardless of which IDL naming the build produced.
function field<T>(obj: Record<string, unknown> | null | undefined, ...names: string[]): T | undefined {
    for (const n of names) {
        const v = obj?.[n];
        if (v !== undefined && v !== null) return v as T;
    }
    return undefined;
}

function big(v: unknown): bigint {
    if (v === undefined || v === null) return 0n;
    return BigInt(v.toString());
}

// SPL/token-2022 token account `amount` (u64 LE at offset 64).
function tokenAmount(data: Uint8Array | null): bigint | null {
    if (!data || data.length < 72) return null;
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

async function fetchConfig(): Promise<DeploymentConfig> {
    const res = await fetch(`${import.meta.env.BASE_URL}deployment.json?t=${Date.now()}`, { cache: 'no-store' });
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
    afhoMint: PublicKey;
    usdcMint: PublicKey;
    spotOracle: PublicKey;
    marketStatus: PublicKey;
    stakingPool: PublicKey;
    stakingVault: PublicKey;
    ammUsdcVault: PublicKey;
    usdcDip: PublicKey;
    usdcRewards: PublicKey;
    ammAfhoVault: PublicKey;
    cpmmPoolState: PublicKey;
    cpmmObservation: PublicKey;
    cpmmInputVault: PublicKey;
    cpmmOutputVault: PublicKey;
}

// SOL-payment path (offer_claim_sol) — only resolvable while the Raydium
// SOL/USDC pool is pinned (set-sol-usdc-pool): the claim unconditionally CPIs
// the wSOL→USDC swap, so the pool accounts must be the real pinned PDAs.
export interface SolClaimAccounts {
    solOracle: PublicKey;
    wsolVault: PublicKey;        // wSOL ATA owned by amm_state
    wrappedSolMint: PublicKey;
    solUsdcPoolState: PublicKey;
    solUsdcAmmConfig: PublicKey;
    solUsdcInputVault: PublicKey;  // pool wSOL vault
    solUsdcOutputVault: PublicKey; // pool USDC vault
    solUsdcObservation: PublicKey;
    solUsdcAuthority: PublicKey;
}

export interface OfferDeskData {
    tiers: OfferTierData[];
    livePrice: bigint | null;    // raw u64 floor units from the spot oracle
    solPrice: bigint | null;     // SOL/USD in the same floor units (usdc_raw × 1e6 / lamports)
    floorBasis: bigint;          // highest_buyback_basis ratchet floor
    afhoDecimals: number;
    usdcDecimals: number;
    marketState: number | null;  // 0 open · 1 after-hours · 2 closed · 3 halted
    tradingDay: number | null;
    sheetDay: number | null;
    deskOpen: boolean;           // state 1|2 AND tonight's sheet posted
    sheetStale: boolean;
    offersLive: boolean;         // any tier with remaining > 0
    accounts: ClaimAccounts | null;
    solAccounts: SolClaimAccounts | null;
    loading: boolean;
    error: string | null;
    updatedAt: string | null;
    refresh: () => void;
}

const AMM_PROGRAM_ID = idlProgramId(ammIdl);
const ammCoder = new BorshAccountsCoder(ammIdl as Idl);
const stakingCoder = new BorshAccountsCoder(stakingIdl as Idl);

// Native wSOL mint — the SOL payment path wraps buyer lamports into this.
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const INITIAL: Omit<OfferDeskData, 'refresh'> = {
    tiers: [],
    livePrice: null,
    solPrice: null,
    floorBasis: 0n,
    afhoDecimals: 9,
    usdcDecimals: 6,
    marketState: null,
    tradingDay: null,
    sheetDay: null,
    deskOpen: false,
    sheetStale: false,
    offersLive: false,
    accounts: null,
    solAccounts: null,
    loading: true,
    error: null,
    updatedAt: null,
};

function parseTier(key: 'sml' | 'med' | 'big', tier: number, label: string, raw: unknown): OfferTierData {
    const o = (raw ?? {}) as Record<string, unknown>;
    const lotTier = Number(field(o, 'lotSize', 'lot_size') ?? 0);
    return {
        key,
        tier,
        label,
        lotTier,
        lotTokens: lotTokens(lotTier),
        vestingDays: Number(field(o, 'vestingDays', 'vesting_days') ?? 0),
        discountBps: Number(field(o, 'discountBps', 'discount_bps') ?? 0),
        remaining: Number(field(o, 'remaining') ?? 0),
        totalOffered: Number(field(o, 'totalOffered', 'total_offered') ?? 0),
    };
}

export function useAmmData(): OfferDeskData {
    const { connection } = useConnection();
    const [data, setData] = useState<Omit<OfferDeskData, 'refresh'>>(INITIAL);
    const inflight = useRef(false);

    const load = useCallback(async () => {
        if (!connection || inflight.current) return;
        inflight.current = true;
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

            const spotOracle = pub(ammState, 'spotOracle', 'spot_oracle');
            const crankProgram = pub(ammState, 'crankProgram', 'crank_program');
            const stakingPool = pub(ammState, 'stakingPool', 'staking_pool');
            if (!spotOracle || !crankProgram || !stakingPool) {
                throw new Error('AmmState missing oracle/crank/staking addresses');
            }
            const [marketStatusPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('market_status')], crankProgram
            );

            // dependent accounts: derive every PDA up front, then fetch them
            // ALL in one batched round trip. The public devnet endpoint
            // rate-limits hard, so each 4s tick must be as few HTTP POSTs as
            // possible (this is 2 POSTs total: state+sheet, then everything).
            const solOracle = pub(ammState, 'solOracle', 'sol_oracle');
            const cpmmPoolState = pub(ammState, 'cpmmPoolState', 'cpmm_pool_state');
            const cpmmProgram = pub(ammState, 'cpmmProgram', 'cpmm_program');
            const usdcMintKey = pub(ammState, 'usdcMint', 'usdc_mint');
            const cpmmSolUsdcPool = pub(ammState, 'cpmmSolUsdcPool', 'cpmm_sol_usdc_pool');
            const cpmmSolUsdcConfig = pub(ammState, 'cpmmSolUsdcConfig', 'cpmm_sol_usdc_config');

            let afhoPoolVault: PublicKey | null = null;
            let usdcPoolVault: PublicKey | null = null;
            let solUsdcInputVault: PublicKey | null = null;
            let solUsdcOutputVault: PublicKey | null = null;
            let solUsdcObservation: PublicKey | null = null;
            let solUsdcAuthority: PublicKey | null = null;
            if (cpmmPoolState && cpmmProgram && usdcMintKey) {
                [afhoPoolVault] = PublicKey.findProgramAddressSync(
                    [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), mint.toBuffer()], cpmmProgram
                );
                [usdcPoolVault] = PublicKey.findProgramAddressSync(
                    [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), usdcMintKey.toBuffer()], cpmmProgram
                );
            }
            if (cpmmSolUsdcPool && cpmmSolUsdcConfig && cpmmProgram && usdcMintKey) {
                [solUsdcInputVault] = PublicKey.findProgramAddressSync(
                    [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), WSOL_MINT.toBuffer()], cpmmProgram
                );
                [solUsdcOutputVault] = PublicKey.findProgramAddressSync(
                    [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), usdcMintKey.toBuffer()], cpmmProgram
                );
                [solUsdcObservation] = PublicKey.findProgramAddressSync(
                    [Buffer.from('observation'), cpmmSolUsdcPool.toBuffer()], cpmmProgram
                );
                [solUsdcAuthority] = PublicKey.findProgramAddressSync(
                    [Buffer.from('vault_and_lp_mint_auth_seed')], cpmmProgram
                );
            }

            const [spotInfo, statusInfo, afhoInfo, usdcInfo, poolInfo, solInfo,
                afhoVaultInfo, usdcVaultInfo, solInInfo, solOutInfo] =
                await connection.getMultipleAccountsInfo([
                    spotOracle,
                    marketStatusPda,
                    mint,
                    usdcMintKey ?? PublicKey.default,
                    stakingPool,
                    solOracle ?? PublicKey.default,
                    afhoPoolVault ?? PublicKey.default,
                    usdcPoolVault ?? PublicKey.default,
                    solUsdcInputVault ?? PublicKey.default,
                    solUsdcOutputVault ?? PublicKey.default,
                ]);

            // Live price (floor units). Pinned AFHO/USDC pool → its vault
            // ratio (same fallback the on-chain TWAP uses while the ring
            // warms); otherwise the mock spot-oracle PDA.
            let livePrice: bigint | null = null;
            if (afhoVaultInfo && usdcVaultInfo) {
                const baseRaw = tokenAmount(afhoVaultInfo.data);
                const quoteRaw = tokenAmount(usdcVaultInfo.data);
                if (baseRaw !== null && quoteRaw !== null && baseRaw > 0n) {
                    livePrice = (quoteRaw * 1_000_000n) / baseRaw;
                }
            }
            if (livePrice === null && spotInfo && spotInfo.data.length >= 8) {
                livePrice = new DataView(spotInfo.data.buffer, spotInfo.data.byteOffset).getBigUint64(0, true);
            }

            // ── SOL payment path (offer_claim_sol) ──
            // SOL/USD floor units ((usdc_raw × 1e6) / wSOL_raw). Pinned
            // SOL/USDC pool → its vault ratio; otherwise the mock sol_oracle.
            // solAccounts only exist while the pool is pinned, because the
            // claim unconditionally CPIs the wSOL→USDC swap.
            let solPrice: bigint | null = null;
            let solAccounts: SolClaimAccounts | null = null;
            if (solInInfo && solOutInfo && solUsdcInputVault && solUsdcOutputVault &&
                solUsdcObservation && solUsdcAuthority && cpmmSolUsdcPool && cpmmSolUsdcConfig) {
                const baseRaw = tokenAmount(solInInfo.data);   // wSOL (9 dp)
                const quoteRaw = tokenAmount(solOutInfo.data); // USDC (6 dp)
                if (baseRaw !== null && quoteRaw !== null && baseRaw > 0n) {
                    solPrice = (quoteRaw * 1_000_000n) / baseRaw;
                }
                solAccounts = {
                    solOracle: solOracle ?? PublicKey.default,
                    wsolVault: getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true, TOKEN_PROGRAM_ID),
                    wrappedSolMint: WSOL_MINT,
                    solUsdcPoolState: cpmmSolUsdcPool,
                    solUsdcAmmConfig: cpmmSolUsdcConfig,
                    solUsdcInputVault,
                    solUsdcOutputVault,
                    solUsdcObservation,
                    solUsdcAuthority,
                };
            } else if (solInfo && solInfo.data.length >= 8) {
                solPrice = new DataView(solInfo.data.buffer, solInfo.data.byteOffset).getBigUint64(0, true);
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
            const afhoDecimals = afhoInfo && afhoInfo.data.length > 44 ? afhoInfo.data[44] : 9;
            const usdcDecimals = usdcInfo && usdcInfo.data.length > 44 ? usdcInfo.data[44] : 6;

            const pool = poolInfo ? decode(stakingCoder, 'StakePool', poolInfo.data) : null;
            const stakingVault = pub(pool, 'vault') ?? pk(config.vault);

            const tiers = offerList
                ? [
                    parseTier('big', 2, 'Bulk lot', field(offerList, 'bigOffer', 'big_offer')),
                    parseTier('med', 1, 'Medium lot', field(offerList, 'medOffer', 'med_offer')),
                    parseTier('sml', 0, 'Small lot', field(offerList, 'smlOffer', 'sml_offer')),
                ]
                : [];

            const sheetDay = offerList ? Number(big(field(offerList, 'dayIndex', 'day_index'))) : null;
            const offersLive = tiers.some((t) => t.remaining > 0);
            const nightGate = marketState === 1 || marketState === 2;
            const sheetStale = sheetDay !== null && tradingDay !== null && sheetDay !== tradingDay;
            const deskOpen = nightGate && offersLive && !sheetStale;

            const usdcMint = pub(ammState, 'usdcMint', 'usdc_mint');
            const usdcVault = pub(ammState, 'usdcVault', 'usdc_vault');
            const usdcDip = pub(ammState, 'usdcDip', 'usdc_dip');
            const usdcRewards = pub(ammState, 'usdcRewards', 'usdc_rewards');
            const afhoVault = pub(ammState, 'afhoVault', 'afho_vault');

            // CPMM AFHO/USDC pool accounts for the claim's live-price read.
            let cpmmObservation: PublicKey | null = null;
            let cpmmInputVault: PublicKey | null = null;
            let cpmmOutputVault: PublicKey | null = null;
            if (cpmmPoolState && cpmmProgram && usdcMint) {
                [cpmmObservation] = PublicKey.findProgramAddressSync(
                    [Buffer.from('observation'), cpmmPoolState.toBuffer()], cpmmProgram
                );
                [cpmmInputVault] = PublicKey.findProgramAddressSync(
                    [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), usdcMint.toBuffer()], cpmmProgram
                );
                [cpmmOutputVault] = PublicKey.findProgramAddressSync(
                    [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), mint.toBuffer()], cpmmProgram
                );
            }

            const accounts: ClaimAccounts | null =
                usdcMint && usdcVault && usdcDip && usdcRewards && afhoVault && stakingVault &&
                cpmmPoolState && cpmmObservation && cpmmInputVault && cpmmOutputVault
                    ? {
                        ammState: ammStatePda,
                        offerList: offerListPda,
                        afhoMint: mint,
                        usdcMint,
                        spotOracle,
                        marketStatus: marketStatusPda,
                        stakingPool,
                        stakingVault,
                        ammUsdcVault: usdcVault,
                        usdcDip,
                        usdcRewards,
                        ammAfhoVault: afhoVault,
                        cpmmPoolState,
                        cpmmObservation,
                        cpmmInputVault,
                        cpmmOutputVault,
                    }
                    : null;

            setData({
                tiers,
                livePrice,
                solPrice,
                floorBasis: big(field(ammState, 'highestBuybackBasis', 'highest_buyback_basis')),
                afhoDecimals,
                usdcDecimals,
                marketState,
                tradingDay,
                sheetDay,
                deskOpen,
                sheetStale,
                offersLive,
                accounts,
                solAccounts,
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
        } finally {
            inflight.current = false;
        }
    }, [connection]);

    useEffect(() => {
        let cancelled = false;
        const subscriptions: number[] = [];

        async function setup() {
            if (!connection) return;
            const config = await fetchConfig();
            if (cancelled) return;
            const mint = pk(config.mint);
            const ammProgram = pk(config.ammProgram) ?? AMM_PROGRAM_ID;
            const crankProgram = pk(config.crankProgram);
            if (!mint) return;

            const [ammStatePda] = PublicKey.findProgramAddressSync(
                [Buffer.from('amm_state'), mint.toBuffer()], ammProgram,
            );
            const [offerListPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('offer_list'), mint.toBuffer()], ammProgram,
            );

            const watch: PublicKey[] = [ammStatePda, offerListPda];
            if (crankProgram) {
                const [marketStatusPda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('market_status')], crankProgram,
                );
                watch.push(marketStatusPda);
            }

            // Live price source (mock spot-oracle PDA while the CPMM pool is
            // unpinned) — resolve once so the desk also refreshes on price.
            try {
                const info = await connection.getAccountInfo(ammStatePda, 'confirmed');
                const ammState = info ? decode(ammCoder, 'AmmState', info.data) : null;
                const spotOracle = pub(ammState, 'spotOracle', 'spot_oracle');
                if (spotOracle) watch.push(spotOracle);
                const solOracle = pub(ammState, 'solOracle', 'sol_oracle');
                if (solOracle) watch.push(solOracle);
            } catch {
                // amm_state not initialized yet — offerList/marketStatus watches
                // still fire once the accounts come into existence.
            }

            for (const key of watch) {
                subscriptions.push(
                    connection.onAccountChange(
                        key,
                        () => {
                            void load();
                        },
                        'confirmed',
                    ),
                );
            }

            void load();
        }

        void setup();

        // Live-price tick: the CPMM pool vaults (the real price source) aren't
        // in the watch set, so poll every 4s to keep per-lot prices and the
        // order total tracking the live pool. load() is idempotent and
        // in-flight-guarded; the account-change listeners above still fire for
        // instant sheet/state updates. Skipped while the tab is hidden to
        // spare the (rate-limited) devnet RPC.
        const interval = window.setInterval(() => {
            if (document.hidden) return;
            void load();
        }, 4000);

        return () => {
            cancelled = true;
            window.clearInterval(interval);
            for (const id of subscriptions) {
                void connection.removeAccountChangeListener(id);
            }
        };
    }, [connection, load]);

    return { ...data, refresh: load };
}
