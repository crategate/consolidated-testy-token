pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

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
    pub fn offer_claim(ctx: Context<OfferClaim>, amount: u8) -> Result<()> {
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
        Ok(())
    }

    pub fn dex_buyback(ctx: Context<CompletedOffers>) -> Result<()> {
        // executes at start of every trading day
        // uses 80% of funds made from all last night's claimed offers
        //
        // set limit orders with 10% to catch dips
        // thes dip catching mechanism should be "always on", not just during trade hours
        Ok(())
    }
}
#[account]
#[derive(InitSpace)]
pub struct BuyBackVault {
    pub authority: Pubkey,
    pub vault_bump: u8,
}
#[derive(Accounts)]
#[instruction(amount: u8)]
pub struct OfferClaim<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"back_vault", owner.key().as_ref()],
        bump
    )]
    pub bb_vault: Account<'info, BuyBackVault>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompletedOffers<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}
