use anchor_lang::prelude::*;

pub fn lot_sizer(tier: u8) -> u32 {
    match tier {
        0 => 0,
        1 => 10,
        2 => 25,
        3 => 50,
        4 => 100,
        5 => 250,
        6 => 500,
        7 => 750,
        8 => 1000,
        9 => 2500,
        10 => 5000,
        11 => 7500,
        12 => 10000,
        13 => 15000,
        14 => 20000,
        15 => 50000,
        16 => 100000,
        17 => 250000,
        18 => 500000,
        19 => 1000000,
        20 => 2500000,
        21 => 5000000,
        _ => 0,
    }
}
// each individual offer has index
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Offer {
    pub lot_size: u8, // size in whole NYSEH tokens, 50, 100, 500, 1000, 5k, 10k, translated
    // with "lot sizer" function
    pub vesting_days: u8, // how many trading days to unlock
    pub discount_bps: u8, // % bps discount from live DEX prices,
    //                      (tenth percent resolution so 115 = 11.5%)
    pub remaining: u8,     // how how many units remained offered today
    pub total_offered: u8, // how many total of this offer to start with
}

#[derive(InitSpace)]
#[account(discriminator = 1)]
pub struct OfferList {
    pub owner: Pubkey,
    pub seed: u64,
    // Last trading day a sheet was constructed — make_offers' idempotency
    // guard (metrics accounts are read-only to make_offers).
    pub day_index: u64,

    pub big_offer: Offer,

    pub med_offer: Offer,

    pub sml_offer: Offer,
    pub total_complete: u32, // total whole NYSEH tokens sold

    pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct AmmState {
    pub authority: Pubkey,
    // Hot wallet allowed to fire daily crank-gated instructions (make_offers,
    // calc_completed_offers). Cannot move funds — those check authority only.
    // Defaults to authority at init; rotate via set_keeper for mainnet.
    pub keeper: Pubkey,
    pub nyseh_mint: Pubkey,
    pub usdc_mint: Pubkey,
    // big main vault, initial supply and where fees/buybacks go
    pub nyseh_vault: Pubkey,

    // used for buybacks executed every trading day (following successful Offer Takes at night)
    pub sol_vault: Pubkey,
    pub usdc_vault: Pubkey,

    // buyback balances for dips (10% allocated from each Offer sale/completion)
    pub sol_dip: Pubkey,
    pub usdc_dip: Pubkey,

    pub offer_list: Pubkey,
    pub accepted_offers: Pubkey,
    pub market_status_pda: Pubkey,
    pub crank_program: Pubkey,
    // Canonical Switchboard quote account covering [market_status, price] feeds.
    // Only the AMM consumes the price feed, so the address lives here.
    pub price_oracle: Pubkey,

    pub total_sol_proceeds: u64,
    pub total_usdc_proceeds: u64,

    // AMM never offers bulk deals with price per share lower than this
    pub highest_buyback_basis: u64,

    pub bump: u8,
    pub sol_vault_bump: u8,
}

// update beginning of trading day plz
#[account]
#[derive(InitSpace)]
pub struct AcceptedOffers {
    pub day_index: u64, // last trading day this was recorded, prevents double-record
    pub big_offers_accepted: [u8; 5], // stored as whole number % (0-100), last 5 offer instances
    // should be 0 for days when no offers were available (bear cycle)
    pub med_offers_accepted: [u8; 5],
    pub sml_offers_accepted: [u8; 5],
}
#[account]
#[derive(InitSpace)]
pub struct MarketMetrics {
    pub day_index: u64,
    // Daily priceChange24h from the price oracle, centi-percent (1.29% -> 129),
    // written once per trading day by make_offers. Ring buffer, 20 trading days.
    pub price_changes: [i16; 20],
    pub sample_head: u8, // next write index into price_changes
    pub treasury_sol: u64,
    pub total_staked: u64,
    pub total_supply: u64,
    pub trailing_stake_health: [u8; 5], // used to calculate stake health, simple whole number %
}
