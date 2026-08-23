use crate::state::offersState::{AcceptedOffers, AmmState, Offer, OfferList};
use anchor_lang::prelude::*;

// Fires off at beginning of each trade day.

#[derive(Accounts)]
pub struct CalcCompletedOffers<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Account<'info, AmmState>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.afho_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Account<'info, OfferList>,
    /// CHECK: market status PDA, same verification as MakeOffers
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"accepted_offers", amm_state.afho_mint.as_ref()], bump)]
    pub accepted_offers: Account<'info, AcceptedOffers>,

    /// CHECK: live absolute-price oracle — raw u64 stub (first 8 bytes), same
    /// pattern as offer_claim::read_live_price. Address pinned at init
    /// (mock-dex-pool's mock_price PDA on devnet). MAINNET TODO: absolute-price
    /// source in the same units as highest_buyback_basis (raw USDC-in x 1e6 /
    /// raw AFHO-out).
    #[account(address = amm_state.spot_oracle)]
    pub price_oracle: UncheckedAccount<'info>,
}

// Ratchet decay: trading days with no fills before the floor starts decaying,
// and the fraction of the (floor - live) gap cut per locked day after that.
const FLOOR_LOCK_GRACE_DAYS: u16 = 15;
const FLOOR_DECAY_PCT: u64 = 2;

pub fn handler(ctx: Context<CalcCompletedOffers>) -> Result<()> {
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
    // Only record at the start of a trading day (market just opened)
    require!(current_state == 0, ErrorCode::InvalidMarketState);
    // Once per trading day
    require!(
        ctx.accounts.accepted_offers.day_index != current_day,
        ErrorCode::AlreadyConstructed
    );
    ctx.accounts.accepted_offers.day_index = current_day;

    // M2 — only score YESTERDAY's sheet. Without this freshness check a missed
    // make_offers night double-counts the stale sheet's fill %, and a
    // partially-filled stale sheet keeps resetting untaken_days forever,
    // permanently blocking ratchet-floor decay. Day 0 has no yesterday's
    // sheet (L1 inits day_index to u64::MAX), so this correctly errors there.
    require!(
        ctx.accounts.offer_list.day_index == current_day.saturating_sub(1),
        ErrorCode::StaleOfferSheet
    );

    let offer_list = &ctx.accounts.offer_list;
    let big_pct = pct_accepted(&offer_list.big_offer);
    let med_pct = pct_accepted(&offer_list.med_offer);
    let sml_pct = pct_accepted(&offer_list.sml_offer);

    update_offer_sheet_records(&mut ctx.accounts.accepted_offers, big_pct, med_pct, sml_pct);

    // ── Ratchet floor decay ──
    // The floor only ever moves UP via buyback fills (dex_buyback). When the
    // market falls below it the desk is locked: sheets go untaken (claims
    // fail at the floor) or metrics refuse a sheet at all. After
    // FLOOR_LOCK_GRACE_DAYS straight days with no fills, decay the floor
    // toward the live price by FLOOR_DECAY_PCT of the gap per trading day —
    // exponential convergence that never crosses below live and never zeroes.
    let live_price = read_live_price(&ctx.accounts.price_oracle)?;
    let amm_state = &mut ctx.accounts.amm_state;
    let floor = amm_state.highest_buyback_basis;

    let any_taken = [&offer_list.big_offer, &offer_list.med_offer, &offer_list.sml_offer]
        .iter()
        .any(|o| o.total_offered > o.remaining);
    let sheet_made = [&offer_list.big_offer, &offer_list.med_offer, &offer_list.sml_offer]
        .iter()
        .any(|o| o.total_offered > 0);

    if any_taken {
        amm_state.untaken_days = 0;
    } else {
        // Count sheet-posted-but-ignored days, and dark-desk days where the
        // floor is the binding constraint. No sheet with price >= floor means
        // nothing is wrong — the counter holds.
        if sheet_made || live_price < floor {
            amm_state.untaken_days = amm_state.untaken_days.saturating_add(1);
        }
        if amm_state.untaken_days > FLOOR_LOCK_GRACE_DAYS && floor > live_price {
            let gap = floor - live_price;
            // max(1) keeps integer math from stalling at tiny gaps; min(gap)
            // lands exactly on live, never below.
            let cut = ((gap as u128 * FLOOR_DECAY_PCT as u128) / 100) as u64;
            let cut = cut.max(1).min(gap);
            amm_state.highest_buyback_basis = floor - cut;
            msg!(
                "floor decay day {}: {} -> {} (live {})",
                amm_state.untaken_days,
                floor,
                amm_state.highest_buyback_basis,
                live_price,
            );
        }
    }

    Ok(())
}

// % of the tier that buyers cleared: 100 = sold out, 0 = untouched / no offers that day
fn pct_accepted(offer: &Offer) -> u8 {
    if offer.total_offered == 0 {
        return 0;
    }
    let cleared = (offer.total_offered - offer.remaining) as u16;
    (cleared * 100 / offer.total_offered as u16) as u8
}

// Update percentages of the AcceptedOffers account
fn update_offer_sheet_records(
    accepted: &mut AcceptedOffers,
    big_pct: u8,
    med_pct: u8,
    sml_pct: u8,
) {
    accepted.big_offers_accepted.copy_within(1.., 0);
    accepted.big_offers_accepted[4] = big_pct;

    accepted.med_offers_accepted.copy_within(1.., 0);
    accepted.med_offers_accepted[4] = med_pct;

    accepted.sml_offers_accepted.copy_within(1.., 0);
    accepted.sml_offers_accepted[4] = sml_pct;
}
// Raw u64 price stub, same pattern as offer_claim::read_live_price.
fn read_live_price(price_oracle: &AccountInfo) -> Result<u64> {
    let data = price_oracle.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidOracle);
    Ok(u64::from_le_bytes(data[0..8].try_into().unwrap()))
}

#[error_code]
pub enum ErrorCode {    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Invalid market status")]
    InvalidMarketStatus,
    #[msg("Invalid market state for offers")]
    InvalidMarketState,
    #[msg("Already constructed for this day")]
    AlreadyConstructed,
    #[msg("Offer sheet is not yesterday's — stale or missing sheet")]
    StaleOfferSheet,
    #[msg("Invalid price oracle")]
    InvalidOracle,
}