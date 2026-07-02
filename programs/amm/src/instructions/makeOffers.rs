use crate::state::offersState::{AmmState, MarketMetrics, Offer, OfferList};
use crate::BuyBackVault;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
        TransferChecked,
    },
};

const MAX_OFFER_PCT_BPS: u16 = 500;
const MHS_BEAR_THRESHOLD: u64 = 35_00;

#[derive(Accounts)]
pub struct MakeOffers<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.nyseh_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Account<'info, AmmState>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.nyseh_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Account<'info, OfferList>,
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: live price oracle (mock for devnet, change before mainnet)
    pub price_oracle: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn make_offers(ctx: Context<MakeOffers>) -> Result<()> {
    // executes at end of every trading day
    // analyze market performance
    //
    // determine offers available
    // no more than 5% of total POSR
    //
    // build offer list & write to account
    Ok(())
}
