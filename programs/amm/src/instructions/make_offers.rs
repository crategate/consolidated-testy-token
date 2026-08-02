use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, Offer, OfferList};
use anchor_lang::prelude::*;

use super::helpers_make_offers::*;

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

    #[account(seeds = [b"accepted_offers", amm_state.nyseh_mint.as_ref()], bump)]
    pub accepted_offers: Account<'info, AcceptedOffers>,

    /// CHECK: nyse_vault for balance capping
    #[account(mut, address = amm_state.nyseh_vault)]
    pub nyseh_vault: AccountInfo<'info>,
    /// CHECK: live price oracle — canonical Switchboard quote [market_status, price]
    #[account(address = amm_state.price_oracle)]
    pub price_oracle: Box<Account<'info, switchboard_on_demand::SwitchboardQuote>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MakeOffers>) -> Result<()> {
    // executes at end of every trading day analyze market performance
    // build offers for the day

    let amm_state = &mut ctx.accounts.amm_state;
    let _offer_list = &mut ctx.accounts.offer_list;
    let metrics = &mut ctx.accounts.metrics;
    let market_status = &ctx.accounts.market_status;
    let accepted_offers = &ctx.accounts.accepted_offers;
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == amm_state.authority || caller == amm_state.keeper,
        ErrorCode::UnauthorizedCaller
    );
    let market_data = market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, ErrorCode::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    require!(
        current_state == 1 || current_state == 2,
        ErrorCode::InvalidMarketState
    );
    require!(
        metrics.day_index != current_day,
        ErrorCode::AlreadyConstructed
    );
    metrics.day_index = current_day;

    // -- metrics (helpers_make_offers.rs) --
    record_price_change(metrics, &ctx.accounts.price_oracle, Clock::get()?.slot);
    let momentum = calculate_momentum_score(metrics);
    let stake_health = calculate_stake_health(metrics);
    record_stake_ratio(metrics);
    let offer_aggression = offer_accepted_aggression(accepted_offers);

    // -- Offer combinator: sequential pipeline, one dimension after another --
    // each step builds on the ones already decided:
    //   1. totals   — tokens offered today ← momentum bump-taper (V1, below)
    //   2. tiers    — lot sizes climb/slide ← vault abundance + excitement (TODO)
    //   3. counts   — derived: totals split 50/35/15 ÷ lot sizes (TODO)
    //   4. discount — momentum bump (peaks in ignition band), aggression-
    //                 tightened, floor-capped; strictly big > med > sml (TODO)
    //   5. vesting  — stake health base, shortened to compensate when the
    //                 floor crushes the discount (TODO)
    let vault_balance = vault_token_balance(&ctx.accounts.nyseh_vault);
    let totals_bps = daily_totals_pct_bps(momentum);
    let total_tokens = (vault_balance as u128 * totals_bps as u128 / 10_000) as u64;
    msg!(
        "day {}: momentum {}, stake health {}, aggression {} -> totals {} bps of vault = {} tokens",
        current_day,
        momentum,
        stake_health,
        offer_aggression,
        totals_bps,
        total_tokens,
    );
    // TODO steps 2-5: build offer list & write to account

    Ok(())
}

// Step 1 — daily totals as bps of vault, bump-taper over momentum:
//   below 4500 → 40 · 4500–5500 → 50→200 (ignition) · 6750–7500 → 500
//   plateau (the 5% ratchet max) · 7500–8500 → taper 500→200 · ≥8500 → 200.
// Taper past the plateau so euphoria tops get monetized, not dumped into.
// The plateau ends at 7500 because a clamped wash spike parks momentum at
// ~7500–8000 for days — spikes land on the taper, genuine runs ride through.
// Cold start (momentum 0 = no price data) → 0: no reliable oracle, no desk.
fn daily_totals_pct_bps(momentum: u64) -> u64 {
    const PTS: [(i64, i64); 6] = [
        (4500, 50),
        (5500, 200),
        (6750, 500),
        (7500, 500),
        (8500, 250),
        (10000, 190),
    ];
    if momentum == 0 {
        return 0;
    }
    let m = momentum as i64;
    if m < PTS[0].0 {
        return 40;
    }
    for w in PTS.windows(2) {
        let (x0, y0) = w[0];
        let (x1, y1) = w[1];
        if m <= x1 {
            return (y0 + (m - x0) * (y1 - y0) / (x1 - x0)) as u64;
        }
    }
    200
}

// Vault SPL token balance; unreadable vault → 0 → empty sheet (fail dark).
fn vault_token_balance(vault: &AccountInfo) -> u64 {
    let data = match vault.try_borrow_data() {
        Ok(d) => d,
        Err(_) => return 0,
    };
    anchor_spl::token::TokenAccount::try_deserialize_unchecked(&mut &data[..])
        .map(|ta| ta.amount)
        .unwrap_or(0)
}

fn empty_offer() -> Offer {
    Offer {
        lot_size: 0,
        vesting_days: 0,
        discount_bps: 0,
        remaining: 0,
        total_offered: 0,
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
