use crate::state::offersState;
use crate::BuyBackVault;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
        TransferChecked,
    },
};

#[derive(Accounts)]
pub struct MakeOffers<'info> {
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
    pub offer_list: Account<'info, offersState::OfferList>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + BuyBackVault::INIT_SPACE,
        seeds = [b"back_vault", owner.key().as_ref()],
        bump
    )]
    pub bb_vault: Account<'info, BuyBackVault>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
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
