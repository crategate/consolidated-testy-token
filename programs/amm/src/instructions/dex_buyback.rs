use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, OfferList};
use anchor_lang::prelude::*;

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
    /// CHECK: sol_vault for buybacks
    #[account(mut, address = amm_state.sol_vault)]
    pub sol_vault: AccountInfo<'info>,
    /// CHECK: sol_vault for buybacks
    #[account(mut, address = amm_state.usdc_vault)]
    pub usdc_vault: AccountInfo<'info>,
    /// CHECK: live price oracle (mock for devnet, change before mainnet)
    pub price_oracle: UncheckedAccount<'info>,

    pub accepted_offers: Account<'info, AcceptedOffers>,
    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<DexBuyback>) -> Result<()> {
    // TODO: buyback EXECUTION is not engineered yet. Plan: spend the 80% share
    // of accumulated sol/usdc offer proceeds on DEX buys, spread over the next
    // trading day (keeper-fired slices). The ratchet helper below is the only
    // completed piece of the buyback path — on every executed fill, call:
    //   ratchet_buyback_basis(&mut amm_state, fill_price);
    Ok(())
}

// The ratchet floor is the offer desk's ONLY bear-shutdown mechanism:
// make_offers may never price a lot below the highest realized buyback price,
// so when the live price falls to the floor the desk goes dark on its own.
// It therefore only ever moves UP — call once per executed buyback fill.
// (Any decay/reset policy would be a separate design decision; none exists.)
pub fn ratchet_buyback_basis(amm_state: &mut AmmState, executed_price: u64) {
    if executed_price > amm_state.highest_buyback_basis {
        amm_state.highest_buyback_basis = executed_price;
    }
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
