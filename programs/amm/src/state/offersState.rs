use anchor_lang::prelude::*;

// each individual offer has index
#[account]
pub struct Offer {
    pub lot_size: u8,     // size in whole NYSEH tokens, 50, 100, 500, 1000, 5k, 10k
    pub vesting_days: u8, // how many trading days to unlock
    pub discount: u8,     // % bps discount from live DEX prices
    pub index: u64,
}
#[account]
pub struct OfferList {
    pub owner: Pubkey,
    pub big_offer: Offer,
    pub big_amount: u16, // number of this Offer remaining
    pub med_offer: Offer,
    pub med_amount: u16,
    pub sml_offer: Offer,
    pub sml_amount: u16,
    pub total_complete: u32, // total whole NYSEH tokens sold
}
