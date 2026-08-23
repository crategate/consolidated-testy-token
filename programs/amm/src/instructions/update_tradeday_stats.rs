use crate::state::offersState::{AmmState, MarketMetrics};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use super::helpers_make_offers::{record_price_change, record_stake_ratio};

// Fires at END of every trading day (after-hours begin / market closes),
// BEFORE make_offers. Owns ALL end-of-day metric writes: today's price sample
// and today's staking ratio. make_offers only READS what this records.
// (Start-of-day offer accounting is calc_completed_offers' job.)

#[derive(Accounts)]
pub struct UpdateTradedayStats<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Account<'info, AmmState>,

    #[account(
        mut,
        seeds = [b"metrics", amm_state.afho_mint.as_ref()],
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
    /// live price oracle — canonical Switchboard quote [market_status, price]
    #[account(address = amm_state.price_oracle)]
    pub price_oracle: Box<Account<'info, switchboard_on_demand::SwitchboardQuote>>,

    /// Staking pool — the source of truth for total_staked (stake-health
    /// metric). Typed account: owner + discriminator checked automatically.
    #[account(address = amm_state.staking_pool)]
    pub staking_pool: Box<Account<'info, staking::StakePool>>,
    /// AFHO mint — the source of truth for total_supply.
    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
}

pub fn handler(ctx: Context<UpdateTradedayStats>) -> Result<()> {
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == ctx.accounts.amm_state.authority || caller == ctx.accounts.amm_state.keeper,
        ErrorCode::UnauthorizedCaller
    );

    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) + trading_day_index(8)
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, ErrorCode::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    // End of trading day only (after-hours or closed)
    require!(
        current_state == 1 || current_state == 2,
        ErrorCode::InvalidMarketState
    );
    // Once per trading day
    require!(
        ctx.accounts.market_metrics.day_index != current_day,
        ErrorCode::AlreadyConstructed
    );
    ctx.accounts.market_metrics.day_index = current_day;

    // Refresh the staking inputs from their on-chain sources of truth before
    // recording today's stake ratio (without this, stake health reads 0).
    ctx.accounts.market_metrics.total_staked = ctx.accounts.staking_pool.total_staked;
    ctx.accounts.market_metrics.total_supply = ctx.accounts.afho_mint.supply;

    // End-of-day metric writes (helpers_make_offers.rs)
    record_price_change(
        &mut ctx.accounts.market_metrics,
        &ctx.accounts.price_oracle,
        Clock::get()?.slot,
    );
    record_stake_ratio(&mut ctx.accounts.market_metrics);

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