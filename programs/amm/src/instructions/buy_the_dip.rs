use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, OfferList};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct BuyTheDip<'info> {
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
    /// CHECK: sol_dip for buy the dip
    #[account(mut, address = amm_state.sol_dip)]
    pub sol_dip: AccountInfo<'info>,
    /// CHECK: usdc_vault for dip
    #[account(mut, address = amm_state.usdc_dip)]
    pub usdc_dip: AccountInfo<'info>,
    /// CHECK: live price oracle (mock for devnet, change before mainnet)
    pub price_oracle: UncheckedAccount<'info>,

    pub accepted_offers: Account<'info, AcceptedOffers>,
    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<BuyTheDip>) -> Result<()> {
    // use accumulated reserve dip funds to buy the dip
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