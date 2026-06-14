pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("6d4pTxfAeQdKYn6i9tgTspS6i6bi225MVdxe7pW7MghV");

#[program]
pub mod amm {
    use super::*;

    pub fn tonights_offers(ctx: Context<TonightsOffers>) -> Result<()> {
        // executes at end of every trading day
        // analyze market performance
        //
        // determine offers available
        // no more than 5% of total POSR
        //
        // build offer list & write to account
        Ok(())
    }

    pub fn offer_claim(ctx: Context<OfferClaim>, amount: u8) -> Result<()> {
        // decrease # of offers available by amount
        // multiply amount * market price * discount
        //
        // claim should use largest offers available first for their amount,
        // so a whale wallet doesn't take all availabl small offers...
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
        Ok(())
    }
}

#[account]
pub struct Offer {
    pub lot_size: u8,     // size in whole NYSEH tokens, 50, 100, 500, 1000, 5k, 10k
    pub vesting_days: u8, // how many trading days to unlock
    pub discount: u8,     // % bps discount from live DEX prices
    pub index: u64,
}
#[account]
pub struct OfferList {
    pub owner: Pubkey,
    pub big_offer: Offer,
    pub big_amount: u16,
    pub med_offer: Offer,
    pub med_amount: u16,
    pub sml_offer: Offer,
    pub sml_amount: u16,
}

#[derive(Accounts)]
pub struct TonightsOffers<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = owner,
        seeds = [b"tonights_offers", owner.key().as_ref()],
        bump,
        space = 39 + 8,
    )]
    pub offer_list: Account<'info, OfferList>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(amount: u8)]
pub struct OfferClaim<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CompletedOffers<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
}
