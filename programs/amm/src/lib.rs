pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("7L32KRgZAttvuiY7LgtLTUwTAYL54JfyELVd7CUxVKgy");

#[program]
pub mod amm {
    use super::*;

    pub fn initialize_amm(
        ctx: Context<InitializeAmm>,
        spot_oracle: Pubkey,
        staking_pool: Pubkey,
    ) -> Result<()> {
        initialize::handler(ctx, spot_oracle, staking_pool)
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

    // DEVNET/TEST ONLY — remove before mainnet
    pub fn load_test_data(ctx: Context<LoadTestData>, data: TestMetrics) -> Result<()> {
        load_test_data::handler(ctx, data)
    }

    // Night-desk taking instruction. Buyer pays USDC (SOL support at
    // mainnet); payment splits 80% buyback vault / 10% dip reserve / 10%
    // staker-rewards holding vault at claim time. Purchased NYSEH goes
    // directly into a vesting StakePosition via CPI — it never sits in the
    // buyer's wallet. Claims only while the market is after-hours/closed,
    // against the current day's sheet.
    pub fn offer_claim(ctx: Context<OfferClaim>, tier: u8, units: u8, index: u64) -> Result<()> {
        offer_claim::handler(ctx, tier, units, index)
    }

    // Start-of-day staker distribution: swap yesterday's 10% USDC share into
    // NYSEH and deposit it into the staking reward vault (MasterChef index
    // bump → instantly claimable pro-rata). Once per trading day.
    pub fn distribute_staker_rewards(ctx: Context<DistributeStakerRewards>) -> Result<()> {
        distribute_staker_rewards::handler(ctx)
    }

    pub fn dex_buyback(ctx: Context<DexBuyback>) -> Result<()> {
        // executes at start of every trading day
        // uses 80% of funds made from all last night's claimed offers
        //
        // set limit orders with 10% to catch dips
        // thes dip catching mechanism should be "always on", not just during trade hours
        dex_buyback::handler(ctx)
    }
}
#[derive(Accounts)]
pub struct CompletedOffers<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}