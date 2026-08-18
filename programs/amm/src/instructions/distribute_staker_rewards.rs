// programs/amm/src/instructions/distribute_staker_rewards.rs
//
// The stakers' 10%: once per trading day, while the market is OPEN, swap the
// USDC accumulated in the rewards holding vault (yesterday night's claim
// share) into NYSEH via the same swap adapter dex_buyback uses, then CPI the
// staking program to deposit it into reward_vault — the MasterChef index
// bump makes it instantly claimable pro-rata. Distributing the PREVIOUS day's
// proceeds at the start of the day is deliberate: it's one CPI per day, the
// day_index guard makes it idempotent, and it matches dex_buyback's
// snapshot-at-open pattern.
//
// If there are no stakers, the USDC stays in the holding vault and rolls into
// the next day (the staking program would reject the deposit anyway).

use crate::state::offersState::AmmState;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::dex_buyback::{execute_swap, ratchet_buyback_basis, SwapInfos};

#[derive(Accounts)]
pub struct DistributeStakerRewards<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.nyseh_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: market status PDA (state byte + day index)
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// Staker-rewards holding vault (the 10% claim share)
    #[account(mut, address = amm_state.usdc_rewards)]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Swap out-leg destination + deposit source
    #[account(mut, address = amm_state.nyseh_vault)]
    pub nyseh_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: SOL vault — unused by this swap (USDC leg only) but required by
    /// the shared swap adapter
    #[account(address = amm_state.sol_vault)]
    pub sol_vault: AccountInfo<'info>,
    pub nyseh_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- swap adapter accounts (mock-dex-pool today; real DEX at launch) ---
    /// CHECK: pool state PDA, verified against the configured dex_program
    #[account(
        mut,
        seeds = [b"mock_pool", nyseh_mint.key().as_ref()],
        seeds::program = amm_state.dex_program,
        bump
    )]
    pub pool_state: UncheckedAccount<'info>,
    #[account(mut, constraint = pool_nyseh.mint == amm_state.nyseh_mint)]
    pub pool_nyseh: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, constraint = pool_usdc.mint == amm_state.usdc_mint)]
    pub pool_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: unused for the USDC leg
    pub pool_sol: AccountInfo<'info>,
    /// CHECK: configured swap target program
    #[account(address = amm_state.dex_program)]
    pub dex_program: AccountInfo<'info>,

    // --- staking CPI ---
    pub staking_program: Program<'info, staking::program::Staking>,
    #[account(mut, address = amm_state.staking_pool)]
    pub staking_pool: Box<Account<'info, staking::StakePool>>,
    #[account(mut, address = staking_pool.reward_vault)]
    pub staking_reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Classic SPL (USDC in-leg)
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (NYSEH out-leg + staking deposit)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DistributeStakerRewards>) -> Result<()> {
    // AccountInfo clones for the swap adapter, collected before amm_state is
    // mutably borrowed (same pattern as dex_buyback).
    let swap = SwapInfos {
        amm_state: ctx.accounts.amm_state.to_account_info(),
        usdc_vault: ctx.accounts.usdc_rewards.to_account_info(),
        nyseh_vault: ctx.accounts.nyseh_vault.to_account_info(),
        sol_vault: ctx.accounts.sol_vault.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        pool_nyseh: ctx.accounts.pool_nyseh.to_account_info(),
        pool_usdc: ctx.accounts.pool_usdc.to_account_info(),
        pool_sol: ctx.accounts.pool_sol.to_account_info(),
        nyseh_mint: ctx.accounts.nyseh_mint.to_account_info(),
        dex_program: ctx.accounts.dex_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    let amm_state = &mut ctx.accounts.amm_state;
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == amm_state.authority || caller == amm_state.keeper,
        ErrorCode::UnauthorizedCaller
    );

    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) + trading_day_index(8)
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, ErrorCode::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    // Distribute at the start of the trading day (market open).
    require!(current_state == 0, ErrorCode::InvalidMarketState);
    // Once per trading day.
    require!(
        amm_state.rewards_day_index != current_day,
        ErrorCode::AlreadyDistributed
    );

    let amount_in = ctx.accounts.usdc_rewards.amount;
    if amount_in == 0 {
        // Nothing collected last night — mark the day and move on.
        amm_state.rewards_day_index = current_day;
        return Ok(());
    }
    // No stakers → nothing to distribute to; leave funds for tomorrow.
    if ctx.accounts.staking_pool.total_weighted_stake == 0 {
        msg!("no stakers — rewards stay in the holding vault");
        return Ok(());
    }

    let mint_key = amm_state.nyseh_mint;
    let state_bump = amm_state.bump;
    let sol_vault_bump = amm_state.sol_vault_bump;

    // ── Swap the full holding balance USDC → NYSEH ──
    let before = ctx.accounts.nyseh_vault.amount;
    execute_swap(&swap, mint_key, state_bump, sol_vault_bump, amount_in, false)?;
    ctx.accounts.nyseh_vault.reload()?;
    let out = ctx.accounts.nyseh_vault.amount.saturating_sub(before);
    require!(out > 0, ErrorCode::SwapReturnedNothing);

    // The rewards conversion is a realized USDC-denominated buy — it ratchets
    // the floor just like a buyback fill (same units).
    ratchet_buyback_basis(amm_state, (amount_in as u128 * 1_000_000 / out as u128) as u64);
    amm_state.rewards_day_index = current_day;

    // ── Deposit the NYSEH into the staking reward vault ──
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    staking::cpi::deposit_rewards_from_amm(
        CpiContext::new_with_signer(
            ctx.accounts.staking_program.to_account_info(),
            staking::cpi::accounts::DepositRewardsFromAmm {
                mint: ctx.accounts.nyseh_mint.to_account_info(),
                pool: ctx.accounts.staking_pool.to_account_info(),
                amm_state: ctx.accounts.amm_state.to_account_info(),
                amm_nyseh_vault: ctx.accounts.nyseh_vault.to_account_info(),
                reward_vault: ctx.accounts.staking_reward_vault.to_account_info(),
                token_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[seeds],
        ),
        out,
    )?;

    msg!(
        "day {}: distributed {} usdc -> {} NYSEH to stakers",
        current_day,
        amount_in,
        out
    );
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Invalid market status")]
    InvalidMarketStatus,
    #[msg("Market is not open")]
    InvalidMarketState,
    #[msg("Already distributed for this day")]
    AlreadyDistributed,
    #[msg("Swap returned nothing")]
    SwapReturnedNothing,
}
