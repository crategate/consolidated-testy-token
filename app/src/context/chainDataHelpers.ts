import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import {
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import ammIdl from '../../../target/idl/amm.json';
import crankIdl from '../../../target/idl/crank_oracle.json';
import stakingIdl from '../../../target/idl/staking.json';
import { resolveDeployment, type ResolvedDeployment } from '../config';
import { STAKING_PROGRAM_ID } from '../anchor/setup';

/* ── IDL / coder helpers ── */

function idlProgramId(idl: unknown): PublicKey {
    const meta = idl as { metadata?: { address?: string }; address?: string };
    const address = meta.metadata?.address ?? meta.address;
    if (!address) throw new Error('IDL missing program address');
    return new PublicKey(address);
}

export const AMM_PROGRAM_ID = idlProgramId(ammIdl);
export const CRANK_PROGRAM_ID = idlProgramId(crankIdl);

const ammCoder = new BorshAccountsCoder(ammIdl as Idl);
const stakingCoder = new BorshAccountsCoder(stakingIdl as Idl);

export function field<T>(obj: unknown, ...names: string[]): T | undefined {
    const record = obj as Record<string, unknown> | null | undefined;
    for (const n of names) {
        const v = record?.[n];
        if (v !== undefined && v !== null) return v as T;
    }
    return undefined;
}

export function pub(obj: unknown, ...names: string[]): PublicKey | null {
    const v = field(obj, ...names);
    return v instanceof PublicKey ? v : null;
}

export function big(v: unknown): bigint {
    if (v === undefined || v === null) return 0n;
    return BigInt(v.toString());
}

function decode<T>(coder: BorshAccountsCoder, name: string, data: Uint8Array): T | null {
    try {
        return coder.decode(name, Buffer.from(data)) as T;
    } catch {
        return null;
    }
}

/* ── Deployment ── */

export async function fetchDeployment(): Promise<ResolvedDeployment | null> {
    try {
        const response = await fetch(`${import.meta.env.BASE_URL}deployment.json`, {
            cache: 'no-store',
        });
        const config = response.ok ? await response.json() : {};
        return resolveDeployment(config);
    } catch {
        return null;
    }
}

/* ── PDAs ── */

export function deriveMarketStatusPda(crankProgram: PublicKey) {
    return PublicKey.findProgramAddressSync([Buffer.from('market_status')], crankProgram)[0];
}

export function deriveAmmStatePda(mint: PublicKey, ammProgram = AMM_PROGRAM_ID) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('amm_state'), mint.toBuffer()],
        ammProgram,
    )[0];
}

export function deriveOfferListPda(mint: PublicKey, ammProgram = AMM_PROGRAM_ID) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('offer_list'), mint.toBuffer()],
        ammProgram,
    )[0];
}

export function derivePoolPda(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('pool'), mint.toBuffer()],
        STAKING_PROGRAM_ID,
    )[0];
}

export function deriveUserIndexPda(owner: PublicKey) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('user_index'), owner.toBuffer()],
        STAKING_PROGRAM_ID,
    )[0];
}

export function derivePositionPda(poolPda: PublicKey, owner: PublicKey, index: number | bigint) {
    const indexBytes =
        typeof index === 'number'
            ? new Uint8Array(new BigUint64Array([BigInt(index)]).buffer)
            : new Uint8Array(new BigUint64Array([index]).buffer);
    return PublicKey.findProgramAddressSync(
        [Buffer.from('position'), poolPda.toBuffer(), owner.toBuffer(), Buffer.from(indexBytes)],
        STAKING_PROGRAM_ID,
    )[0];
}

/* ── Decoded types ── */

export interface MarketStatusData {
    state: number;
    timestamp: number;
    tradingDay: number;
}

export interface StakePoolData {
    totalStaked: { toString(): string };
    maxMultiplierBps: number;
    posrTaxBps: number;
    afterHoursPenaltyBps: number;
    closedPenaltyBps: number;
    haltedPenaltyBps: number;
    accruedRewardPerShare: { toString(): string };
    vault?: PublicKey;
    [key: string]: unknown;
}

export interface OfferTierRaw {
    lotSize?: number;
    lot_size?: number;
    vestingDays?: number;
    vesting_days?: number;
    discountBps?: number;
    discount_bps?: number;
    remaining?: number;
    totalOffered?: number;
    total_offered?: number;
}

export interface OfferListData {
    dayIndex?: number;
    day_index?: number;
    bigOffer?: OfferTierRaw;
    big_offer?: OfferTierRaw;
    medOffer?: OfferTierRaw;
    med_offer?: OfferTierRaw;
    smlOffer?: OfferTierRaw;
    sml_offer?: OfferTierRaw;
    totalComplete?: number;
    total_complete?: number;
}

export interface AmmStateData {
    highestBuybackBasis?: number | bigint;
    highest_buyback_basis?: number | bigint;
    spotOracle?: PublicKey;
    spot_oracle?: PublicKey;
    solOracle?: PublicKey;
    sol_oracle?: PublicKey;
    crankProgram?: PublicKey;
    crank_program?: PublicKey;
    stakingPool?: PublicKey;
    staking_pool?: PublicKey;
    cpmmPoolState?: PublicKey;
    cpmm_pool_state?: PublicKey;
    cpmmProgram?: PublicKey;
    cpmm_program?: PublicKey;
    usdcMint?: PublicKey;
    usdc_mint?: PublicKey;
    cpmmSolUsdcPool?: PublicKey;
    cpmm_sol_usdc_pool?: PublicKey;
    cpmmSolUsdcConfig?: PublicKey;
    cpmm_sol_usdc_config?: PublicKey;
    usdcVault?: PublicKey;
    usdc_vault?: PublicKey;
    usdcDip?: PublicKey;
    usdc_dip?: PublicKey;
    usdcRewards?: PublicKey;
    usdc_rewards?: PublicKey;
    afhoVault?: PublicKey;
    afho_vault?: PublicKey;
}

/* ── Decoders ── */

export function decodeMarketStatus(data: Uint8Array): MarketStatusData | null {
    // Always use the raw layout: the IDL emits snake_case field names, but
    // consumers expect camelCase. Layout is disc(8) + state(1) + timestamp(8) + day(8).
    if (data.length < 25) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
        state: view.getUint8(8),
        timestamp: Number(view.getBigInt64(9, true)),
        tradingDay: Number(view.getBigUint64(17, true)),
    };
}

export function decodePool(data: Uint8Array): StakePoolData | null {
    // The raw BorshAccountsCoder decodes the IDL's snake_case field names
    // (accrued_reward_per_share, ...). Consumers expect the camelCase shapes
    // the old `program.account.stakePool.fetch` path produced (Anchor's
    // Program constructor camelCases the IDL before building its coders).
    // The pool account is flat (Pubkeys / BNs / ints), so a top-level key
    // map is sufficient — values are never recursed into, so PublicKey and
    // BN instances stay intact.
    const raw = decode<Record<string, unknown>>(stakingCoder, 'StakePool', data);
    if (!raw) return null;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
    }
    return out as StakePoolData;
}

export interface StakePositionData {
    amount: { toString(): string };
    entryTradingDay: { toString(): string };
    lastClaimTimestamp: { toString(): string };
    daysToUnlock?: number;
    currentWeight?: { toString(): string };
    rewardDebt?: { toString(): string };
}

export function decodeStakePosition(data: Uint8Array): StakePositionData | null {
    const raw = decode<Record<string, unknown>>(stakingCoder, 'StakePosition', data);
    if (!raw) return null;
    const amount = field<{ toString(): string }>(raw, 'amount');
    const entryTradingDay = field<{ toString(): string }>(raw, 'entryTradingDay', 'entry_trading_day');
    const lastClaimTimestamp = field<{ toString(): string }>(raw, 'lastClaimTimestamp', 'last_claim_timestamp');
    if (!amount || !entryTradingDay || !lastClaimTimestamp) return null;
    return {
        amount,
        entryTradingDay,
        lastClaimTimestamp,
        daysToUnlock: field<number>(raw, 'daysToUnlock', 'days_to_unlock'),
        currentWeight: field<{ toString(): string }>(raw, 'currentWeight', 'current_weight'),
        rewardDebt: field<{ toString(): string }>(raw, 'rewardDebt', 'reward_debt'),
    };
}

export function decodeAmmState(data: Uint8Array): AmmStateData | null {
    return decode<AmmStateData>(ammCoder, 'AmmState', data);
}

export function decodeOfferList(data: Uint8Array): OfferListData | null {
    return decode<OfferListData>(ammCoder, 'OfferList', data);
}

/* ── Live price helpers ── */

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

function tokenAmount(data: Uint8Array | null): bigint | null {
    if (!data || data.length < 72) return null;
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

export interface LivePriceData {
    afhoUsdc: bigint | null;
    solUsdc: bigint | null;
}

/**
 * The accounts needed to compute both legs of the live price, in fixed order:
 * [afhoPoolVault, usdcPoolVault, solUsdcInputVault, solUsdcOutputVault,
 *  spotOracle, solOracle].
 *
 * Unpinned pools are PublicKey.default placeholders (the RPC answers null for
 * them), so one getMultipleAccountsInfo covers the entire price read with no
 * fallback round-trips.
 */
export function derivePriceAccounts(ammState: AmmStateData, mint: PublicKey): PublicKey[] {
    const cpmmPoolState = pub(ammState, 'cpmmPoolState', 'cpmm_pool_state');
    const cpmmProgram = pub(ammState, 'cpmmProgram', 'cpmm_program');
    const usdcMint = pub(ammState, 'usdcMint', 'usdc_mint');
    const cpmmSolUsdcPool = pub(ammState, 'cpmmSolUsdcPool', 'cpmm_sol_usdc_pool');

    let afhoPoolVault: PublicKey | null = null;
    let usdcPoolVault: PublicKey | null = null;
    let solUsdcInputVault: PublicKey | null = null;
    let solUsdcOutputVault: PublicKey | null = null;

    if (cpmmPoolState && cpmmProgram && usdcMint) {
        [afhoPoolVault] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), mint.toBuffer()],
            cpmmProgram,
        );
        [usdcPoolVault] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), usdcMint.toBuffer()],
            cpmmProgram,
        );
    }

    if (cpmmSolUsdcPool && cpmmProgram && usdcMint) {
        [solUsdcInputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), WSOL_MINT.toBuffer()],
            cpmmProgram,
        );
        [solUsdcOutputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), usdcMint.toBuffer()],
            cpmmProgram,
        );
    }

    return [
        afhoPoolVault ?? PublicKey.default,
        usdcPoolVault ?? PublicKey.default,
        solUsdcInputVault ?? PublicKey.default,
        solUsdcOutputVault ?? PublicKey.default,
        pub(ammState, 'spotOracle', 'spot_oracle') ?? PublicKey.default,
        pub(ammState, 'solOracle', 'sol_oracle') ?? PublicKey.default,
    ];
}

/**
 * Pure math over the six account infos returned for derivePriceAccounts'
 * keys, in the same order. The spot/sol oracle slots are the same u64-LE
 * price fallbacks the previous two-call fetch used.
 */
export function computeLivePrice(infos: Array<{ data: Uint8Array } | null>): LivePriceData {
    const [afhoVaultInfo, usdcVaultInfo, solInInfo, solOutInfo, rawSpotInfo, solOracleInfo] = infos;

    let afhoUsdc: bigint | null = null;
    const baseRaw = tokenAmount(afhoVaultInfo?.data ?? null);
    const quoteRaw = tokenAmount(usdcVaultInfo?.data ?? null);
    if (baseRaw !== null && quoteRaw !== null && baseRaw > 0n) {
        afhoUsdc = (quoteRaw * 1_000_000_000_000n) / baseRaw;
    }
    if (afhoUsdc === null && rawSpotInfo && rawSpotInfo.data.length >= 8) {
        afhoUsdc = new DataView(rawSpotInfo.data.buffer, rawSpotInfo.data.byteOffset).getBigUint64(
            0,
            true,
        );
    }

    let solUsdc: bigint | null = null;
    const solBase = tokenAmount(solInInfo?.data ?? null);
    const solQuote = tokenAmount(solOutInfo?.data ?? null);
    if (solBase !== null && solQuote !== null && solBase > 0n) {
        solUsdc = (solQuote * 1_000_000_000_000n) / solBase;
    }
    if (solUsdc === null && solOracleInfo && solOracleInfo.data.length >= 8) {
        solUsdc = new DataView(solOracleInfo.data.buffer, solOracleInfo.data.byteOffset).getBigUint64(
            0,
            true,
        );
    }

    return { afhoUsdc, solUsdc };
}

/* ── wSOL ATA helper for SOL claim path ── */

export function deriveWsolVault(ammStatePda: PublicKey) {
    return getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true, TOKEN_PROGRAM_ID);
}

/* ── Generic retry/backoff helper ── */

export function isRateLimitError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /429|rate.?limit|too many requests/i.test(msg);
}

export async function withBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isRateLimitError(err) || i === maxRetries) throw err;
            const delay = Math.min(1000 * 2 ** i, 30000);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
