use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, OfferList};
use anchor_lang::prelude::*;

// DEVNET/TEST ONLY — remove before mainnet (same pattern as crank test_set_state
// and amm load_test_data). Authority-gated full wipe of the protocol's RUNTIME
// counters/history back to a fresh zero state:
//   - metrics: day_index, price_changes ring + sample_head, spot ring,
//     stake-health ring, staked/supply snapshots, daily_close
//   - accepted_offers: day_index + 3×5-day fill rings
//   - offer_list: day_index, total_complete, and every tier's terms + counts
//   - amm_state: proceeds, ratchet floor, buyback/dip/rewards day budgets
//
// Pinned CONFIG is preserved (authority, keeper, mint/vault/pubkey pins, pool
// pins, staking_pool) so the desk still works after a reset without re-running
// set-pools. Vault/pool token balances are NOT moved or burned — only the
// bookkeeping that the dash/charts read is zeroed.
#[derive(Accounts)]
pub struct ResetDevnetState<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
        has_one = authority,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
    #[account(mut, seeds = [b"metrics", amm_state.afho_mint.as_ref()], bump)]
    pub metrics: Box<Account<'info, MarketMetrics>>,
    #[account(mut, seeds = [b"accepted_offers", amm_state.afho_mint.as_ref()], bump)]
    pub accepted_offers: Box<Account<'info, AcceptedOffers>>,
    #[account(
        mut,
        seeds = [b"offer_list", amm_state.afho_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Box<Account<'info, OfferList>>,
}

fn reset_offer(o: &mut crate::state::offersState::Offer) {
    o.lot_size = 0;
    o.vesting_days = 0;
    o.discount_bps = 0;
    o.remaining = 0;
    o.total_offered = 0;
}

pub fn handler(ctx: Context<ResetDevnetState>) -> Result<()> {
    let m = &mut ctx.accounts.metrics;
    m.day_index = 0;
    m.treasury_sol = 0;
    m.total_staked = 0;
    m.total_supply = 0;
    m.spot_last_slot = 0;
    m.daily_close = 0;
    m.spot_prices = [0u64; 32];
    m.price_changes = [0i16; 20];
    m.sample_head = 0;
    m.spot_head = 0;
    m.trailing_stake_health = [0u8; 5];

    let a = &mut ctx.accounts.accepted_offers;
    a.day_index = 0;
    a.big_offers_accepted = [0u8; 5];
    a.med_offers_accepted = [0u8; 5];
    a.sml_offers_accepted = [0u8; 5];

    let s = &mut ctx.accounts.amm_state;
    s.total_sol_proceeds = 0;
    s.total_usdc_proceeds = 0;
    s.highest_buyback_basis = 0;
    s.bb_day_index = 0;
    s.bb_budget_usdc = 0;
    s.bb_spent_usdc = 0;
    s.bb_budget_sol = 0;
    s.bb_spent_sol = 0;
    s.bb_last_slot = 0;
    s.rewards_day_index = 0;
    s.dip_day_index = 0;
    s.dip_day_usdc = 0;
    s.dip_day_sol = 0;
    s.dip_spent_usdc = 0;
    s.dip_spent_sol = 0;
    s.dip_last_slot = 0;
    s.bb_slice_count = 0;
    s.untaken_days = 0;
    s.dip_slice_count = 0;

    let o = &mut ctx.accounts.offer_list;
    o.day_index = 0;
    o.total_complete = 0;
    reset_offer(&mut o.big_offer);
    reset_offer(&mut o.med_offer);
    reset_offer(&mut o.sml_offer);

    msg!("devnet state reset: metrics, accepted_offers, offer_list, amm bookkeeping zeroed");
    Ok(())
}
