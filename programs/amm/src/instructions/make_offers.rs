use crate::state::offersState::{AmmState, MarketMetrics, Offer, OfferList};
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
    /// CHECK: market statusPDA
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"metrics", amm_state.nyseh_mint.as_ref()], bump)]
    pub metrics: Account<'info, MarketMetrics>,
    /// CHECK: nyse_vault for balance capping
    #[account(mut, address = amm_state.nyseh_vault)]
    pub nyseh_vault: AccountInfo<'info>,
    /// CHECK: live price oracle (mock for devnet, change before mainnet)
    pub price_oracle: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MakeOffers>) -> Result<()> {
    // executes at end of every trading day analyze market performance

    let amm_state = &mut ctx.accounts.amm_state;
    let offer_list = &mut ctx.accounts.offer_list;
    let metrics = &mut ctx.accounts.metrics;
    let market_status = &ctx.accounts.market_status;
    // determine offers available
    // no more than 5% of total POSR
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == amm_state.authority || caller == amm_state.crank_program,
        ErrorCode::UnauthorizedCaller
    );
    let market_data = market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, ErrorCode::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[16..25].try_into().unwrap());
    require!(
        current_state == 1 || current_state == 2,
        ErrorCode::InvalidMarketState
    );
    require!(
        metrics.day_index != current_day,
        ErrorCode::AlreadyConstructed
    );
    metrics.day_index = current_day;
    let mhs = calculate_mhs(metrics)?;
    msg!("the MHS today ({}) is calculated to {}", current_day, mhs);
    // build offer list & write to account

    Ok(())
}

fn calculate_mhs(metrics: &MarketMetrics) -> Result<u64> {
    let treasury_ratio = if metrics.total_supply > 0 {
        (metrics.treasury_sol * 100) / metrics.total_supply
    } else {
        0
    };

    let staking_ratio = if metrics.total_supply > 0 {
        (metrics.total_staked * 100) / metrics.total_supply
    } else {
        0
    };

    let perf = calculate_performance_score(metrics);

    Ok(((treasury_ratio * 40) + (staking_ratio * 30) + (perf * 30)) / 100)
}

fn calculate_performance_score(metrics: &MarketMetrics) -> u64 {
    let head = metrics.sample_head as usize;
    if metrics.price_samples[head] == 0 {
        return 50_00; // neutral
    }
    let tail = ((head + 5 - 4) % 5) as usize;
    let old = if metrics.price_samples[tail] > 0 {
        metrics.price_samples[tail]
    } else {
        metrics.price_samples[head]
    };

    if old == 0 {
        return 50_00;
    }

    let ret = ((metrics.price_samples[head] as i128 - old as i128) * 100) / old as i128;
    // Negative return = higher score (contrarian)
    let score = 50_00i128 - (ret * 100);
    score.clamp(0, 100_00) as u64
}

fn read_reference_price(price_oracle: &AccountInfo) -> Result<u64> {
    let data = price_oracle.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidOracle);
    Ok(u64::from_le_bytes(data[0..8].try_into().unwrap()))
}
fn empty_offer() -> Offer {
    Offer {
        lot_size: 0,
        vesting_days: 0,
        discount_bps: 0,
        remaining: 0,
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
