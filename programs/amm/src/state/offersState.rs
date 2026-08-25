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
    pub lot_size: u8, // size in whole AFHO tokens, 50, 100, 500, 1000, 5k, 10k, translated
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
    pub total_complete: u32, // total whole AFHO tokens sold

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
    pub afho_mint: Pubkey,
    pub usdc_mint: Pubkey,
    // big main vault, initial supply and where fees/buybacks go
    pub afho_vault: Pubkey,

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

    // Pool program dex_buyback CPIs for buybacks. Stub/mock on devnet;
    // point at the real DEX pool program at launch.
    pub dex_program: Pubkey,

    // Raydium CPMM pool pinning (Path A swap adapter). Pubkey::default() while
    // the mock is in use; set via set_cpmm_pool once the real pool exists. The
    // vaults and authority are derived on-chain from these + the mints.
    pub cpmm_pool_state: Pubkey,
    pub cpmm_amm_config: Pubkey,
    // The CPMM program itself (CPI target for the swap adapter). Distinct from
    // dex_program, which the mock uses — the mock pool_state seeds constraint
    // depends on it staying the mock program.
    pub cpmm_program: Pubkey,
    // Second pool (Raydium SOL/USDC CPMM) used to convert SOL bond payments
    // to USDC at claim time (All-USDC route). Pinned via set_sol_usdc_pool.
    pub cpmm_sol_usdc_pool: Pubkey,
    pub cpmm_sol_usdc_config: Pubkey,

    // Buyback day schedule. Budget snapshots the vault balances at the first
    // buyback call of a trading day; unspent budget just stays in the vaults
    // and rolls into the next day with fills (no bookkeeping needed for that).
    pub bb_day_index: u64,
    pub bb_budget_usdc: u64,
    pub bb_spent_usdc: u64,
    pub bb_budget_sol: u64,
    pub bb_spent_sol: u64,
    pub bb_slice_count: u16,
    pub bb_last_slot: u64,

    // Ratchet decay: consecutive trading days with no offers taken. After
    // FLOOR_LOCK_GRACE_DAYS straight, highest_buyback_basis decays toward the
    // live price (calc_completed_offers). Reset to 0 by any fill.
    pub untaken_days: u16,

    // Absolute-price oracle read by offer_claim / calc_completed_offers
    // (raw-u64 mock PDA on devnet; real DEX/oracle adapter at mainnet).
    // Distinct from price_oracle, which is the Switchboard [status, price]
    // quote carrying the 24h price CHANGE for metrics.
    pub spot_oracle: Pubkey,

    // Staking pool the offer desk CPIs into (purchased AFHO vest here;
    // the daily staker share is deposited here after conversion).
    pub staking_pool: Pubkey,

    // Holding vault for the stakers' 10% share of USDC proceeds. Accumulates
    // per claim; distribute_staker_rewards converts it to AFHO and deposits
    // into the staking reward vault once per trading day.
    pub usdc_rewards: Pubkey,
    // Idempotency guard for distribute_staker_rewards.
    pub rewards_day_index: u64,

    // SOL/USD price oracle (same raw-u64 mock-PDA pattern as spot_oracle;
    // real SOL/USD feed at mainnet). Prices SOL-denominated offer claims and
    // converts SOL-leg swap fills into USDC units for the ratchet floor.
    pub sol_oracle: Pubkey,
    // Holding vault (system PDA) for the stakers' 10% share of SOL proceeds —
    // swapped to AFHO by distribute_staker_rewards alongside usdc_rewards.
    pub sol_rewards: Pubkey,

    // Buy-the-dip day schedule (mirrors bb_*): dip-reserve snapshot at the
    // first dip call of a trading day; the day's slices are capped at
    // DAY_CAP of the snapshot and paced by dip_last_slot.
    pub dip_day_index: u64,
    pub dip_day_usdc: u64,
    pub dip_day_sol: u64,
    pub dip_spent_usdc: u64,
    pub dip_spent_sol: u64,
    pub dip_last_slot: u64,
    pub dip_slice_count: u16,
    pub sol_dip_bump: u8,

    pub bump: u8,
    pub sol_vault_bump: u8,
    pub sol_rewards_bump: u8,
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

    // High-frequency spot-price ring (floor units: usdc_raw x 1e6 / afho_raw),
    // self-sampled by buy_the_dip (throttled to one sample per SPOT_SAMPLE_SLOTS).
    // This — not the 24h change feed — is the dip trigger's reference: a dip is
    // the live spot price sitting below the recent mean of this ring. 0 = empty.
    pub spot_prices: [u64; 32],
    pub spot_head: u8, // next write index into spot_prices
    pub spot_last_slot: u64,
    // Most recent end-of-day absolute close (floor units). Used to compute the
    // daily change into price_changes (close→close). 0 = no baseline yet.
    pub daily_close: u64,
}