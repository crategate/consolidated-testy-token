pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("AU19M8ELLh7h4GMpmj9ZKjF4NNXmYK6aiVoLs9yvnuRi");

#[program]
pub mod amm {
    use super::*;

    pub fn initialize_amm(
        ctx: Context<InitializeAmm>,
        spot_oracle: Pubkey,
        staking_pool: Pubkey,
        sol_oracle: Pubkey,
    ) -> Result<()> {
        initialize::handler(ctx, spot_oracle, staking_pool, sol_oracle)
    }

    pub fn make_offers(ctx: Context<MakeOffers>) -> Result<()> {
        make_offers::handler(ctx)
    }

    pub fn calc_completed_offers(ctx: Context<CalcCompletedOffers>) -> Result<()> {
        calc_completed_offers::handler(ctx)
    }

    // End-of-day metric writes; keeper fires this BEFORE make_offers.
    pub fn update_tradeday_stats(ctx: Context<UpdateTradedayStats>) -> Result<()> {
        update_tradeday_stats::handler(ctx)
    }

    pub fn set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
        set_keeper::handler(ctx, new_keeper)
    }

    // Pin the Raydium CPMM pool for the swap adapter (authority || keeper).
    pub fn set_cpmm_pool(
        ctx: Context<SetCpmmPool>,
        cpmm_program: Pubkey,
        pool_state: Pubkey,
        amm_config: Pubkey,
    ) -> Result<()> {
        set_cpmm_pool::handler(ctx, cpmm_program, pool_state, amm_config)
    }

    // Pin the SOL/USDC pool for All-USDC claim conversion (authority || keeper).
    pub fn set_sol_usdc_pool(
        ctx: Context<SetSolUsdcPool>,
        pool_state: Pubkey,
        amm_config: Pubkey,
    ) -> Result<()> {
        set_sol_usdc_pool::handler(ctx, pool_state, amm_config)
    }

    // Bounty auto-top-up: swap USDC → SOL and fund the crank bounty vault.
    pub fn bounty_top_up(ctx: Context<BountyTopUp>) -> Result<()> {
        bounty_top_up::handler(ctx)
    }

    // DEVNET/TEST ONLY — remove before mainnet
    pub fn load_test_data(ctx: Context<LoadTestData>, data: TestMetrics) -> Result<()> {
        load_test_data::handler(ctx, data)
    }

    // DEVNET/TEST ONLY — remove before mainnet. Posts a realistic, claimable
    // three-tier offer sheet (day_index = today) with the floor anchored to
    // the live pool price, for UI/claim development without a real make_offers run.
    pub fn load_offers(ctx: Context<LoadOffers>) -> Result<()> {
        load_offers::handler(ctx)
    }

    // Night-desk taking instruction. Buyer pays USDC (SOL support at
    // mainnet); payment splits 80% buyback vault / 10% dip reserve / 10%
    // staker-rewards holding vault at claim time. Purchased AFHO goes
    // directly into a vesting StakePosition via CPI — it never sits in the
    // buyer's wallet. Claims only while the market is after-hours/closed,
    // against the current day's sheet.
    pub fn offer_claim(ctx: Context<OfferClaim>, tier: u8, units: u8, index: u64) -> Result<()> {
        offer_claim::handler(ctx, tier, units, index)
    }

    // Same desk, SOL payment: the USDC-terms cost (same floor, same discount)
    // is charged in lamports and swapped to USDC on the pinned SOL/USDC pool,
    // then splits 80/10/10 into the USDC buyback / dip / staker-rewards vaults.
    pub fn offer_claim_sol(
        ctx: Context<OfferClaimSol>,
        tier: u8,
        units: u8,
        index: u64,
    ) -> Result<()> {
        offer_claim::handler_sol(ctx, tier, units, index)
    }

    // Start-of-day staker distribution: swap yesterday's 10% USDC share into
    // AFHO and deposit it into the staking reward vault (MasterChef index
    // bump → instantly claimable pro-rata). Once per trading day.
    pub fn distribute_staker_rewards(ctx: Context<DistributeStakerRewards>) -> Result<()> {
        distribute_staker_rewards::handler(ctx)
    }

    pub fn dex_buyback(ctx: Context<DexBuyback>) -> Result<()> {
        // executes at start of every trading day
        // uses 80% of funds made from all last night's claimed offers
        dex_buyback::handler(ctx)
    }

    // The "always on" dip buyer: spends the 10% dip reserve whenever the live
    // spot price sits >=3% below the recent spot-ring norm; size is quadratic
    // in depth and scaled by the 20-day trend slope. Any market state.
    pub fn buy_the_dip(ctx: Context<BuyTheDip>) -> Result<()> {
        buy_the_dip::handler(ctx)
    }
}
#[derive(Accounts)]
pub struct CompletedOffers<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}