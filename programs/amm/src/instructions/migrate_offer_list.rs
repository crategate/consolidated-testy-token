//! One-time offer_list account resize for the devnet-big layout widening.
//!
//! `Offer.remaining`/`total_offered` went u8 → u32, so the zero-copy
//! `OfferList` struct grew from 72 to 96 bytes (80 → 104 with the account
//! discriminator). A live offer_list account from before the widening is TOO
//! SMALL for the zero-copy `Account<OfferList>` load — which runs BEFORE any
//! account constraints — so the resize must happen in an instruction that
//! treats the account as a raw AccountInfo and never typed-loads it. That is
//! this instruction. Idempotent: no-op once the account is the current size.
//!
//! DEVNET/TEST ONLY — remove before mainnet (same pattern as load_test_data).
//! Authority-gated; the keeper can never call this.

use crate::state::offersState::{AmmState, OfferList};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct MigrateOfferList<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
        has_one = authority,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
    /// CHECK: seeds-verified; resized in place below, never typed-loaded here
    /// (a pre-widening account is too small for the zero-copy deserializer).
    #[account(
        mut,
        seeds = [b"offer_list", amm_state.afho_mint.as_ref()],
        bump
    )]
    pub offer_list: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MigrateOfferList>) -> Result<()> {
    let needed = 8 + std::mem::size_of::<OfferList>();
    let info = &ctx.accounts.offer_list;
    if info.data_len() >= needed {
        msg!(
            "offer_list already at {} bytes — no migration needed",
            info.data_len()
        );
        return Ok(());
    }
    let rent = Rent::get()?;
    let lamports_needed = rent
        .minimum_balance(needed)
        .saturating_sub(info.lamports());
    if lamports_needed > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: info.clone(),
                },
            ),
            lamports_needed,
        )?;
    }
    let before = info.data_len();
    info.realloc(needed, false)?;
    msg!("offer_list migrated {} -> {} bytes", before, info.data_len());
    Ok(())
}
