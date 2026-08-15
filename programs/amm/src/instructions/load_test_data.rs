use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, OfferList};
use anchor_lang::prelude::*;

// DEVNET/TEST ONLY — remove before mainnet (same pattern as crank test_set_state).
// Overwrites the metric history accounts so make_offers can be exercised without
// waiting weeks for real data. Authority-gated; the keeper can never call this.
#[derive(Accounts)]
pub struct LoadTestData<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.nyseh_mint.as_ref()],
        bump = amm_state.bump,
        has_one = authority,
    )]
    pub amm_state: Account<'info, AmmState>,
    #[account(mut, seeds = [b"metrics", amm_state.nyseh_mint.as_ref()], bump)]
    pub metrics: Account<'info, MarketMetrics>,
    #[account(mut, seeds = [b"accepted_offers", amm_state.nyseh_mint.as_ref()], bump)]
    pub accepted_offers: Account<'info, AcceptedOffers>,
    #[account(
        mut,
        seeds = [b"offer_list", amm_state.nyseh_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Account<'info, OfferList>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TestMetrics {
    // Ring of daily priceChange24h in centi-percent, oldest -> newest.
    pub price_changes: [i16; 20],
    pub sample_head: u8, // next write slot = oldest entry; 0 with a full ring
    pub trailing_stake_health: [u8; 5],
    // total_staked/total_supply only overwritten when total_supply > 0
    pub total_staked: u64,
    pub total_supply: u64,
    pub big_accepted: [u8; 5],
    pub med_accepted: [u8; 5],
    pub sml_accepted: [u8; 5],
    // Ratchet-decay test knobs. buyback_basis only overwritten when > 0.
    pub buyback_basis: u64,
    pub untaken_days: u16,
    // Offer sheet writes (total_offered/remaining per tier) — always applied,
    // so tests can clear a sheet by passing zeros.
    pub big_offered: u8,
    pub big_remaining: u8,
    pub med_offered: u8,
    pub med_remaining: u8,
    pub sml_offered: u8,
    pub sml_remaining: u8,
}

pub fn handler(ctx: Context<LoadTestData>, data: TestMetrics) -> Result<()> {
    let metrics = &mut ctx.accounts.metrics;
    metrics.price_changes = data.price_changes;
    metrics.sample_head = data.sample_head;
    metrics.trailing_stake_health = data.trailing_stake_health;
    if data.total_supply > 0 {
        metrics.total_staked = data.total_staked;
        metrics.total_supply = data.total_supply;
    }

    let accepted = &mut ctx.accounts.accepted_offers;
    accepted.big_offers_accepted = data.big_accepted;
    accepted.med_offers_accepted = data.med_accepted;
    accepted.sml_offers_accepted = data.sml_accepted;

    let amm_state = &mut ctx.accounts.amm_state;
    if data.buyback_basis > 0 {
        amm_state.highest_buyback_basis = data.buyback_basis;
    }
    amm_state.untaken_days = data.untaken_days;

    let offer_list = &mut ctx.accounts.offer_list;
    offer_list.big_offer.total_offered = data.big_offered;
    offer_list.big_offer.remaining = data.big_remaining;
    offer_list.med_offer.total_offered = data.med_offered;
    offer_list.med_offer.remaining = data.med_remaining;
    offer_list.sml_offer.total_offered = data.sml_offered;
    offer_list.sml_offer.remaining = data.sml_remaining;

    msg!("test data loaded into metrics + accepted_offers");
    Ok(())
}
