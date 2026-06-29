use core::str;

use anchor_lang::prelude::*;

// each individual offer has index
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Offer {
    pub owner: Pubkey,

    pub lot_size: u8,     // size in whole NYSEH tokens, 50, 100, 500, 1000, 5k, 10k
    pub vesting_days: u8, // how many trading days to unlock
    pub discount: u8,     // % bps discount from live DEX prices
    pub remaining: u16,   // how how many units remained offered today
}

#[derive(InitSpace)]
#[account(discriminator = 1)]
pub struct OfferList {
    pub owner: Pubkey,
    pub seed: u64,

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
    pub nyseh_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub sol_vault: Pubkey,
    pub usdc_vault: Pubkey,
    pub nyseh_vault: Pubkey,
    pub offer_list: Pubkey,
    pub market_status_pda: Pubkey,
    pub crank_program: Pubkey,
    pub total_sol_rn: u64,
    pub total_usdc_proceeds: u64,
    pub bump: u8,
    pub sol_vault_bump: u8,
}
