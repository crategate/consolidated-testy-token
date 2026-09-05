use crate::state::offersState::{AcceptedOffers, AmmState, Offer, OfferList};
use anchor_lang::prelude::*;

// Fires off at beginning of each trade day.

#[derive(Accounts)]
pub struct CalcCompletedOffers<'info> {
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
    /// CHECK: market status PDA, same verification as MakeOffers
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"accepted_offers", amm_state.afho_mint.as_ref()], bump)]
    pub accepted_offers: Box<Account<'info, AcceptedOffers>>,

    // Raydium CPMM AFHO/USDC pool — the ONLY price source (pool pins in
    // AmmState; the handler hard-errors when unset and validates the
    // accounts against the pool's derived PDAs).
    /// CHECK: pool state, pinned to amm_state.cpmm_pool_state in the handler
    pub cpmm_pool_state: Option<AccountInfo<'info>>,
    /// CHECK: pool observation (TWAP ring)
    pub cpmm_observation: Option<AccountInfo<'info>>,
    /// CHECK: pool USDC vault (quote leg)
    pub cpmm_input_vault: Option<AccountInfo<'info>>,
    /// CHECK: pool AFHO vault (base leg)
    pub cpmm_output_vault: Option<AccountInfo<'info>>,
}

// Ratchet decay: trading days with no fills before the floor starts decaying,
// and the fraction of the (floor - live) gap cut per locked day after that.
// Grace cut 15 → 3 (2026-09-04): a dead desk for two+ weeks starves the
// buyback/dip flywheel; 3 trading days still denies same-crash desk farming.
// NOTE the STEP still dominates convergence: at 2%/day the gap halves in ~34
// days, so the desk only becomes competitive again after ~100+ days of decay.
const FLOOR_LOCK_GRACE_DAYS: u16 = 3;
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
    let live_price = {
        let amm_state = &ctx.accounts.amm_state;
        let pinned = amm_state.cpmm_pool_state != Pubkey::default();
        require!(pinned, ErrorCode::PoolNotPinned);
        let clock = Clock::get()?;
            let pool_state = ctx.accounts.cpmm_pool_state.as_ref().ok_or(ErrorCode::InvalidPoolAccount)?;
            let observation = ctx.accounts.cpmm_observation.as_ref().ok_or(ErrorCode::InvalidPoolAccount)?;
            let base_vault = ctx.accounts.cpmm_output_vault.as_ref().ok_or(ErrorCode::InvalidPoolAccount)?;
            let quote_vault = ctx.accounts.cpmm_input_vault.as_ref().ok_or(ErrorCode::InvalidPoolAccount)?;
            require!(
                pool_state.key() == amm_state.cpmm_pool_state,
                ErrorCode::InvalidPoolAccount
            );
            require!(
                observation.key()
                    == crate::instructions::raydium::observation_pda(&amm_state.cpmm_program, amm_state.cpmm_pool_state).0,
                ErrorCode::InvalidPoolAccount
            );
            require!(
                quote_vault.key()
                    == crate::instructions::raydium::pool_vault_pda(&amm_state.cpmm_program, amm_state.cpmm_pool_state, amm_state.usdc_mint).0,
                ErrorCode::InvalidPoolAccount
            );
            require!(
                base_vault.key()
                    == crate::instructions::raydium::pool_vault_pda(&amm_state.cpmm_program, amm_state.cpmm_pool_state, amm_state.afho_mint).0,
                ErrorCode::InvalidPoolAccount
            );
            super::raydium::read_cpmm_price_floor(
                pool_state,
                observation,
                base_vault,
                quote_vault,
                &amm_state.afho_mint,
                &amm_state.usdc_mint,
                clock.unix_timestamp as u64,
            )
            .ok_or(ErrorCode::InvalidOracle)?
    };
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
    let cleared = (offer.total_offered - offer.remaining) as u64;
    (cleared * 100 / offer.total_offered as u64).min(100) as u8
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
    #[msg("CPMM pool account mismatch")]
    InvalidPoolAccount,
    #[msg("CPMM pool not pinned — run set_cpmm_pool")]
    PoolNotPinned,
}