use crate::state::offersState::AmmState;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use anchor_spl::associated_token::{create_idempotent, AssociatedToken, Create};

use super::offer_claim::read_live_price;
use super::raydium::cpmm_swap_base_input_ix;
use anchor_spl::token::{close_account, CloseAccount};

// Bounty auto-top-up (All-USDC): when the crank-oracle bounty vault's SOL
// drops below LOW_LAMPORTS, swap USDC → SOL through the pinned SOL/USDC pool
// and fund the vault back up to TARGET_LAMPORTS. Permissionless (any cranker
// can keep the bounty funded); the USDC comes from the buyback vault.
const LOW_LAMPORTS: u64 = 200_000_000; // 0.2 SOL
const TARGET_LAMPORTS: u64 = 400_000_000; // 0.4 SOL

#[derive(Accounts)]
pub struct BountyTopUp<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: crank-oracle bounty vault PDA (lamports are topped up here)
    #[account(mut, seeds = [b"bounty_vault"], seeds::program = amm_state.crank_program, bump)]
    pub bounty_vault: AccountInfo<'info>,

    /// Funding source (buyback vault)
    #[account(mut, address = amm_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// SOL/USD price (lamports pricing) — same raw-u64 oracle as offer_claim_sol
    /// CHECK: address-verified against amm_state.sol_oracle
    #[account(address = amm_state.sol_oracle)]
    pub sol_oracle: UncheckedAccount<'info>,

    // --- wSOL swap output (USDC → SOL) + close back to lamports ---
    /// CHECK: wSOL ATA owned by amm_state
    #[account(mut)]
    pub wsol_vault: UncheckedAccount<'info>,
    /// wSOL mint (So1111...)
    pub wrapped_sol_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- SOL/USDC CPMM pool accounts (USDC in, wSOL out) ---
    #[account(mut)]
    /// CHECK: SOL/USDC pool account (validated at CPI time).
    pub sol_usdc_pool_state: UncheckedAccount<'info>,
    /// CHECK: SOL/USDC pool account (validated at CPI time).
    pub sol_usdc_amm_config: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: SOL/USDC pool account (validated at CPI time).
    pub sol_usdc_input_vault: UncheckedAccount<'info>, // pool USDC vault
    #[account(mut)]
    /// CHECK: SOL/USDC pool account (validated at CPI time).
    pub sol_usdc_output_vault: UncheckedAccount<'info>, // pool wSOL vault
    #[account(mut)]
    /// CHECK: SOL/USDC pool account (validated at CPI time).
    pub sol_usdc_observation: UncheckedAccount<'info>,
    /// CHECK: SOL/USDC pool account (validated at CPI time).
    pub sol_usdc_authority: UncheckedAccount<'info>,

    /// Classic SPL (USDC + wSOL)
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BountyTopUp>) -> Result<()> {
    let current = ctx.accounts.bounty_vault.lamports();
    if current >= LOW_LAMPORTS {
        msg!("bounty vault healthy ({} lamports)", current);
        return Ok(());
    }
    let needed = TARGET_LAMPORTS.saturating_sub(current);

    // SOL price in floor units: (usdc_raw x 1e6) / lamports — same convention
    // as offer_claim_sol. usdc_in = needed lamports × sol_price / 1e6.
    let sol_price = read_live_price(&ctx.accounts.sol_oracle.to_account_info())?;
    require!(sol_price > 0, ErrorCode::InvalidOracle);
    let usdc_in = ((needed as u128 * sol_price as u128) / 1_000_000u128) as u64;
    require!(usdc_in > 0, ErrorCode::ZeroAmount);
    require!(
        ctx.accounts.usdc_vault.amount >= usdc_in,
        ErrorCode::InsufficientUsdc
    );

    let mint_key = ctx.accounts.amm_state.afho_mint;
    let state_bump = ctx.accounts.amm_state.bump;
    let cpmm_program = ctx.accounts.amm_state.cpmm_program;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];

    // Ensure the wSOL ATA exists before swapping into it (it is closed at the
    // end of every top-up, and may never have been created if no SOL claim
    // ran yet). The cranker funds the rent.
    create_idempotent(
        CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.cranker.to_account_info(),
                associated_token: ctx.accounts.wsol_vault.to_account_info(),
                authority: ctx.accounts.amm_state.to_account_info(),
                mint: ctx.accounts.wrapped_sol_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        )
        .with_signer(&[seeds]),
    )?;

    // Swap USDC → wSOL (output into the amm-owned wSOL ATA).
    let ix = cpmm_swap_base_input_ix(
        cpmm_program,
        ctx.accounts.amm_state.key(),
        ctx.accounts.sol_usdc_authority.key(),
        ctx.accounts.sol_usdc_amm_config.key(),
        ctx.accounts.sol_usdc_pool_state.key(),
        ctx.accounts.usdc_vault.key(),
        ctx.accounts.wsol_vault.key(),
        ctx.accounts.sol_usdc_input_vault.key(),
        ctx.accounts.sol_usdc_output_vault.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.usdc_mint.key(),
        ctx.accounts.wrapped_sol_mint.key(),
        ctx.accounts.sol_usdc_observation.key(),
        usdc_in,
        0, // min-out left loose; bounded by the amount we transfer below
    );
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.amm_state.to_account_info(),
            ctx.accounts.sol_usdc_authority.to_account_info(),
            ctx.accounts.sol_usdc_amm_config.to_account_info(),
            ctx.accounts.sol_usdc_pool_state.to_account_info(),
            ctx.accounts.usdc_vault.to_account_info(),
            ctx.accounts.wsol_vault.to_account_info(),
            ctx.accounts.sol_usdc_input_vault.to_account_info(),
            ctx.accounts.sol_usdc_output_vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.wrapped_sol_mint.to_account_info(),
            ctx.accounts.sol_usdc_observation.to_account_info(),
        ],
        &[seeds],
    )?;

    // Unwrap the wSOL ATA: close it back into lamports, funding the bounty vault.
    // The token program's CloseAccount on a native-mint (wSOL) account returns
    // the full lamport balance (rent + wrapped SOL) to the destination.
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.wsol_vault.to_account_info(),
            destination: ctx.accounts.bounty_vault.to_account_info(),
            authority: ctx.accounts.amm_state.to_account_info(),
        },
        &[&[b"amm_state", mint_key.as_ref(), &[state_bump]]],
    ))?;

    msg!("bounty topped up from {} usdc", usdc_in);
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid SOL price oracle")]
    InvalidOracle,
    #[msg("Computed USDC amount is zero")]
    ZeroAmount,
    #[msg("Buyback vault USDC balance is too low to top up the bounty")]
    InsufficientUsdc,
}
