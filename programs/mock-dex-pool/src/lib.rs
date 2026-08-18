// STUB "DEX pool" for localnet/devnet: a fixed-rate NYSEH dispenser.
// The caller (amm's dex_buyback) performs the in-leg transfer (USDC token
// transfer / SOL lamport transfer) itself, then CPIs send_nyseh for the
// out-leg. At launch this is replaced by a real DEX pool CPI — dex_buyback's
// adapter boundary is built so only that one function changes.
//  MAINNET change needed

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer, Mint, TokenAccount, TokenInterface, Transfer};

declare_id!("3fgSPE55km8DrbFPmyi7x3YRLmpQ8BYZHUUr85Miwbod");

// raw NYSEH (9 dec) dispensed per raw USDC (6 dec): 1 USDC -> 100 NYSEH (0.01 USDC/NYSEH)
pub const NYSEH_PER_USDC_RAW: u64 = 100_000;
// raw NYSEH per lamport: 1 SOL -> 10_000 NYSEH
pub const NYSEH_PER_SOL_RAW: u64 = 10_000;

#[program]
pub mod mock_dex_pool {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        ctx.accounts.pool_state.bump = ctx.bumps.pool_state;
        Ok(())
    }

    pub fn send_nyseh(ctx: Context<SendNyseh>, amount_in: u64, sol_in: bool) -> Result<()> {
        let mul = if sol_in {
            NYSEH_PER_SOL_RAW
        } else {
            NYSEH_PER_USDC_RAW
        };
        let out = (amount_in as u128 * mul as u128) as u64;
        let mint_key = ctx.accounts.nyseh_mint.key();
        let bump = ctx.accounts.pool_state.bump;
        let seeds: &[&[u8]] = &[b"mock_pool", mint_key.as_ref(), &[bump]];
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_nyseh.to_account_info(),
                    to: ctx.accounts.user_nyseh.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                &[seeds],
            ),
            out,
        )?;
        msg!(
            "mock swap: in {} (sol={}) -> out {} NYSEH raw",
            amount_in,
            sol_in,
            out
        );
        Ok(())
    }

    // TEST/DEVNET ONLY — permissionless setter for the mock live price.
    // mock_price is a RAW 8-byte account (no anchor discriminator): the first
    // 8 bytes ARE the little-endian u64 price, matching the stub pattern that
    // offer_claim / calc_completed_offers read via read_live_price.
    pub fn set_price(ctx: Context<SetPrice>, price: u64) -> Result<()> {
        let price_ai = &ctx.accounts.mock_price;
        if price_ai.data_is_empty() {
            let mint_key = ctx.accounts.nyseh_mint.key();
            let bump = ctx.bumps.mock_price;
            let seeds: &[&[u8]] = &[b"mock_price", mint_key.as_ref(), &[bump]];
            let rent = Rent::get()?.minimum_balance(8);
            anchor_lang::solana_program::program::invoke_signed(
                &anchor_lang::solana_program::system_instruction::create_account(
                    &ctx.accounts.payer.key(),
                    &price_ai.key(),
                    rent,
                    8,
                    &crate::ID,
                ),
                &[
                    ctx.accounts.payer.to_account_info(),
                    price_ai.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[seeds],
            )?;
        }
        price_ai.try_borrow_mut_data()?[..8].copy_from_slice(&price.to_le_bytes());
        msg!("mock price set to {}", price);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub nyseh_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: raw 8-byte price PDA (no anchor disc) — first 8 bytes are the price
    #[account(mut, seeds = [b"mock_price", nyseh_mint.key().as_ref()], bump)]
    pub mock_price: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct PoolState {
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub nyseh_mint: InterfaceAccount<'info, Mint>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        seeds = [b"mock_pool", nyseh_mint.key().as_ref()],
        bump,
        space = 8 + 1,
    )]
    pub pool_state: Account<'info, PoolState>,
    // Deterministic ATAs of the pool PDA — keeper/ops can derive both legs.
    #[account(
        init,
        payer = payer,
        associated_token::mint = nyseh_mint,
        associated_token::authority = pool_state,
        associated_token::token_program = token_2022_program,
    )]
    pub pool_nyseh: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = pool_state,
        associated_token::token_program = token_program,
    )]
    pub pool_usdc: InterfaceAccount<'info, TokenAccount>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendNyseh<'info> {
    #[account(seeds = [b"mock_pool", nyseh_mint.key().as_ref()], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,
    #[account(mut, constraint = pool_nyseh.owner == pool_state.key())]
    pub pool_nyseh: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_nyseh: InterfaceAccount<'info, TokenAccount>,
    pub nyseh_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}