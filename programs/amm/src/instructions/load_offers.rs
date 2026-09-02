//! Developer-only offer-sheet loader.
//!
//! `load_offers` posts a realistic three-tier offer sheet straight into the
//! offer desk so the web UI and `offer_claim` can be exercised on devnet
//! without waiting for a real end-of-day `make_offers` run. It differs from
//! `load_test_data` in one important way: it stamps `offer_list.day_index`
//! with the CURRENT market-status trading day, so the sheet is claimable
//! tonight — exactly like a sheet produced by `make_offers`.
//!
//! The tier terms (lot tier / discount / vesting) are the average sheet the
//! combinator emits in a flat, healthy market (momentum ~5000, stake_health
//! ~40, moderate demand) — the "chop/flat" row of sim/mc_sweep.py. The
//! ratchet floor is anchored to the LIVE devnet pool price (CPMM when pinned,
//! mock spot oracle otherwise): floor = 80% of live, which sits below the
//! deepest listed discount so every seeded discount executes in full.
//!
//! DEVNET/TEST ONLY — remove before mainnet (same pattern as `load_test_data`).
//! Authority-gated; the keeper can never call this.

use anchor_lang::prelude::*;

use crate::state::offersState::{AmmState, Offer, OfferList};

use super::offer_claim::{read_live_price, require_pinned_pricing_accounts};
use super::raydium::read_cpmm_price_floor;

// Average tier terms for a flat, healthy market (momentum ~5000,
// stake_health ~40, moderate demand — the "chop/flat" row of sim/mc_sweep.py).
// `discount_bps` is tenths of a percent (90 = 9.0%); `lot_size` is an index
// into `lot_sizer`. Tiers ride the vault-scaled ladder (see
// make_offers::lot_tiers): for a ~750M-token devnet vault the chop/flat sheet
// lands at tiers 19/16/13 (1M / 100k / 15k AFHO per lot).
const SML_OFFER: Offer = Offer {
    lot_size: 13,
    vesting_days: 5,
    discount_bps: 60, // 6.0%
    _pad: 0,
    remaining: 10,
    total_offered: 10,
};
const MED_OFFER: Offer = Offer {
    lot_size: 16,
    vesting_days: 9,
    discount_bps: 75, // 7.5%
    _pad: 0,
    remaining: 5,
    total_offered: 5,
};
const BIG_OFFER: Offer = Offer {
    lot_size: 19,
    vesting_days: 18,
    discount_bps: 90, // 9.0%
    _pad: 0,
    remaining: 3,
    total_offered: 3,
};

// Ratchet floor as a fraction of the live pool price. 80% is comfortably
// below the deepest seeded discount (big = 91.0% of live), so the floor never
// clamps a listed discount while still showing a realistic prior buyback basis.
const FLOOR_LIVE_PERCENT: u64 = 80;

#[derive(Accounts)]
pub struct LoadOffers<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
        has_one = authority,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.afho_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Box<Account<'info, OfferList>>,

    /// Market-status PDA — supplies the current trading day so the seeded
    /// sheet is fresh (claimable tonight). Not gated on market state: this is
    /// a dev tool and may run any time.
    /// CHECK: seeds-verified against the crank program stored at init.
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// Absolute-price mock oracle — fallback when the CPMM pool is NOT pinned.
    /// CHECK: address-verified against amm_state.spot_oracle.
    #[account(address = amm_state.spot_oracle)]
    pub spot_oracle: UncheckedAccount<'info>,

    // Raydium CPMM AFHO/USDC pricing accounts — live price source when the
    // pool is pinned (mirrors offer_claim). Omitted in mock/localnet mode.
    /// CHECK: validated against amm_state.cpmm_pool_state when pinned.
    pub cpmm_pool_state: Option<AccountInfo<'info>>,
    /// CHECK: validated as the pool's observation PDA when pinned.
    pub cpmm_observation: Option<AccountInfo<'info>>,
    /// CHECK: validated as the pool's USDC vault PDA when pinned (quote leg).
    pub cpmm_input_vault: Option<AccountInfo<'info>>,
    /// CHECK: validated as the pool's AFHO vault PDA when pinned (base leg).
    pub cpmm_output_vault: Option<AccountInfo<'info>>,
}

pub fn handler(ctx: Context<LoadOffers>) -> Result<()> {
    let amm_state = &mut ctx.accounts.amm_state;
    let offer_list = &mut ctx.accounts.offer_list;
    // ── Current trading day from the crank's market-status PDA ──
    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) + trading_day_index(8)
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(
        market_data.len() >= 25,
        crate::instructions::make_offers::ErrorCode::InvalidMarketStatus
    );
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());

    // ── Live price: CPMM pool when pinned, mock spot oracle otherwise ──
    let pinned = amm_state.cpmm_pool_state != Pubkey::default();
    require_pinned_pricing_accounts(
        pinned,
        amm_state.cpmm_program,
        amm_state.cpmm_pool_state,
        &amm_state.afho_mint,
        &amm_state.usdc_mint,
        ctx.accounts.cpmm_pool_state.as_ref(),
        ctx.accounts.cpmm_observation.as_ref(),
        ctx.accounts.cpmm_output_vault.as_ref(), // base leg (AFHO)
        ctx.accounts.cpmm_input_vault.as_ref(),  // quote leg (USDC)
    )?;
    let now = Clock::get()?.unix_timestamp as u64;
    let live_price = if pinned {
        read_cpmm_price_floor(
            ctx.accounts.cpmm_pool_state.as_ref().unwrap(),
            ctx.accounts.cpmm_observation.as_ref().unwrap(),
            ctx.accounts.cpmm_output_vault.as_ref().unwrap(),
            ctx.accounts.cpmm_input_vault.as_ref().unwrap(),
            &amm_state.afho_mint,
            &amm_state.usdc_mint,
            now,
        )
    } else {
        Some(read_live_price(&ctx.accounts.spot_oracle)?)
    };

    // ── Post the sheet (always succeeds — the sheet is the point of this ix) ──
    offer_list.sml_offer = SML_OFFER;
    offer_list.med_offer = MED_OFFER;
    offer_list.big_offer = BIG_OFFER;
    offer_list.day_index = current_day;

    // ── Anchor the ratchet floor to the live price so the seeded discounts
    // execute in full (a stale high floor would otherwise clamp them). ──
    match live_price {
        Some(p) if p > 0 => {
            amm_state.highest_buyback_basis = p.saturating_mul(FLOOR_LIVE_PERCENT) / 100;
            msg!(
                "live price {} (floor units) -> highest_buyback_basis {} ({}% of live)",
                p,
                amm_state.highest_buyback_basis,
                FLOOR_LIVE_PERCENT
            );
        }
        _ => {
            msg!("no live price available — highest_buyback_basis left unchanged");
        }
    }

    msg!(
        "offer sheet loaded for trading day {}: big {}/{} @tier {} {}bps {}d | med {}/{} @tier {} {}bps {}d | sml {}/{} @tier {} {}bps {}d",
        current_day,
        offer_list.big_offer.remaining,
        offer_list.big_offer.total_offered,
        offer_list.big_offer.lot_size,
        offer_list.big_offer.discount_bps,
        offer_list.big_offer.vesting_days,
        offer_list.med_offer.remaining,
        offer_list.med_offer.total_offered,
        offer_list.med_offer.lot_size,
        offer_list.med_offer.discount_bps,
        offer_list.med_offer.vesting_days,
        offer_list.sml_offer.remaining,
        offer_list.sml_offer.total_offered,
        offer_list.sml_offer.lot_size,
        offer_list.sml_offer.discount_bps,
        offer_list.sml_offer.vesting_days,
    );
    Ok(())
}
