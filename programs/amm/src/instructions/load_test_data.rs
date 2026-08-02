use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics};
use anchor_lang::prelude::*;

// DEVNET/TEST ONLY — remove before mainnet (same pattern as crank test_set_state).
// Overwrites the metric history accounts so make_offers can be exercised without
// waiting weeks for real data. Authority-gated; the keeper can never call this.
#[derive(Accounts)]
pub struct LoadTestData<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"amm_state", amm_state.nyseh_mint.as_ref()],
        bump = amm_state.bump,
        has_one = authority,
    )]
    pub amm_state: Account<'info, AmmState>,
    #[account(mut, seeds = [b"metrics", amm_state.nyseh_mint.as_ref()], bump)]
    pub metrics: Account<'info, MarketMetrics>,
    #[account(mut, seeds = [b"accepted_offers", amm_state.nyseh_mint.as_ref()], bump)]
    pub accepted_offers: Account<'info, AcceptedOffers>,
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

    msg!("test data loaded into metrics + accepted_offers");
    Ok(())
}
