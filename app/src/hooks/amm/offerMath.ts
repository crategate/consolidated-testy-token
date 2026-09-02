// Pure offer-desk math — mirrors programs/amm/src/state/offersState.rs
// (lot_sizer) and programs/amm/src/instructions/offer_claim.rs (quote_claim).
// All integer math is BigInt so the estimate tracks the on-chain u64/u128
// arithmetic exactly; the UI still labels the result "approximate" because
// the live price can move between quote and claim.

// Port of lot_sizer(): offer.lot_size is a TIER INDEX, not a token amount.
export const LOT_SIZES: readonly number[] = [
    0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000, 15000,
    20000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000,
    10000000, 25000000, 50000000, 100000000,
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
//   cost_usdc = total_raw × effective_price / 1e6
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

// Price of one whole AFHO in USDC, from floor units (price × 1e9).
export function pricePerToken(floorUnits: bigint, afhoDecimals: number, usdcDecimals = 6): number {
    if (floorUnits <= 0n) return 0;
    return Number(floorUnits) * 10 ** (afhoDecimals - 9 - usdcDecimals);
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

// Lamports → human SOL, up to 4 decimal places (trailing zeros trimmed).
export function formatSol(lamports: bigint): string {
    const unit = 1_000_000_000n;
    const whole = lamports / unit;
    const frac4 = (lamports % unit) / 100_000n;
    const frac = frac4.toString().padStart(4, '0').replace(/0+$/, '');
    return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
}
