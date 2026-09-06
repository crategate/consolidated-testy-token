// Pure offer-desk math — mirrors programs/amm/src/state/offersState.rs
// (lot_sizer) and programs/amm/src/instructions/offer_claim.rs (quote_claim).
// All integer math is BigInt so the estimate tracks the on-chain u64/u128
// arithmetic exactly; the UI still labels the result "approximate" because
// the live price can move between quote and claim.

// Port of lot_sizer(): offer.lot_size is a TIER INDEX, not a token amount.
export const LOT_SIZES: readonly number[] = [
    0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000, 15000,
    20000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000,
    10000000,
];

export function lotTokens(lotTier: number): number {
    return LOT_SIZES[lotTier] ?? 0;
}

// Price units (both the spot oracle and the ratchet floor):
//   (usdc_raw × 1e12) / afho_raw   — "floor units" = price per whole token
//   × 1e9 (nano-dollar). Represents sub-cent launch prices ($5.2e-6 → 5,200).
// discount_bps is stored in tenths of a percent (115 = 11.5%) → ×10 = bps.
export function effectivePrice(livePrice: bigint, discountTenths: number, floor: bigint): bigint {
    const bps = BigInt(discountTenths) * 10n;
    const discounted = livePrice - (livePrice * bps) / 10_000n;
    return discounted > floor ? discounted : floor;
}

export function ratchetActive(livePrice: bigint, discountTenths: number, floor: bigint): boolean {
    const bps = BigInt(discountTenths) * 10n;
    const discounted = livePrice - (livePrice * bps) / 10_000n;
    return floor > discounted;
}

// Cost in raw USDC for `units` lots — mirrors quote_claim:
//   total_raw = lot_tokens × units × 10^afho_decimals
//   cost_usdc = total_raw × effective_price / 1e12
// (floor units = price-per-token × 1e9, afho 9 dec → total_raw × price ×
// 1e9 × 1e9 / 1e12 = tokens × price × 1e6 = USDC raw for the 6/9-dec pair)
export function quoteCostRaw(
    livePrice: bigint,
    discountTenths: number,
    floor: bigint,
    lotTier: number,
    units: number,
    afhoDecimals: number,
): bigint {
    if (units <= 0 || livePrice <= 0n) return 0n;
    const unit = 10n ** BigInt(afhoDecimals);
    const totalRaw = BigInt(lotTokens(lotTier)) * BigInt(units) * unit;
    return (totalRaw * effectivePrice(livePrice, discountTenths, floor)) / 1_000_000_000_000n;
}

export function formatUsdc(raw: bigint, usdcDecimals = 6): string {
    const unit = 10n ** BigInt(usdcDecimals);
    const whole = raw / unit;
    const frac = (raw % unit).toString().padStart(usdcDecimals, '0').slice(0, 2);
    return `${whole.toLocaleString('en-US')}.${frac}`;
}

// Price of one whole AFHO in USDC, from floor units. Floor units are
// price-per-token × 1e9 (nano-dollar) by construction —
// (usdc_raw × 1e12) / afho_raw for the 6/9-dec pair — so the conversion to
// a whole-token USDC price is always /1e9, independent of mint decimals.
// (The pre-e9 formula `×10^(afho−9−usdc)` landed on /1e6 for the 9/6 pair
// and printed per-lot + live prices 1000× high; quoteCostRaw was correct,
// so the tile disagreed with the cart total by exactly 1000×.)
export function pricePerToken(floorUnits: bigint): number {
    if (floorUnits <= 0n) return 0;
    return Number(floorUnits) / 1e9;
}

export function formatTokens(n: number): string {
    return n.toLocaleString('en-US');
}

// ── SOL payment path (offer_claim_sol) ───────────────────────────────────
// sol_price uses the same floor-unit convention as the AFHO spot oracle:
//   (usdc_raw × 1e12) / lamports
// The buyer covers the CPMM 0.25% input fee on the wSOL→USDC swap, so the
// on-chain lamports charge mirrors:
//   lamports = cost_usdc × 1e12 × 10_025 / sol_price / 10_000
// (the pool nets the protocol the full USDC cost; min-out tolerates 2%).
export function lamportsForCost(costUsdcRaw: bigint, solPrice: bigint): bigint {
    if (costUsdcRaw <= 0n || solPrice <= 0n) return 0n;
    return (costUsdcRaw * 1_000_000_000_000n * 10_025n) / solPrice / 10_000n;
}

// The pinned SOL/USDC amm_config's input-leg trade fee — mirror of
// SOL_POOL_TRADE_FEE_BPS in programs/amm/src/instructions/offer_claim.rs.
export const SOL_POOL_TRADE_FEE_BPS = 25;

// Exact port of programs/amm raydium::cpmm_swap_input_for_out: the gross
// swap_base_input input (including the pool's fee_bps input-leg fee) whose
// constant-product output nets at least min_out against reserves
// (r_in, r_out). Same ceil-the-net / floor-the-gross integer shape as the
// on-chain u128 math, so with unchanged reserves the estimate IS the charge.
// Returns null when the pool cannot serve min_out — the same condition that
// reverts the claim on-chain (InsufficientPoolLiquidity, min_out ≥ r_out).
export function cpmmInputForOut(
    rIn: bigint,
    rOut: bigint,
    minOut: bigint,
    feeBps: number,
): bigint | null {
    if (rIn <= 0n || rOut <= 0n || minOut <= 0n || minOut >= rOut || feeBps >= 10_000) {
        return null;
    }
    const num = minOut * rIn;
    const den = rOut - minOut; // > 0 by the guard above
    const netReq = (num + den - 1n) / den; // ceil(num/den)
    const gross = (netReq * 10_000n) / (10_000n - BigInt(feeBps)); // floor, like on-chain
    return gross > 0n ? gross : null;
}

// lamportsForCost against the pool's LIVE vault balances instead of its
// spot ratio: what offer_claim_sol will actually charge — the on-chain
// solve reads the same raw vault amounts. (Raydium's own curve trades
// against vault-minus-fee-ledger reserves, so the vault-based charge is
// mildly conservative when fees have accrued; the buyer never underpays.)
// Null/unknown reserves → null (caller falls back to the spot estimate); a
// null result with known reserves means the pool can't serve the order.
export function lamportsForCostExact(
    costUsdcRaw: bigint,
    reserves: { wsolRaw: bigint; usdcRaw: bigint } | null | undefined,
): bigint | null {
    if (!reserves || costUsdcRaw <= 0n) return null;
    return cpmmInputForOut(reserves.wsolRaw, reserves.usdcRaw, costUsdcRaw, SOL_POOL_TRADE_FEE_BPS);
}

// Lamports → human SOL, up to 6 decimal places (trailing zeros trimmed).
// Six digits matter on the desk: at devnet prices a lot can cost well under
// 0.001 SOL, and the old 4dp truncation read 0.00037 as "0.0003".
export function formatSol(lamports: bigint): string {
    const unit = 1_000_000_000n;
    const whole = lamports / unit;
    const frac6 = (lamports % unit) / 1_000n;
    const frac = frac6.toString().padStart(6, '0').replace(/0+$/, '');
    return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
}
