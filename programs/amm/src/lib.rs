pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("HtdXAsisFb5BcW8N1ejbWURZB9WHEFPgHemFqBzHkY9z");

#[program]
pub mod amm {
    use super::*;

    pub fn initialize_amm(ctx: Context<InitializeAmm>) -> Result<()> {
        initialize::handler(ctx)
    }
    pub fn make_offers(ctx: Context<MakeOffers>) -> Result<()> {
        make_offers::handler(ctx)
    }

    pub fn calc_completed_offers(ctx: Context<CalcCompletedOffers>) -> Result<()> {
        calc_completed_offers::handler(ctx)
    }

    pub fn offer_claim(ctx: Context<OfferClaim>, tier: u8, units: u8) -> Result<()> {
        // decrease # of offers available by amount
        // multiply amount * market price * discount
        //
        // claim should use largest offers available first for their amount,
        // so a whale wallet doesn't take all available small offers...
        //
        // create locked stake position for user
        //
        //
        // set 80% for buybacks, 10% to stakers, 10% for favorable/discount buybacks

        offer_claim::handler(ctx, tier, units)
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
