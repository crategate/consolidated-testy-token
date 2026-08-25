// programs/amm/src/instructions/distribute_staker_rewards.rs
//
// The stakers' 10%: once per trading day, while the market is OPEN, swap the
// balances accumulated in the rewards holding vaults (last night's claim
// share — USDC and/or SOL) into AFHO via the same swap adapter dex_buyback
// uses, then CPI the staking program to deposit the combined AFHO into
// reward_vault — the MasterChef index bump (divided by total_WEIGHTED_stake,
// so lock multipliers are respected) makes it instantly claimable pro-rata.
// Distributing the PREVIOUS day's proceeds at the start of the day is
// deliberate: it's one CPI per day, the day_index guard makes it idempotent,
// and it matches dex_buyback's snapshot-at-open pattern.
//
// If there are no stakers, the funds stay in the holding vaults and roll into
// the next day (the staking program would reject the deposit anyway).

use crate::state::offersState::AmmState;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::dex_buyback::{execute_swap, ratchet_within_band, SwapInfos, MAX_SLIPPAGE_BPS};
use super::offer_claim::read_live_price;

#[derive(Accounts)]
pub struct DistributeStakerRewards<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: market status PDA (state byte + day index)
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// Staker-rewards holding vault (the 10% USDC claim share)
    #[account(mut, address = amm_state.usdc_rewards)]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Staker-rewards holding vault (the 10% SOL claim share) — funds the
    /// swap's SOL in-leg (signed with its own seeds)
    /// CHECK: address-verified system PDA
    #[account(mut, address = amm_state.sol_rewards)]
    pub sol_rewards: AccountInfo<'info>,
    /// CHECK: SOL/USD price oracle — converts the SOL-leg fill into USDC
    /// units for the ratchet floor
    #[account(address = amm_state.sol_oracle)]
    pub sol_oracle: UncheckedAccount<'info>,
    /// CHECK: live absolute spot price — the M3 slippage band for every fill
    /// is measured against this. Address pinned at init.
    #[account(address = amm_state.spot_oracle)]
    pub spot_oracle: UncheckedAccount<'info>,
    /// Swap out-leg destination + deposit source
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- swap adapter accounts (mock-dex-pool today; real DEX at launch) ---
    /// CHECK: pool state PDA, verified against the configured dex_program
    #[account(
        mut,
        seeds = [b"mock_pool", afho_mint.key().as_ref()],
        seeds::program = amm_state.dex_program,
        bump
    )]
    pub pool_state: UncheckedAccount<'info>,
    // H1 — pinned to the pool's own topology (same as dex_buyback): the pool
    // token accounts are the pool PDA's ATAs, pool_sol is the pool PDA
    // itself, so a compromised keeper can't redirect the in-leg.
    #[account(
        mut,
        associated_token::mint = afho_mint,
        associated_token::authority = pool_state,
        associated_token::token_program = token_2022_program,
    )]
    pub pool_afho: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = pool_state,
        associated_token::token_program = token_program,
    )]
    pub pool_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: lamport destination for the SOL in-leg — the pool PDA itself
    #[account(mut, address = pool_state.key())]
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
    /// Token-2022 (AFHO out-leg + staking deposit)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    // --- Raydium CPMM accounts (None while the mock adapter is active) ---
    #[account(mut)]
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_pool_state: UncheckedAccount<'info>,
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_amm_config: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_input_vault: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_output_vault: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_observation: UncheckedAccount<'info>,
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_authority: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<DistributeStakerRewards>) -> Result<()> {
    // AccountInfo clones for the swap adapter, collected before amm_state is
    // mutably borrowed (same pattern as dex_buyback). The vault slots hold
    // the staker-rewards HOLDING vaults here (not the buyback vaults).
    let swap = SwapInfos {
        amm_state: ctx.accounts.amm_state.to_account_info(),
        usdc_vault: ctx.accounts.usdc_rewards.to_account_info(),
        afho_vault: ctx.accounts.afho_vault.to_account_info(),
        sol_vault: ctx.accounts.sol_rewards.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        pool_afho: ctx.accounts.pool_afho.to_account_info(),
        pool_usdc: ctx.accounts.pool_usdc.to_account_info(),
        pool_sol: ctx.accounts.pool_sol.to_account_info(),
        afho_mint: ctx.accounts.afho_mint.to_account_info(),
        usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
        dex_program: ctx.accounts.dex_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        cpmm_pool_state: ctx.accounts.cpmm_pool_state.to_account_info(),
        cpmm_amm_config: ctx.accounts.cpmm_amm_config.to_account_info(),
        cpmm_input_vault: ctx.accounts.cpmm_input_vault.to_account_info(),
        cpmm_output_vault: ctx.accounts.cpmm_output_vault.to_account_info(),
        cpmm_observation: ctx.accounts.cpmm_observation.to_account_info(),
        cpmm_authority: ctx.accounts.cpmm_authority.to_account_info(),
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

    // Rent floor for the space-0 system PDA — never swap the lamports that
    // keep the account alive.
    let sol_floor = Rent::get()?.minimum_balance(0);
    let usdc_in = ctx.accounts.usdc_rewards.amount;
    let sol_in = ctx.accounts.sol_rewards.lamports().saturating_sub(sol_floor);
    if usdc_in == 0 && sol_in == 0 {
        // Nothing collected last night — mark the day and move on.
        amm_state.rewards_day_index = current_day;
        return Ok(());
    }
    // No stakers → nothing to distribute to; leave funds for tomorrow.
    if ctx.accounts.staking_pool.total_weighted_stake == 0 {
        msg!("no stakers — rewards stay in the holding vaults");
        return Ok(());
    }

    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;
    let sol_rewards_bump = amm_state.sol_rewards_bump;

    let mut total_out: u64 = 0;

    // ── USDC leg ──
    if usdc_in > 0 {
        let before = ctx.accounts.afho_vault.amount;
        let spot = read_live_price(&ctx.accounts.spot_oracle.to_account_info())?;
        let min_out = if spot > 0 {
            (usdc_in as u128 * 1_000_000u128 * 10_000u128
                / (spot as u128 * (10_000 + MAX_SLIPPAGE_BPS) as u128)) as u64
        } else {
            0
        };
        execute_swap(
            &swap,
            mint_key,
            state_bump,
            b"amm_sol_rewards",
            sol_rewards_bump,
            usdc_in,
            false,
            min_out,
            amm_state.cpmm_program,
            amm_state.cpmm_pool_state != Pubkey::default(),
        )?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            // USDC leg: (usdc_raw × 1e6) / afho_raw — already floor units.
            // M3: band-checked against the spot oracle.
            let spot = read_live_price(&ctx.accounts.spot_oracle.to_account_info())?;
            ratchet_within_band(
                amm_state,
                (usdc_in as u128 * 1_000_000 / out as u128) as u64,
                spot,
            )?;
        }
        total_out = total_out.saturating_add(out);
    }

    // ── SOL leg ──
    if sol_in > 0 {
        let before = ctx.accounts.afho_vault.amount;
        execute_swap(
            &swap,
            mint_key,
            state_bump,
            b"amm_sol_rewards",
            sol_rewards_bump,
            sol_in,
            true,
            0,
            amm_state.cpmm_program,
            amm_state.cpmm_pool_state != Pubkey::default(),
        )?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            // Convert to USDC units before ratcheting: lamports × sol_price /
            // out == (usdc_raw × 1e6) / afho_raw — never mix units in floor.
            // M3: band-checked against the spot oracle like the USDC leg.
            let sol_price = read_live_price(&ctx.accounts.sol_oracle.to_account_info())?;
            require!(sol_price > 0, ErrorCode::InvalidOracle);
            let px = (sol_in as u128).saturating_mul(sol_price as u128) / out as u128;
            let spot = read_live_price(&ctx.accounts.spot_oracle.to_account_info())?;
            ratchet_within_band(amm_state, u64::try_from(px).unwrap_or(u64::MAX), spot)?;
        }
        total_out = total_out.saturating_add(out);
    }

    require!(total_out > 0, ErrorCode::SwapReturnedNothing);
    amm_state.rewards_day_index = current_day;

    // ── Deposit the AFHO into the staking reward vault ──
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    staking::cpi::deposit_rewards_from_amm(
        CpiContext::new_with_signer(
            ctx.accounts.staking_program.to_account_info(),
            staking::cpi::accounts::DepositRewardsFromAmm {
                mint: ctx.accounts.afho_mint.to_account_info(),
                pool: ctx.accounts.staking_pool.to_account_info(),
                amm_state: ctx.accounts.amm_state.to_account_info(),
                amm_afho_vault: ctx.accounts.afho_vault.to_account_info(),
                reward_vault: ctx.accounts.staking_reward_vault.to_account_info(),
                token_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[seeds],
        ),
        total_out,
    )?;

    msg!(
        "day {}: distributed {} usdc + {} lamports -> {} AFHO to stakers",
        current_day,
        usdc_in,
        sol_in,
        total_out
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
    #[msg("Invalid SOL price oracle")]
    InvalidOracle,
}
