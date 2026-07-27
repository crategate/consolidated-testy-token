use crate::state::offersState::{AcceptedOffers, AmmState, Offer, OfferList};
use anchor_lang::prelude::*;

// Fires off at beginning of each trade day.

#[derive(Accounts)]
pub struct CalcCompletedOffers<'info> {
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
    /// CHECK: market status PDA, same verification as MakeOffers
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"accepted_offers", amm_state.nyseh_mint.as_ref()], bump)]
    pub accepted_offers: Account<'info, AcceptedOffers>,
}

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

    let offer_list = &ctx.accounts.offer_list;
    let big_pct = pct_accepted(&offer_list.big_offer);
    let med_pct = pct_accepted(&offer_list.med_offer);
    let sml_pct = pct_accepted(&offer_list.sml_offer);

    update_offer_sheet_records(&mut ctx.accounts.accepted_offers, big_pct, med_pct, sml_pct);

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
