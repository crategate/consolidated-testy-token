use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::constants::*;
use crate::error::*;
use crate::instructions::*;
use crate::state::*;
use crate::BuyBackVault;

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    // initialize the POSR vault
    // during minting, % of coins will get stored here

    // Needs accounts to hold sol and USDC which holds proceeds from the bulk AMM sales
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"back_vault", owner.key().as_ref()],
        bump
    )]
    pub bb_vault: Account<'info, BuyBackVault>,

    #[account(mint::token_program=token_program)]
    pub sol_vault: InterfaceAccount<'info, Mint>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
