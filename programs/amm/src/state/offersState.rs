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
        // devnet-big: tier 22 (10M tokens) is the ladder TOP — a full 1B-token
        // vault (the supply cap) places its 1% ceiling tier exactly here, so
        // the vault-scale window never pins below the top at any reachable
        // vault size. Tiers above this were dead headroom: t_hat ≥ 23 needs
        // a vault ≥ 2.5B tokens, past the 1B supply cap.
        22 => 10_000_000,
        _ => 0,
    }
}

// NOTE: the account structs below are zero-copy (`#[account(zero_copy)]`).
// bytemuck::Pod requires a padding-free layout, so fields are ordered align 8
// (u64) -> align 2 (u16) -> align 1 (u8 / Pubkey) and tail-padded to a multiple
// of 8. The zero-copy AccountDeserialize is a memcpy (not borsh); we keep the
// borsh-style `Account<T>` wrappers in the instruction contexts, so all the
// `seeds` / `address` / `has_one` / `bump` constraints still work unchanged.
// We only supply the missing `AccountSerialize` (also a memcpy) below.

// each individual offer has index
#[repr(C)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Offer {
    pub lot_size: u8, // size in whole AFHO tokens, 50, 100, 500, 1000, 5k, 10k, translated
    // with "lot sizer" function
    pub vesting_days: u8, // how many trading days to unlock
    pub discount_bps: u8, // % bps discount from live DEX prices,
    //                      (tenth percent resolution so 115 = 11.5%)
    pub _pad: u8, // explicit pad: keeps the u32 fields 4-aligned with no
    //              implicit padding (bytemuck rejects implicit padding)
    pub remaining: u32, // how how many units remained offered today
    pub total_offered: u32, // how many total of this offer to start with
}

#[account(zero_copy)]
pub struct OfferList {
    pub owner: Pubkey,
    pub seed: u64,
    // Last trading day a sheet was constructed — make_offers' idempotency
    // guard (metrics accounts are read-only to make_offers).
    pub day_index: u64,
    pub total_complete: u32, // total whole AFHO tokens sold
    pub bump: u8,
    // pad: big_offer must start 4-aligned (Offer holds u32s; bytemuck rejects
    // implicit padding, so this is explicit).
    pub _align: [u8; 3],
    pub big_offer: Offer,
    pub med_offer: Offer,
    pub sml_offer: Offer,
    // tail pad: struct stays a multiple of 8 for the zero-copy memcpy layout
    // (disc(8) + 96-byte struct = 104-byte account).
    pub _pad: [u8; 4],
}

#[account(zero_copy)]
pub struct AmmState {
    // --- align 8 (u64) block ---
    pub total_sol_proceeds: u64,
    pub total_usdc_proceeds: u64,
    // AMM never offers bulk deals with price per share lower than this
    // (ratchet floor, moves up via fills, decays down via calc_completed_offers).
    pub highest_buyback_basis: u64,
    // Buyback day schedule. Budget snapshots the vault balances at the first
    // buyback call of a trading day; unspent budget just stays in the vaults
    // and rolls into the next day with fills (no bookkeeping needed).
    pub bb_day_index: u64,
    pub bb_budget_usdc: u64,
    pub bb_spent_usdc: u64,
    pub bb_budget_sol: u64,
    pub bb_spent_sol: u64,
    pub bb_last_slot: u64,
    // Idempotency guard for distribute_staker_rewards.
    pub rewards_day_index: u64,
    // Buy-the-dip day schedule (mirrors bb_*): dip-reserve snapshot at the
    // first dip call of a trading day; the day's slices are capped at
    // DAY_CAP of the snapshot and paced by dip_last_slot.
    pub dip_day_index: u64,
    pub dip_day_usdc: u64,
    pub dip_day_sol: u64,
    pub dip_spent_usdc: u64,
    pub dip_spent_sol: u64,
    pub dip_last_slot: u64,
    // --- align 2 (u16) block ---
    pub bb_slice_count: u16,
    // Ratchet decay: consecutive trading days with no offers taken. After
    // FLOOR_LOCK_GRACE_DAYS straight, highest_buyback_basis decays toward the
    // live price. Reset to 0 by any fill.
    pub untaken_days: u16,
    pub dip_slice_count: u16,
    // --- align 1 (u8) block ---
    pub sol_dip_bump: u8,
    pub bump: u8,
    pub sol_vault_bump: u8,
    pub sol_rewards_bump: u8,
    pub _pad: [u8; 6],
    // --- align 1 (Pubkey) block ---
    pub authority: Pubkey,
    // Hot wallet allowed to fire the daily crank-gated instructions
    // (make_offers, calc_completed_offers, dex_buyback, buy_the_dip,
    // distribute_staker_rewards). Pool pinning is authority-only.
    pub keeper: Pubkey,
    pub afho_mint: Pubkey,
    pub usdc_mint: Pubkey,
    // big main vault, initial supply and where fees/buybacks go
    pub afho_vault: Pubkey,
    // Vestigial SOL buyback PDA (SOL legs retired — USDC-only swaps; kept
    // until the §4 state-field cleanup lands).
    pub sol_vault: Pubkey,
    pub usdc_vault: Pubkey,
    // Vestigial SOL dip PDA (10% SOL dip leg retired; §4 cleanup).
    pub sol_dip: Pubkey,
    pub usdc_dip: Pubkey,
    pub offer_list: Pubkey,
    pub accepted_offers: Pubkey,
    pub market_status_pda: Pubkey,
    pub crank_program: Pubkey,
    // Legacy Switchboard quote slot — pinned but never read (momentum comes
    // from the self-sampled pool-price ring). §4 cleanup candidate.
    pub price_oracle: Pubkey,
    // Pool program dex_buyback CPIs for buybacks. Stub/mock on devnet;
    // point at the real DEX pool program at launch.
    pub dex_program: Pubkey,
    // Raydium CPMM pool pinning (swap adapter). Pubkey::default() while the
    // mock is in use; set via set_cpmm_pool once the real pool exists.
    pub cpmm_pool_state: Pubkey,
    pub cpmm_amm_config: Pubkey,
    pub cpmm_program: Pubkey,
    // Second pool (Raydium SOL/USDC CPMM) used to convert SOL bond payments
    // to USDC at claim time (All-USDC route).
    pub cpmm_sol_usdc_pool: Pubkey,
    pub cpmm_sol_usdc_config: Pubkey,
    // Absolute-price oracle read by offer_claim / calc_completed_offers
    // (raw-u64 mock PDA on devnet; real DEX/oracle adapter at mainnet).
    pub spot_oracle: Pubkey,
    // Staking pool the offer desk CPIs into (purchased AFHO vest here).
    pub staking_pool: Pubkey,
    // Holding vault for the stakers' 10% share of USDC proceeds.
    pub usdc_rewards: Pubkey,
    // Vestigial SOL/USD price oracle (SOL legs retired; §4 cleanup).
    pub sol_oracle: Pubkey,
    // Vestigial holding PDA for the stakers' 10% SOL share (retired; §4 cleanup).
    pub sol_rewards: Pubkey,
}

// update beginning of trading day plz
#[account(zero_copy)]
pub struct AcceptedOffers {
    pub day_index: u64, // last trading day this was recorded, prevents double-record
    pub big_offers_accepted: [u8; 5], // stored as whole number % (0-100), last 5 offer instances
    // should be 0 for days when no offers were available (bear cycle)
    pub med_offers_accepted: [u8; 5],
    pub sml_offers_accepted: [u8; 5],
    pub _pad: [u8; 1],
}

#[account(zero_copy)]
pub struct MarketMetrics {
    pub day_index: u64,
    pub treasury_sol: u64,
    pub total_staked: u64,
    pub total_supply: u64,
    pub spot_last_slot: u64,
    // Most recent end-of-day absolute close (floor units). Used to compute the
    // daily change into price_changes (close→close). 0 = no baseline yet.
    pub daily_close: u64,
    // High-frequency spot-price ring (floor units: usdc_raw x 1e6 / afho_raw),
    // self-sampled by buy_the_dip (throttled to one sample per SPOT_SAMPLE_SLOTS).
    pub spot_prices: [u64; 32],
    // Daily close→close change, centi-percent (1.29% -> 129), written once per
    // trading day by update_tradeday_stats. Ring buffer, 20 trading days.
    pub price_changes: [i16; 20],
    pub sample_head: u8, // next write index into price_changes
    pub spot_head: u8,   // next write index into spot_prices
    // used to calculate stake health, simple whole number %
    pub trailing_stake_health: [u8; 5],
    pub _pad: [u8; 1],
}

// `#[account(zero_copy)]` provides AccountDeserialize (memcpy) but not
// AccountSerialize; `Account<T>` still requires the latter so the deserialized
// struct can be written back on exit. This memcpy is the serialization mirror.
macro_rules! impl_zero_copy_account_serialize {
    ($t:ty) => {
        impl anchor_lang::AccountSerialize for $t {
            fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> anchor_lang::Result<()> {
                if writer
                    .write_all(<$t as anchor_lang::Discriminator>::DISCRIMINATOR)
                    .is_err()
                {
                    return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                }
                if writer.write_all(bytemuck::bytes_of(self)).is_err() {
                    return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                }
                Ok(())
            }
        }
    };
}

impl_zero_copy_account_serialize!(OfferList);
impl_zero_copy_account_serialize!(AmmState);
impl_zero_copy_account_serialize!(AcceptedOffers);
impl_zero_copy_account_serialize!(MarketMetrics);
