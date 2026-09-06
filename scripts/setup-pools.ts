import { setCpmmPool } from "./set-cpmm-pool";
import { setSolUsdcPool } from "./set-sol-usdc-pool";
import { ensureClaimAlt } from "./create-claim-alt";

// One-shot pool setup, run after `amm-init` (and after any `anchor deploy`
// that lands on a fresh amm_state — pool pins live IN AmmState and a fresh
// state has none). Replaces the three-step sequence:
//   anchor run set-cpmm-pool
//   anchor run set-sol-usdc-pool
//   anchor run create-claim-alt
//
// Order matters: both pins write into AmmState, and the lookup table is
// derived FROM the pinned pools — run last, so a newly pinned (differently
// addressed) pool gets its keys extended into the table.
//
// Notes:
//  - Individual scripts still work standalone for partial re-runs.
//  - Idempotent: re-pinning the same pools is a no-op at the ALT (its key
//    set only grows when an address actually changes).
//  - Env vars pass through: SOL_USDC_SEED_SOL / SOL_USDC_SEED_USDC size the
//    devnet fallback pool; DEVNET_SOL_USDC_POOL / DEVNET_SOL_USDC_CONFIG
//    force a specific SOL/USDC pool (MAINNET: use these).
async function main() {
    await setCpmmPool();
    await setSolUsdcPool();
    const alt = await ensureClaimAlt();
    console.log(`\n Pool setup complete. Claim lookup table: ${alt}`);
    console.log(" SOL bond claims now send as v0 transactions with a 400k CU limit.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
