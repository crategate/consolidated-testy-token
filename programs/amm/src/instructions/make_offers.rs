use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, Offer, OfferList};
use anchor_lang::prelude::*;

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
    // determine offers available
    // no more than 5% of total POSR
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
    record_price_change(metrics, &ctx.accounts.price_oracle, Clock::get()?.slot);
    let momentum = calculate_momentum_score(metrics);
    let stake_health = calculate_stake_health(metrics);
    record_stake_ratio(metrics);
    let _offer_aggression = offer_accepted_aggression(accepted_offers);
    msg!(
        "the stake health ({}) & momentum {} for today  {}",
        stake_health,
        momentum,
        current_day,
    );
    // build offer list & write to account

    Ok(())
}

// Record today's priceChange24h (feeds[1], centi-percent) into the 20-day ring.
// Best-effort: a missing or stale price feed skips the write — momentum then
// stays cold and no offers are built, rather than blocking the whole crank.
fn record_price_change(
    metrics: &mut MarketMetrics,
    quote: &switchboard_on_demand::SwitchboardQuote,
    current_slot: u64,
) {
    use switchboard_on_demand::prelude::rust_decimal::prelude::ToPrimitive;
    const MAX_STALENESS_SLOTS: u64 = 300;
    if quote.feeds.len() < 2 || current_slot.saturating_sub(quote.slot) > MAX_STALENESS_SLOTS {
        msg!("price feed missing or stale — skipping today's price sample");
        return;
    }
    if let Some(cp) = quote.feeds[1].value().to_i32() {
        let v = cp.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        let head = (metrics.sample_head as usize) % metrics.price_changes.len();
        metrics.price_changes[head] = v;
        metrics.sample_head = ((head + 1) % metrics.price_changes.len()) as u8;
        msg!("recorded priceChange24h: {} centi-percent", v);
    }
}

// Current staking participation as a whole %: staked / total_supply.
// NOTE: per the metric's definition this should be staked / (supply NOT left in
// AMM vault); uses total_supply until a live circulating figure is wired in.
fn current_stake_ratio(metrics: &MarketMetrics) -> u8 {
    if metrics.total_supply == 0 {
        return 0;
    }
    ((metrics.total_staked as u128 * 100) / metrics.total_supply as u128) as u8
}

// Stake health score, 0-100. NOTE: consumed INVERTED in make_offers.
// A high/rising score reads as holder complacency (lower staker confidence in
// near-term price), so it should TIGHTEN offers: smaller discounts, longer
// vesting, fewer lots. A low/falling score makes offers more attractive, to
// catch and reverse a downturn before the AMM goes dormant for days.
//   base = current staking ratio
//   adjustment = today's ratio vs 5-day trailing average, clamped to +/-20
fn calculate_stake_health(metrics: &MarketMetrics) -> u8 {
    let current = current_stake_ratio(metrics) as i16;
    let trailing_avg = (metrics
        .trailing_stake_health
        .iter()
        .map(|&v| v as u16)
        .sum::<u16>()
        / 5) as i16;
    let adjustment = (current - trailing_avg).clamp(-20, 20);
    (current + adjustment).clamp(0, 100) as u8
}

// Record today's ratio into the 5-day trailing buffer (index 0 = oldest).
fn record_stake_ratio(metrics: &mut MarketMetrics) {
    let current = current_stake_ratio(metrics);
    metrics.trailing_stake_health.copy_within(1.., 0);
    metrics.trailing_stake_health[4] = current;
}
fn offer_accepted_aggression(accepted: &AcceptedOffers) -> u16 {
    // this metric will look at what % of each offer tier was accepted
    // if offers aren't being accepted,
    // discount should tick higher, and vesting days decrease
    // these values should be updated at the END of an offer period (Beginning of next trading day)
    //
    const RECENCY_WEIGHTS: [u16; 5] = [5, 6, 7, 8, 9];

    // Tier weights: big lots signal more conviction
    const TIER_WEIGHTS: [u16; 3] = [1, 2, 4]; // sml, med, big

    let tiers = [
        &accepted.sml_offers_accepted,
        &accepted.med_offers_accepted,
        &accepted.big_offers_accepted,
    ];

    let mut total_weighted: u16 = 0;
    let mut total_possible: u16 = 0;

    for (tier_idx, tier_samples) in tiers.iter().enumerate() {
        for (day_idx, &pct) in tier_samples.iter().enumerate() {
            let weight = RECENCY_WEIGHTS[day_idx] * TIER_WEIGHTS[tier_idx];
            total_weighted += (pct as u16) * weight;
            total_possible += 100 * weight;
        }
    }

    // Returns 0-10000 (basis points, 2 decimal precision)
    // 0 = dead, 10000 = every offer cleared instantly for 5 days
    // u32 math: total_weighted can reach 24500 — * 10000 would overflow u16
    (total_weighted as u32 * 10000 / total_possible as u32) as u16
}

// Momentum score, 0-10000 (5000 = flat). Primary weight in offer construction.
// Derived only from the 20-day price_changes ring (daily priceChange24h,
// centi-percent). No volume input — price is the signal, per design.
//   blended = recency-weighted mean + (recent-5-day avg - older avg) / 2
//   score   = 5000 + blended * 10  →  sustained ±5% daily move pins the scale
// Each sample is capped at ±SAMPLE_CAP_CP, so one wash pump/dump boosts or
// sinks the score for a few days but can't pin it — only SUSTAINED extreme
// moves reach 0 / 10000.
// Cold start: fewer than MIN_SAMPLES nonzero ring entries → 0 (no offers).
// Note: a genuine 0.00% day reads as "no sample" — acceptable at this precision.
fn calculate_momentum_score(metrics: &MarketMetrics) -> u64 {
    const MIN_SAMPLES: usize = 5;
    const NEUTRAL: i64 = 5_000;
    const CP_FULL_SCALE: i64 = 500; // 5.00% in centi-percent
    const SAMPLE_CAP_CP: i64 = 1_000; // ±10%/day effective per sample

    let n = metrics.price_changes.len();
    let head = metrics.sample_head as usize % n;

    let mut count = 0usize;
    let mut w_sum: i64 = 0;
    let mut w_total: i64 = 0;
    let mut recent_sum: i64 = 0;
    let mut recent_n: i64 = 0;
    let mut older_sum: i64 = 0;
    let mut older_n: i64 = 0;

    // age 0 = oldest entry (sample_head = next write = oldest slot)
    for age in 0..n {
        let raw = metrics.price_changes[(head + age) % n];
        if raw == 0 {
            continue;
        }
        let v = (raw as i64).clamp(-SAMPLE_CAP_CP, SAMPLE_CAP_CP);
        count += 1;
        let w = (age + 1) as i64; // newer days weigh more
        w_sum += v * w;
        w_total += w;
        if age >= n - 5 {
            recent_sum += v;
            recent_n += 1;
        } else {
            older_sum += v;
            older_n += 1;
        }
    }

    if count < MIN_SAMPLES {
        return 0;
    }

    let weighted_avg = w_sum / w_total;
    // Guard both windows: all samples in the recent window (cold ring) or all
    // in the older window (recent days read as 0.00% = "no sample") → no trend.
    let trend = if recent_n > 0 && older_n > 0 {
        recent_sum / recent_n - older_sum / older_n
    } else {
        0
    };

    let blended = weighted_avg + trend / 2;
    (NEUTRAL + blended * NEUTRAL / CP_FULL_SCALE).clamp(0, 10_000) as u64
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
