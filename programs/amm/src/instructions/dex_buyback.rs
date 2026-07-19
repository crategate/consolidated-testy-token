use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
        TransferChecked,
    },
};

#[derive(Accounts)]
pub struct DexBuyback<'info> {
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
    /// CHECK: market status PDA
    pub market_status: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"metrics", amm_state.nyseh_mint.as_ref()], bump)]
    pub metrics: Account<'info, MarketMetrics>,
    /// CHECK: nyse_vault for balance capping
    #[account(mut, address = amm_state.nyseh_vault)]
    pub nyseh_vault: AccountInfo<'info>,
    /// CHECK: live price oracle (mock for devnet, change before mainnet)
    pub price_oracle: UncheckedAccount<'info>,

    pub accepted_offers: Account<'info, AcceptedOffers>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DexBuyback>) -> Result<()> {
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Invalid market status")]
    InvalidMarketStatus,
    #[msg("Invalid market state for offers")]
    InvalidMarketState,
    #[msg("Already constructed for this day")]
    AlreadyConstructed,
    #[msg("Invalid price oracle")]
    InvalidOracle,
}
