// programs/amm/src/instructions/offerClaim.rs

use crate::state::offersState::{AmmState, Offer, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[derive(Accounts)]
#[instruction(tier: u8, amount: u16)]
pub struct OfferClaim<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"amm_state", amm_state.nyseh_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.nyseh_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Box<Account<'info, OfferList>>,

    pub nyseh_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Live DEX price oracle (same as make_offers uses)
    pub price_oracle: UncheckedAccount<'info>,

    /// Buyer's payment in USDC
    #[account(mut, token::mint = amm_state.usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    /// AMM's USDC vault (proceeds)
    #[account(mut, address = amm_state.usdc_vault)]
    pub amm_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Source: AMM's NYSEH reserve
    #[account(mut, address = amm_state.nyseh_vault)]
    pub amm_nyseh_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Where purchased NYSEH goes (buyer's ATA, then into staking position)
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = nyseh_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_nyseh: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: CPI into staking program to create locked position
    pub staking_program: AccountInfo<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OfferClaim>, tier: u8, units: u8) -> Result<()> {
    let amm_state = &mut ctx.accounts.amm_state;
    let offer_list = &mut ctx.accounts.offer_list;

    // ── Select tier ──
    let mut offer = match tier {
        0 => offer_list.sml_offer,
        1 => offer_list.med_offer,
        2 => offer_list.big_offer,
        _ => return err!(ErrorCode::InvalidTier),
    };

    require!(offer.remaining >= units, ErrorCode::InsufficientOffer);
    require!(units > 0, ErrorCode::ZeroAmount);

    // ── Compute live price with discount ──
    let live_price = read_live_price(&ctx.accounts.price_oracle)?;
    let discount = (live_price * offer.discount_bps as u64) / 10000;
    let mut effective_price = live_price.saturating_sub(discount);

    // ── RATCHET: Never sell below highest realized buyback basis ──
    if amm_state.highest_buyback_basis > 0 {
        effective_price = effective_price.max(amm_state.highest_buyback_basis);
        msg!(
            "Ratchet active: floor {} vs discounted {}",
            amm_state.highest_buyback_basis,
            live_price - discount
        );
    }

    let total_nyseh = (offer.lot_size as u64) * (units as u64);
    let total_cost = total_nyseh * effective_price; // adjust for decimals in practice

    // ── Transfer USDC from buyer to AMM ──
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.buyer_usdc.to_account_info(),
        mint: ctx.accounts.usdc_mint.to_account_info(), // need to add usdc_mint to accounts
        to: ctx.accounts.amm_usdc_vault.to_account_info(),
        authority: ctx.accounts.buyer.to_account_info(),
    };
    // ... execute transfer ...

    // ── Transfer NYSEH from AMM vault to buyer (then immediately CPI to stake) ──
    // Use PDA signer for amm_nyseh_vault
    // ...

    // ── Update offer remaining ──

    offer.remaining -= units;
    offer_list.total_complete += units as u32;

    // ── CPI into staking program to create locked position ──
    // This is the key: purchased tokens go DIRECTLY into a StakePosition
    // with days_to_unlock = offer.vesting_days
    // invoke_signed with staking program's create_amm_position...

    msg!(
        "Claimed {} NYSEH at {} ({}% off, floor: {})",
        total_nyseh,
        effective_price,
        offer.discount_bps / 100,
        amm_state.highest_buyback_basis
    );

    Ok(())
}

fn read_live_price(price_oracle: &AccountInfo) -> Result<u64> {
    let data = price_oracle.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidOracle);
    Ok(u64::from_le_bytes(data[0..8].try_into().unwrap()))
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid tier")]
    InvalidTier,
    #[msg("Insufficient offer remaining")]
    InsufficientOffer,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Invalid price oracle")]
    InvalidOracle,
}
