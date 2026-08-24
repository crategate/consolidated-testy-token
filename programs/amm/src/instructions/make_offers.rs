use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, Offer, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use super::helpers_make_offers::*;

#[derive(Accounts)]
pub struct MakeOffers<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.afho_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Box<Account<'info, OfferList>>,
    /// CHECK: market statusPDA
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// READ-ONLY: metrics are written by update_tradeday_stats (end of day)
    /// and calc_completed_offers (start of day), never here.
    #[account(seeds = [b"metrics", amm_state.afho_mint.as_ref()], bump)]
    pub metrics: Box<Account<'info, MarketMetrics>>,

    #[account(seeds = [b"accepted_offers", amm_state.afho_mint.as_ref()], bump)]
    pub accepted_offers: Box<Account<'info, AcceptedOffers>>,

    /// Mint, for decimals — lot sizes are whole tokens, vault is raw units.
    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: nyse_vault for balance capping
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: AccountInfo<'info>,
    /// CHECK: live price oracle — canonical Switchboard quote [market_status, price]
    #[account(address = amm_state.price_oracle)]
    pub price_oracle: Box<Account<'info, switchboard_on_demand::SwitchboardQuote>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MakeOffers>) -> Result<()> {
    // Fires at END of every trading day: read the metrics, run the combinator,
    // post the offer sheet. All metric WRITES live in update_tradeday_stats
    // (end of day, fired before this) and calc_completed_offers (start of day).
    let amm_state = &ctx.accounts.amm_state;
    let offer_list = &mut ctx.accounts.offer_list;
    let metrics = &ctx.accounts.metrics;
    let accepted_offers = &ctx.accounts.accepted_offers;
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == amm_state.authority || caller == amm_state.keeper,
        ErrorCode::UnauthorizedCaller
    );
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, ErrorCode::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    require!(
        current_state == 1 || current_state == 2,
        ErrorCode::InvalidMarketState
    );
    require!(
        offer_list.day_index != current_day,
        ErrorCode::AlreadyConstructed
    );

    // -- metrics (helpers_make_offers.rs) — read-only here --
    let momentum = calculate_momentum_score(metrics);
    let stake_health = calculate_stake_health(metrics);
    let offer_aggression = offer_accepted_aggression(accepted_offers);

    // -- Offer combinator: sequential pipeline, one dimension after another --
    // each step builds on the ones already decided.
    let vault_balance = vault_token_balance(&ctx.accounts.afho_vault);
    let unit = 10u64
        .checked_pow(ctx.accounts.afho_mint.decimals as u32)
        .unwrap_or(1);

    // Step 1 — totals: tokens offered today ← momentum bump-taper.
    let totals_bps = daily_totals_pct_bps(momentum);
    let total_tokens = (vault_balance as u128 * totals_bps as u128 / 10_000) as u64;

    // Step 2 — lot tiers ← vault abundance (caps the ladder) + excitement
    // (climbs it); spacing widens with momentum. Uses totals step's vault read.
    let mom_x = momentum.saturating_sub(3_500).min(6_500) * 10_000 / 6_500;
    let excitement = (6 * mom_x + 4 * offer_aggression as u64) / 10;
    let tiers = lot_tiers(vault_balance, metrics.total_supply, mom_x, excitement);

    // Step 3 — counts DERIVED from steps 1+2: split total token mass
    // 50/35/15 (big/med/sml), divide by lot size. Floor division only ever
    // shrinks the sheet, so Σ count·lot ≤ totals ≤ vault by construction.
    let counts = tier_counts(total_tokens, tiers, unit);

    // Step 4 — discount ← momentum bump (peaks in the ignition band),
    // tightened by aggression, tier-stepped and cascaded strictly
    // big > med > sml. The ratchet floor is NOT applied here: offer_claim
    // clamps execution price to highest_buyback_basis, so a listed discount
    // deeper than the floor simply executes AT the floor. Tiers below
    // MIN_LIST (200 bps) or with 0 lots are unlisted (empty offer).
    let base_disc = (discount_bump(momentum) - 400 * offer_aggression as i64 / 10_000).max(0);
    let raw_disc = [base_disc, base_disc + 150, base_disc + 300]; // sml, med, big
    let stored_disc = cascade_discounts(raw_disc);

    // Step 5 — vesting ← stake health (sticky base = longer locks), shortened
    // to compensate when step 4's realized discount got clamped below target.
    let bases = [5u64, 10, 20];
    let mut sheet = [empty_offer(), empty_offer(), empty_offer()];
    for i in 0..3 {
        if counts[i] > 0 && stored_disc[i] >= MIN_LIST_STORED {
            sheet[i] = Offer {
                lot_size: tiers[i],
                vesting_days: vesting_days(bases[i], stake_health, raw_disc[i], stored_disc[i] as i64 * 10),
                discount_bps: stored_disc[i],
                remaining: counts[i],
                total_offered: counts[i],
            };
        }
    }
    offer_list.sml_offer = sheet[0];
    offer_list.med_offer = sheet[1];
    offer_list.big_offer = sheet[2];
    offer_list.day_index = current_day;

    msg!(
        "day {}: mom {} stake {} aggr {} -> totals {}bps ({} tok); tiers {}/{}/{}; counts {}/{}/{}; disc {}/{}/{}; vest {}/{}/{}",
        current_day,
        momentum,
        stake_health,
        offer_aggression,
        totals_bps,
        total_tokens,
        sheet[0].lot_size, sheet[1].lot_size, sheet[2].lot_size,
        sheet[0].total_offered, sheet[1].total_offered, sheet[2].total_offered,
        sheet[0].discount_bps, sheet[1].discount_bps, sheet[2].discount_bps,
        sheet[0].vesting_days, sheet[1].vesting_days, sheet[2].vesting_days,
    );
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
        (8500, 200),
        (10000, 200),
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

// Step 2 — dynamic lot tiers (indices 0–21 into lot_sizer). Vault abundance
// caps the ladder: initial vault ≈ 40% of supply, so the % -of-supply
// thresholds 30/20/10/4 mirror the sim's 75/50/25/10%-of-initial ceilings
// 9/7/5/3/1. Excitement E climbs toward the ceiling; spacing widens with
// momentum (euphoria → whale bait). Ordering sml < med < big always holds.
fn lot_tiers(vault_balance: u64, total_supply: u64, mom_x: u64, excitement: u64) -> [u8; 3] {
    let abundance = if total_supply == 0 {
        0
    } else {
        (vault_balance as u128 * 100 / total_supply as u128) as u64
    };
    let ceiling: i64 = if abundance >= 30 {
        9
    } else if abundance >= 20 {
        7
    } else if abundance >= 10 {
        5
    } else if abundance >= 4 {
        3
    } else {
        1
    };
    let climb = ((10_000 - excitement) * 4 + 5_000) / 10_000; // 0..4
    let big = (ceiling - climb as i64).max(3);
    let spacing = (2 + (2 * mom_x + 5_000) / 10_000) as i64; // 2..4
    let med = (big - spacing).clamp(2, big - 1);
    let sml = (med - spacing).clamp(1, med - 1);
    [sml as u8, med as u8, big as u8]
}

// Step 3 — derived counts per tier (sml, med, big order in/out).
fn tier_counts(total_tokens: u64, tiers: [u8; 3], unit: u64) -> [u8; 3] {
    use crate::state::offersState::lot_sizer;
    let shares = [15u64, 35, 50]; // token-mass split sml/med/big
    let mut counts = [0u8; 3];
    for i in 0..3 {
        let lot_raw = lot_sizer(tiers[i]) as u64 * unit; // raw units per lot
        if lot_raw == 0 {
            continue;
        }
        let mass = total_tokens * shares[i] / 100;
        counts[i] = (mass / lot_raw).min(u8::MAX as u64) as u8;
    }
    counts
}

// Step 4 — discount bump over momentum (bps): 300 flat below 4500, ramp to
// 1350 at 5750 (ignition peak), taper to 810 by 8000 (euphoria = monetize).
fn discount_bump(momentum: u64) -> i64 {
    const PTS: [(i64, i64); 4] = [(4500, 300), (5750, 1350), (8000, 810), (10000, 810)];
    let m = momentum as i64;
    if m < PTS[0].0 {
        return 300;
    }
    for w in PTS.windows(2) {
        let (x0, y0) = w[0];
        let (x1, y1) = w[1];
        if m <= x1 {
            return y0 + (m - x0) * (y1 - y0) / (x1 - x0);
        }
    }
    810
}

// Stored discounts are tenths of a percent (115 = 11.5%). Cascade so the
// stored values stay strictly big > med > sml even after the u8 clamp.
fn cascade_discounts(raw: [i64; 3]) -> [u8; 3] {
    let big = (raw[2] / 10).clamp(0, 255);
    let med = (raw[1] / 10).clamp(0, (big - 1).max(0));
    let sml = (raw[0] / 10).clamp(0, (med - 1).max(0));
    [sml as u8, med as u8, big as u8]
}

// Tiers listed below this stored discount (20 = 200 bps) are insult noise.
const MIN_LIST_STORED: u8 = 20;

// Step 5 — vesting in whole trading days: base × (0.5 + stake_health/100),
// minus 3 days per 100 bps the realized discount fell below target (clamps),
// clamped 3–30.
fn vesting_days(base: u64, stake_health: u8, target_bps: i64, realized_bps: i64) -> u8 {
    let scaled = (base * (50 + stake_health as u64) + 50) / 100;
    let days_off = 3 * (target_bps - realized_bps).max(0) / 100;
    (scaled as i64 - days_off).clamp(3, 30) as u8
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