import { useCallback, useMemo } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { STAKING_PROGRAM_ID } from '../../anchor/setup';
import { useChainData } from '../../context/useChainData';
import {
    AMM_PROGRAM_ID,
    big,
    deriveAmmStatePda,
    deriveOfferListPda,
    field,
    pub,
    type AmmStateData,
} from '../../context/chainDataHelpers';
import { lotTokens } from './offerMath.ts';

/* ── types ── */

export interface OfferTierData {
    key: 'sml' | 'med' | 'big';
    tier: number;
    label: string;
    lotTier: number;
    lotTokens: number;
    vestingDays: number;
    discountBps: number;
    remaining: number;
    totalOffered: number;
}

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

export interface SolClaimAccounts {
    // Raydium CPMM program. offer_claim_sol CPIs the wSOL→USDC swap into it,
    // and the runtime requires the callee program id to be among the caller
    // instruction's accounts — the client passes it as a remaining account.
    cpmmProgram: PublicKey;
    solOracle: PublicKey;
    wsolVault: PublicKey;
    wrappedSolMint: PublicKey;
    solUsdcPoolState: PublicKey;
    solUsdcAmmConfig: PublicKey;
    solUsdcInputVault: PublicKey;
    solUsdcOutputVault: PublicKey;
    solUsdcObservation: PublicKey;
    solUsdcAuthority: PublicKey;
}

export interface OfferDeskData {
    tiers: OfferTierData[];
    livePrice: bigint | null;
    solPrice: bigint | null;
    floorBasis: bigint;
    afhoDecimals: number;
    usdcDecimals: number;
    marketState: number | null;
    tradingDay: number | null;
    sheetDay: number | null;
    deskOpen: boolean;
    sheetStale: boolean;
    offersLive: boolean;
    accounts: ClaimAccounts | null;
    solAccounts: SolClaimAccounts | null;
    loading: boolean;
    error: string | null;
    updatedAt: string | null;
    refresh: () => void;
}

/* ── helpers ── */

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

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

function deriveClaimAccounts(
    ammState: AmmStateData,
    ammStatePda: PublicKey,
    offerListPda: PublicKey,
    marketStatusPda: PublicKey,
    mint: PublicKey,
): ClaimAccounts | null {
    const usdcMint = pub(ammState, 'usdcMint', 'usdc_mint');
    const usdcVault = pub(ammState, 'usdcVault', 'usdc_vault');
    const usdcDip = pub(ammState, 'usdcDip', 'usdc_dip');
    const usdcRewards = pub(ammState, 'usdcRewards', 'usdc_rewards');
    const afhoVault = pub(ammState, 'afhoVault', 'afho_vault');
    const spotOracle = pub(ammState, 'spotOracle', 'spot_oracle');
    const stakingPool = pub(ammState, 'stakingPool', 'staking_pool');
    const cpmmPoolState = pub(ammState, 'cpmmPoolState', 'cpmm_pool_state');
    const cpmmProgram = pub(ammState, 'cpmmProgram', 'cpmm_program');

    if (
        !usdcMint ||
        !usdcVault ||
        !usdcDip ||
        !usdcRewards ||
        !afhoVault ||
        !spotOracle ||
        !stakingPool ||
        !cpmmPoolState ||
        !cpmmProgram
    ) {
        return null;
    }

    const [stakingVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault'), stakingPool.toBuffer()],
        STAKING_PROGRAM_ID,
    );
    const [cpmmObservation] = PublicKey.findProgramAddressSync(
        [Buffer.from('observation'), cpmmPoolState.toBuffer()],
        cpmmProgram,
    );
    const [cpmmInputVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), usdcMint.toBuffer()],
        cpmmProgram,
    );
    const [cpmmOutputVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), mint.toBuffer()],
        cpmmProgram,
    );

    return {
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
    };
}

function deriveSolClaimAccounts(
    ammState: AmmStateData,
    ammStatePda: PublicKey,
): SolClaimAccounts | null {
    const solOracle = pub(ammState, 'solOracle', 'sol_oracle');
    const cpmmSolUsdcPool = pub(ammState, 'cpmmSolUsdcPool', 'cpmm_sol_usdc_pool');
    const cpmmSolUsdcConfig = pub(ammState, 'cpmmSolUsdcConfig', 'cpmm_sol_usdc_config');
    const cpmmProgram = pub(ammState, 'cpmmProgram', 'cpmm_program');
    const usdcMint = pub(ammState, 'usdcMint', 'usdc_mint');

    if (!solOracle || !cpmmSolUsdcPool || !cpmmSolUsdcConfig || !cpmmProgram || !usdcMint) {
        return null;
    }

    const wsolVault = getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true, TOKEN_PROGRAM_ID);

    const [solUsdcInputVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), WSOL_MINT.toBuffer()],
        cpmmProgram,
    );
    const [solUsdcOutputVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), usdcMint.toBuffer()],
        cpmmProgram,
    );
    const [solUsdcObservation] = PublicKey.findProgramAddressSync(
        [Buffer.from('observation'), cpmmSolUsdcPool.toBuffer()],
        cpmmProgram,
    );
    const [solUsdcAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault_and_lp_mint_auth_seed')],
        cpmmProgram,
    );

    return {
        cpmmProgram,
        solOracle,
        wsolVault,
        wrappedSolMint: WSOL_MINT,
        solUsdcPoolState: cpmmSolUsdcPool,
        solUsdcAmmConfig: cpmmSolUsdcConfig,
        solUsdcInputVault,
        solUsdcOutputVault,
        solUsdcObservation,
        solUsdcAuthority,
    };
}

function decimalsFromAccountInfo(info: { data: Uint8Array } | null | undefined): number | null {
    if (!info || info.data.length <= 44) return null;
    return info.data[44];
}

/* ── hook ── */

export function useAmmData(): OfferDeskData {
    const { connection } = useConnection();
    const {
        deployment,
        ammState,
        offerList,
        marketStatus,
        livePrice,
        refresh,
    } = useChainData();

    const ammProgram = deployment?.ammProgram
        ? new PublicKey(deployment.ammProgram)
        : AMM_PROGRAM_ID;

    const mint = deployment?.mintKey;
    const ammStatePda = mint ? deriveAmmStatePda(mint, ammProgram) : null;
    const offerListPda = mint ? deriveOfferListPda(mint, ammProgram) : null;
    const marketStatusPda = deployment?.marketStatusKey ?? null;

    // Fetch static mint decimals once per session. Everything else is derived
    // from the shared ChainData context, so this hook makes 0–2 RPC calls
    // total instead of 2+ calls every 4 seconds.
    const decimalsQuery = useQuery({
        queryKey: ['ammDecimals', mint?.toBase58() ?? ''],
        queryFn: async () => {
            if (!mint) throw new Error('Mint unknown');
            const info = await connection.getAccountInfo(mint, 'confirmed');
            return {
                afho: decimalsFromAccountInfo(info) ?? 9,
                usdc: 6, // devnet USDC is always 6 dp
            };
        },
        enabled: !!mint,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    });

    const decimals = decimalsQuery.data ?? { afho: 9, usdc: 6 };

    const { tiers, sheetDay, offersLive } = useMemo(() => {
        if (!offerList) return { tiers: [], sheetDay: null, offersLive: false };
        const list = [
            parseTier('big', 2, 'Bulk lot', field(offerList, 'bigOffer', 'big_offer')),
            parseTier('med', 1, 'Medium lot', field(offerList, 'medOffer', 'med_offer')),
            parseTier('sml', 0, 'Small lot', field(offerList, 'smlOffer', 'sml_offer')),
        ];
        const day = offerList ? Number(big(field(offerList, 'dayIndex', 'day_index'))) : null;
        const live = list.some((t) => t.remaining > 0);
        return { tiers: list, sheetDay: day, offersLive: live };
    }, [offerList]);

    const marketState = marketStatus?.state ?? null;
    const tradingDay = marketStatus?.tradingDay ?? null;
    const nightGate = marketState === 1 || marketState === 2;
    const sheetStale = sheetDay !== null && tradingDay !== null && sheetDay !== tradingDay;
    const deskOpen = nightGate && offersLive && !sheetStale;

    const accounts = useMemo(() => {
        if (!ammState || !ammStatePda || !offerListPda || !marketStatusPda || !mint) return null;
        return deriveClaimAccounts(ammState, ammStatePda, offerListPda, marketStatusPda, mint);
    }, [ammState, ammStatePda, offerListPda, marketStatusPda, mint]);

    const solAccounts = useMemo(() => {
        if (!ammState || !ammStatePda) return null;
        return deriveSolClaimAccounts(ammState, ammStatePda);
    }, [ammState, ammStatePda]);

    const doRefresh = useCallback(() => {
        void refresh('amm');
    }, [refresh]);

    const loading =
        !deployment ||
        !marketStatus ||
        !ammState ||
        decimalsQuery.isLoading;

    const error =
        (!deployment && 'Deployment not loaded') ||
        (!ammState && 'AMM state not found — run anchor run amm-init') ||
        (decimalsQuery.error instanceof Error ? decimalsQuery.error.message : null);

    return {
        tiers,
        livePrice: livePrice.afhoUsdc,
        solPrice: livePrice.solUsdc,
        floorBasis: ammState ? big(field(ammState, 'highestBuybackBasis', 'highest_buyback_basis')) : 0n,
        afhoDecimals: decimals.afho,
        usdcDecimals: decimals.usdc,
        marketState,
        tradingDay,
        sheetDay,
        deskOpen,
        sheetStale,
        offersLive,
        accounts,
        solAccounts,
        loading,
        error,
        updatedAt: new Date().toISOString(),
        refresh: doRefresh,
    };
}
