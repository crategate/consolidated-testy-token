use crate::state::offersState::AmmState;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{create_idempotent, AssociatedToken, Create};
use anchor_spl::token::{close_account, CloseAccount};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::raydium::cpmm_swap_base_input_ix;

// Bounty auto-top-up (AFHO-funded): when the crank-oracle bounty vault's SOL
// drops below LOW_LAMPORTS, sell AFHO from the treasury reserve for USDC
// (AFHO/USDC pool), then swap that USDC for wSOL (SOL/USDC pool) and unwrap it
// into the bounty vault. Permissionless. Two pool hops, one atomic instruction
// (the intermediate USDC lands in `usdc_vault` and leaves again within the same
// instruction, so it is never observable by other transactions).
const LOW_LAMPORTS: u64 = 200_000_000; // 0.2 SOL — only top up below this
const TOPUP_AMOUNT: u64 = 400_000_000; // 0.4 SOL added each top-up

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

    /// AFHO funding source (the treasury reserve).
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// USDC hop account (also the buyback vault) — net-zero over the swap.
    #[account(mut, address = amm_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- wSOL output (USDC → wSOL) + close back to lamports ---
    /// CHECK: wSOL ATA owned by amm_state
    #[account(mut)]
    pub wsol_vault: UncheckedAccount<'info>,
    /// wSOL mint (So1111...)
    pub wrapped_sol_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- AFHO/USDC CPMM pool (AFHO in → USDC out) ---
    /// CHECK: pool state, pinned to amm_state.cpmm_pool_state in the handler
    #[account(mut)]
    pub cpmm_pool_state: UncheckedAccount<'info>,
    /// CHECK: pinned to amm_state.cpmm_amm_config in the handler
    pub cpmm_amm_config: UncheckedAccount<'info>,
    /// CHECK: pool USDC vault (quote/output leg)
    #[account(mut)]
    pub cpmm_input_vault: UncheckedAccount<'info>,
    /// CHECK: pool AFHO vault (base/input leg)
    #[account(mut)]
    pub cpmm_output_vault: UncheckedAccount<'info>,
    /// CHECK: pool observation (TWAP ring)
    #[account(mut)]
    pub cpmm_observation: UncheckedAccount<'info>,
    /// CHECK: pool authority PDA
    pub cpmm_authority: UncheckedAccount<'info>,

    // --- SOL/USDC CPMM pool (USDC in → wSOL out) ---
    #[account(mut)]
    /// CHECK: SOL/USDC pool account (pinned in the handler).
    pub sol_usdc_pool_state: UncheckedAccount<'info>,
    /// CHECK: SOL/USDC pool account (pinned in the handler).
    pub sol_usdc_amm_config: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: SOL/USDC pool account (pinned in the handler).
    pub sol_usdc_input_vault: UncheckedAccount<'info>, // pool USDC vault
    #[account(mut)]
    /// CHECK: SOL/USDC pool account (pinned in the handler).
    pub sol_usdc_output_vault: UncheckedAccount<'info>, // pool wSOL vault
    #[account(mut)]
    /// CHECK: SOL/USDC pool account (pinned in the handler).
    pub sol_usdc_observation: UncheckedAccount<'info>,
    /// CHECK: SOL/USDC pool account (pinned in the handler).
    pub sol_usdc_authority: UncheckedAccount<'info>,

    /// Classic SPL (USDC + wSOL) and Token-2022 (AFHO)
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BountyTopUp>) -> Result<()> {
    let current = ctx.accounts.bounty_vault.lamports();
    if current >= LOW_LAMPORTS {
        msg!("bounty vault healthy ({} lamports)", current);
        return Ok(());
    }
    // Top up BY 0.4 SOL (not TO a fixed balance) so the refill is constant and
    // predictable regardless of how far the vault drained.
    let needed = TOPUP_AMOUNT;

    let amm_state = &ctx.accounts.amm_state;
    let cpmm_program = amm_state.cpmm_program;
    let afho_pinned = amm_state.cpmm_pool_state != Pubkey::default();
    let sol_pinned = amm_state.cpmm_sol_usdc_pool != Pubkey::default();
    require!(afho_pinned && sol_pinned, ErrorCode::PoolNotPinned);

    // H1 re-pin: the swap/pricing accounts must be the pools' derived PDAs.
    require!(
        super::raydium::pinned_pool_accounts_valid(
            true,
            cpmm_program,
            amm_state.cpmm_pool_state,
            amm_state.cpmm_amm_config,
            ctx.accounts.afho_mint.key(),
            ctx.accounts.usdc_mint.key(),
            &ctx.accounts.cpmm_pool_state.to_account_info(),
            &ctx.accounts.cpmm_amm_config.to_account_info(),
            &ctx.accounts.cpmm_output_vault.to_account_info(), // AFHO (base)
            &ctx.accounts.cpmm_input_vault.to_account_info(),  // USDC (quote)
            &ctx.accounts.cpmm_observation.to_account_info(),
            &ctx.accounts.cpmm_authority.to_account_info(),
        ),
        ErrorCode::InvalidPoolAccount
    );
    require!(
        super::raydium::pinned_sol_usdc_accounts_valid(
            true,
            cpmm_program,
            amm_state.cpmm_sol_usdc_pool,
            amm_state.cpmm_sol_usdc_config,
            ctx.accounts.wrapped_sol_mint.key(),
            ctx.accounts.usdc_mint.key(),
            &ctx.accounts.sol_usdc_pool_state.to_account_info(),
            &ctx.accounts.sol_usdc_amm_config.to_account_info(),
            &ctx.accounts.sol_usdc_input_vault.to_account_info(),  // wSOL
            &ctx.accounts.sol_usdc_output_vault.to_account_info(), // USDC
            &ctx.accounts.sol_usdc_observation.to_account_info(),
            &ctx.accounts.sol_usdc_authority.to_account_info(),
        ),
        ErrorCode::InvalidPoolAccount
    );

    let clock = Clock::get()?;
    let now = clock.unix_timestamp as u64;

    // Both prices in floor units: (quote_raw × 1e6) / base_raw.
    let sol_price = super::raydium::read_cpmm_price_floor(
        &ctx.accounts.sol_usdc_pool_state.to_account_info(),
        &ctx.accounts.sol_usdc_observation.to_account_info(),
        &ctx.accounts.sol_usdc_input_vault.to_account_info(),  // wSOL (base)
        &ctx.accounts.sol_usdc_output_vault.to_account_info(), // USDC (quote)
        &ctx.accounts.wrapped_sol_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        now,
    )
    .ok_or(ErrorCode::InvalidOracle)?;
    let afho_price = super::raydium::read_cpmm_price_floor(
        &ctx.accounts.cpmm_pool_state.to_account_info(),
        &ctx.accounts.cpmm_observation.to_account_info(),
        &ctx.accounts.cpmm_output_vault.to_account_info(),  // AFHO (base)
        &ctx.accounts.cpmm_input_vault.to_account_info(),   // USDC (quote)
        &ctx.accounts.afho_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        now,
    )
    .ok_or(ErrorCode::InvalidOracle)?;
    require!(sol_price > 0 && afho_price > 0, ErrorCode::InvalidOracle);

    // USDC needed to buy `needed` wSOL (25bps input fee on the SOL/USDC leg).
    let usdc_needed = (needed as u128)
        .checked_mul(sol_price as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_mul(10_025u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(1_000_000u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000u128)
        .ok_or(ErrorCode::MathOverflow)? as u64;
    // AFHO to sell for that USDC (25bps input fee on the AFHO/USDC leg).
    let afho_in = (usdc_needed as u128)
        .checked_mul(1_000_000u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_mul(10_025u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(afho_price as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000u128)
        .ok_or(ErrorCode::MathOverflow)? as u64;
    require!(afho_in > 0, ErrorCode::ZeroAmount);
    require!(
        ctx.accounts.afho_vault.amount >= afho_in,
        ErrorCode::InsufficientAfho
    );

    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];

    // Ensure the wSOL ATA exists (closed at the end of every top-up; may never
    // have been created if no SOL claim ran yet). The cranker funds the rent.
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

    // ── Leg 1: AFHO → USDC (into usdc_vault) ──
    let usdc_before = ctx.accounts.usdc_vault.amount;
    let min_out = usdc_needed.saturating_mul(98) / 100; // 2% drift tolerance
    let ix = cpmm_swap_base_input_ix(
        cpmm_program,
        ctx.accounts.amm_state.key(),
        ctx.accounts.cpmm_authority.key(),
        ctx.accounts.cpmm_amm_config.key(),
        ctx.accounts.cpmm_pool_state.key(),
        ctx.accounts.afho_vault.key(),       // user input (AFHO)
        ctx.accounts.usdc_vault.key(),       // user output (USDC)
        ctx.accounts.cpmm_output_vault.key(), // pool AFHO vault
        ctx.accounts.cpmm_input_vault.key(),  // pool USDC vault
        ctx.accounts.token_2022_program.key(), // AFHO is Token-2022
        ctx.accounts.token_program.key(),      // USDC classic
        ctx.accounts.afho_mint.key(),
        ctx.accounts.usdc_mint.key(),
        ctx.accounts.cpmm_observation.key(),
        afho_in,
        min_out,
    );
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.amm_state.to_account_info(),
            ctx.accounts.cpmm_authority.to_account_info(),
            ctx.accounts.cpmm_amm_config.to_account_info(),
            ctx.accounts.cpmm_pool_state.to_account_info(),
            ctx.accounts.afho_vault.to_account_info(),
            ctx.accounts.usdc_vault.to_account_info(),
            ctx.accounts.cpmm_output_vault.to_account_info(),
            ctx.accounts.cpmm_input_vault.to_account_info(),
            ctx.accounts.token_2022_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.afho_mint.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.cpmm_observation.to_account_info(),
        ],
        &[seeds],
    )?;
    ctx.accounts.usdc_vault.reload()?;
    let usdc_got = ctx.accounts.usdc_vault.amount.saturating_sub(usdc_before);
    require!(usdc_got > 0, ErrorCode::SwapReturnedNothing);

    // ── Leg 2: USDC → wSOL (into wsol_vault) ──
    // 98% min-out (2% drift tolerance, same as the claim path): a manipulated
    // SOL/USDC pool must not be able to eat the whole conversion.
    let wsol_min_out = (usdc_got as u128)
        .checked_mul(1_000_000_000u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(sol_price as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_mul(98u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(100u128)
        .ok_or(ErrorCode::MathOverflow)? as u64;
    let ix = cpmm_swap_base_input_ix(
        cpmm_program,
        ctx.accounts.amm_state.key(),
        ctx.accounts.sol_usdc_authority.key(),
        ctx.accounts.sol_usdc_amm_config.key(),
        ctx.accounts.sol_usdc_pool_state.key(),
        ctx.accounts.usdc_vault.key(),       // user input (USDC)
        ctx.accounts.wsol_vault.key(),       // user output (wSOL)
        ctx.accounts.sol_usdc_input_vault.key(),  // pool USDC vault
        ctx.accounts.sol_usdc_output_vault.key(), // pool wSOL vault
        ctx.accounts.token_program.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.usdc_mint.key(),
        ctx.accounts.wrapped_sol_mint.key(),
        ctx.accounts.sol_usdc_observation.key(),
        usdc_got,
        wsol_min_out,
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
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.wsol_vault.to_account_info(),
            destination: ctx.accounts.bounty_vault.to_account_info(),
            authority: ctx.accounts.amm_state.to_account_info(),
        },
        &[&[b"amm_state", mint_key.as_ref(), &[state_bump]]],
    ))?;

    msg!(
        "bounty topped up: sold {} AFHO → {} SOL",
        afho_in,
        needed
    );
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid pool price oracle")]
    InvalidOracle,
    #[msg("AFHO/USDC or SOL/USDC pool is not pinned")]
    PoolNotPinned,
    #[msg("Computed AFHO amount is zero")]
    ZeroAmount,
    #[msg("Treasury AFHO balance is too low to top up the bounty")]
    InsufficientAfho,
    #[msg("CPMM pool account mismatch")]
    InvalidPoolAccount,
    #[msg("AFHO→USDC swap returned no USDC")]
    SwapReturnedNothing,
    #[msg("Math overflow")]
    MathOverflow,
}
