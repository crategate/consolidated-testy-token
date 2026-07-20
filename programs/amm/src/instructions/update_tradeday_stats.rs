use crate::{
    offersState::MarketMetrics,
    state::offersState::{AcceptedOffers, AmmState},
};
use anchor_lang::prelude::*;

// Fires off at beginning of trade day.

#[derive(Accounts)]
pub struct UpdateTradedayStats<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.nyseh_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Account<'info, AmmState>,

    #[account(
        mut,
        seeds = [b"metrics", amm_state.nyseh_mint.as_ref()],
        bump
    )]
    pub market_metrics: Account<'info, MarketMetrics>,
    /// CHECK: market status PDA
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"accepted_offers", amm_state.nyseh_mint.as_ref()], bump)]
    pub accepted_offers: Account<'info, AcceptedOffers>,
}

pub fn handler(ctx: Context<UpdateTradedayStats>) -> Result<()> {
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == ctx.accounts.amm_state.authority
            || caller == ctx.accounts.amm_state.crank_program,
        ErrorCode::UnauthorizedCaller
    );

    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) + trading_day_index(8)
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, ErrorCode::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    // Only record at the start of a trading day (market just opened)
    require!(current_state == 1, ErrorCode::InvalidMarketState);
    // Once per trading day
    require!(
        ctx.accounts.accepted_offers.day_index != current_day,
        ErrorCode::AlreadyConstructed
    );
    ctx.accounts.accepted_offers.day_index = current_day;
    //
    //    let offer_list = &ctx.accounts.offer_list;
    //    let big_pct = pct_accepted(&offer_list.big_offer);
    //    let med_pct = pct_accepted(&offer_list.med_offer);
    //    let sml_pct = pct_accepted(&offer_list.sml_offer);
    //
    //    update_offer_sheet_records(&mut ctx.accounts.accepted_offers, big_pct, med_pct, sml_pct);

    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Invalid market status")]
    InvalidMarketStatus,
    #[msg("Invalid market state for updating trade day stats")]
    InvalidMarketState,
    #[msg("Already constructed for this day")]
    AlreadyConstructed,
    #[msg("Invalid price oracle")]
    InvalidOracle,
}
