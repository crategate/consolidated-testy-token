use crate::state::offersState::{AcceptedOffers, AmmState};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use mock_dex_pool::cpi::accounts::SendAfho;

use super::offer_claim::read_live_price;

// Minimum slots between slices (~1 min) — pacing so one crank burst can't
// drain the day's budget in a single block.
const MIN_SLICE_SLOTS: u64 = 150;
// Slice weights: 1.9% of remaining budget during the first hour after open,
// 5% after. With ~1 slice/min (36 first-hour slices) ~50% of the day's volume
// lands in the first hour on average; the 5% tail spends the rest by close.
const FIRST_HOUR_WEIGHT_BPS: u64 = 190;
const TAIL_WEIGHT_BPS: u64 = 500;

#[derive(Accounts)]
pub struct DexBuyback<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: market status PDA (state byte + open timestamp + day index)
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// Fill evidence: buybacks only run on days after offers were taken.
    #[account(seeds = [b"accepted_offers", amm_state.afho_mint.as_ref()], bump)]
    pub accepted_offers: Box<Account<'info, AcceptedOffers>>,

    #[account(mut, address = amm_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: SOL buyback funds (system PDA, seeds [b"amm_sol_vault", mint])
    #[account(mut, address = amm_state.sol_vault)]
    pub sol_vault: AccountInfo<'info>,
    /// CHECK: SOL/USD price oracle — SOL-leg fills are converted to USDC
    /// units with this before ratcheting the floor (raw-u64 mock PDA on
    /// devnet; real SOL/USD feed at mainnet)
    #[account(address = amm_state.sol_oracle)]
    pub sol_oracle: UncheckedAccount<'info>,
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- swap adapter accounts (mock-dex-pool today; real DEX at launch) ---
    /// CHECK: pool state PDA, verified against the configured dex_program
    #[account(
        mut,
        seeds = [b"mock_pool", afho_mint.key().as_ref()],
        seeds::program = amm_state.dex_program,
        bump
    )]
    pub pool_state: UncheckedAccount<'info>,
    #[account(mut, constraint = pool_afho.mint == amm_state.afho_mint)]
    pub pool_afho: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, constraint = pool_usdc.mint == amm_state.usdc_mint)]
    pub pool_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: lamport destination for the SOL leg (any system account; the
    /// mock ignores it, a real pool would constrain this)
    #[account(mut)]
    pub pool_sol: AccountInfo<'info>,
    /// CHECK: configured swap target program
    #[account(address = amm_state.dex_program)]
    pub dex_program: AccountInfo<'info>,

    /// Classic SPL (USDC in-leg)
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (AFHO out-leg via the pool)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

// AccountInfo clones handed to the swap adapter, collected before amm_state
// is mutably borrowed (avoids whole-struct borrow conflicts). Shared with
// distribute_staker_rewards — the `usdc_vault`/`sol_vault` slots hold
// whichever vaults fund the swap (buyback vaults or staker-rewards holding
// vaults).
pub(crate) struct SwapInfos<'info> {
    pub amm_state: AccountInfo<'info>,
    pub usdc_vault: AccountInfo<'info>,
    pub afho_vault: AccountInfo<'info>,
    pub sol_vault: AccountInfo<'info>,
    pub pool_state: AccountInfo<'info>,
    pub pool_afho: AccountInfo<'info>,
    pub pool_usdc: AccountInfo<'info>,
    pub pool_sol: AccountInfo<'info>,
    pub afho_mint: AccountInfo<'info>,
    pub dex_program: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub token_2022_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DexBuyback>) -> Result<()> {
    let swap = SwapInfos {
        amm_state: ctx.accounts.amm_state.to_account_info(),
        usdc_vault: ctx.accounts.usdc_vault.to_account_info(),
        afho_vault: ctx.accounts.afho_vault.to_account_info(),
        sol_vault: ctx.accounts.sol_vault.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        pool_afho: ctx.accounts.pool_afho.to_account_info(),
        pool_usdc: ctx.accounts.pool_usdc.to_account_info(),
        pool_sol: ctx.accounts.pool_sol.to_account_info(),
        afho_mint: ctx.accounts.afho_mint.to_account_info(),
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
    let open_ts = i64::from_le_bytes(market_data[9..17].try_into().unwrap());
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    // Buybacks only execute while the market is OPEN.
    require!(current_state == 0, ErrorCode::InvalidMarketState);
    // ...and only when offers were actually taken while it was closed
    // (yesterday's fill %, any tier — written by calc_completed_offers).
    let accepted = &ctx.accounts.accepted_offers;
    let had_fills = accepted.sml_offers_accepted[4] > 0
        || accepted.med_offers_accepted[4] > 0
        || accepted.big_offers_accepted[4] > 0;
    require!(had_fills, ErrorCode::NoFillsToBuyBack);

    let clock = Clock::get()?;
    // Rent floor for the space-0 system PDA sol_vault — never buy back with
    // the lamports that keep the account alive.
    let sol_floor = Rent::get()?.minimum_balance(0);

    // New trading day: snapshot the vault balances as today's budget. Unspent
    // budget simply stays in the vaults — rollover needs no bookkeeping.
    if amm_state.bb_day_index != current_day {
        amm_state.bb_day_index = current_day;
        amm_state.bb_budget_usdc = ctx.accounts.usdc_vault.amount;
        amm_state.bb_spent_usdc = 0;
        amm_state.bb_budget_sol = ctx
            .accounts
            .sol_vault
            .lamports()
            .saturating_sub(sol_floor);
        amm_state.bb_spent_sol = 0;
        amm_state.bb_slice_count = 0;
        amm_state.bb_last_slot = 0;
        msg!(
            "buyback day {} budget: {} usdc raw, {} sol lamports",
            current_day,
            amm_state.bb_budget_usdc,
            amm_state.bb_budget_sol,
        );
    }

    // Pacing: at most one slice per MIN_SLICE_SLOTS.
    if amm_state.bb_last_slot != 0 && clock.slot - amm_state.bb_last_slot < MIN_SLICE_SLOTS {
        return Ok(());
    }

    let remaining_usdc = amm_state
        .bb_budget_usdc
        .saturating_sub(amm_state.bb_spent_usdc)
        .min(ctx.accounts.usdc_vault.amount);
    let remaining_sol = amm_state
        .bb_budget_sol
        .saturating_sub(amm_state.bb_spent_sol)
        .min(ctx.accounts.sol_vault.lamports().saturating_sub(sol_floor));
    if remaining_usdc == 0 && remaining_sol == 0 {
        return Ok(()); // day's budget exhausted; leftovers (rounding) roll over
    }

    // Slice size: front-loaded weight × pseudo-random factor 0.5x–1.5x derived
    // from slot/day/slice (no on-chain RNG; good enough for spread, not for
    // adversarial unpredictability).
    let elapsed = (clock.unix_timestamp - open_ts).max(0) as u64;
    let weight_bps = if elapsed < 3_600 {
        FIRST_HOUR_WEIGHT_BPS
    } else {
        TAIL_WEIGHT_BPS
    };
    let x = clock.slot ^ (current_day << 16) ^ amm_state.bb_slice_count as u64;
    let factor_bps = 5_000 + (x % 10_001);

    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;
    let sol_vault_bump = amm_state.sol_vault_bump;

    // ---- USDC leg ----
    let slice_usdc = ((remaining_usdc as u128 * weight_bps as u128 * factor_bps as u128)
        / 100_000_000u128) as u64;
    let slice_usdc = slice_usdc.min(remaining_usdc);
    if slice_usdc > 0 {
        let before = ctx.accounts.afho_vault.amount;
        execute_swap(
            &swap,
            mint_key,
            state_bump,
            b"amm_sol_vault",
            sol_vault_bump,
            slice_usdc,
            false,
        )?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            ratchet_buyback_basis(amm_state, (slice_usdc as u128 * 1_000_000 / out as u128) as u64);
        }
        amm_state.bb_spent_usdc += slice_usdc;
    }

    // ---- SOL leg ----
    let slice_sol = ((remaining_sol as u128 * weight_bps as u128 * factor_bps as u128)
        / 100_000_000u128) as u64;
    let slice_sol = slice_sol.min(remaining_sol);
    if slice_sol > 0 {
        let before = ctx.accounts.afho_vault.amount;
        execute_swap(
            &swap,
            mint_key,
            state_bump,
            b"amm_sol_vault",
            sol_vault_bump,
            slice_sol,
            true,
        )?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            // Ratchet in USDC units: lamports × sol_price / out equals
            // (usdc_raw × 1e6) / afho_raw — same units as the USDC leg.
            let sol_price = read_live_price(&ctx.accounts.sol_oracle.to_account_info())?;
            require!(sol_price > 0, ErrorCode::InvalidOracle);
            let px = (slice_sol as u128).saturating_mul(sol_price as u128) / out as u128;
            ratchet_buyback_basis(amm_state, u64::try_from(px).unwrap_or(u64::MAX));
        }
        amm_state.bb_spent_sol += slice_sol;
    }

    amm_state.bb_slice_count += 1;
    amm_state.bb_last_slot = clock.slot;
    msg!(
        "buyback slice {}: {} usdc, {} sol (spent {}/{} usdc, {}/{} sol)",
        amm_state.bb_slice_count,
        slice_usdc,
        slice_sol,
        amm_state.bb_spent_usdc,
        amm_state.bb_budget_usdc,
        amm_state.bb_spent_sol,
        amm_state.bb_budget_sol,
    );
    Ok(())
}

// Swap adapter — THE function to replace when plugging in the real DEX pool.
// In-leg: amm pays from its own vaults (USDC token transfer signed by
// amm_state, or SOL lamport transfer signed by the sol_vault PDA).
// Out-leg: CPI send_afho on the configured dex_program (mock fixed-rate
// dispenser today). Everything else in this file is swap-agnostic.
// `sol_vault_seed`/`sol_vault_bump` name the system PDA funding a SOL in-leg:
// b"amm_sol_vault" for buybacks, b"amm_sol_rewards" for the staker share.
pub(crate) fn execute_swap(
    swap: &SwapInfos,
    mint_key: Pubkey,
    state_bump: u8,
    sol_vault_seed: &[u8],
    sol_vault_bump: u8,
    amount_in: u64,
    sol_in: bool,
) -> Result<()> {
    if sol_in {
        let seeds: &[&[u8]] = &[sol_vault_seed, mint_key.as_ref(), &[sol_vault_bump]];
        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::transfer(
                &swap.sol_vault.key(),
                &swap.pool_sol.key(),
                amount_in,
            ),
            &[
                swap.sol_vault.to_account_info(),
                swap.pool_sol.to_account_info(),
                swap.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
    } else {
        let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
        anchor_spl::token_interface::transfer(
            CpiContext::new_with_signer(
                swap.token_program.to_account_info(),
                anchor_spl::token_interface::Transfer {
                    from: swap.usdc_vault.to_account_info(),
                    to: swap.pool_usdc.to_account_info(),
                    authority: swap.amm_state.to_account_info(),
                },
                &[seeds],
            ),
            amount_in,
        )?;
    }
    mock_dex_pool::cpi::send_afho(
        CpiContext::new(
            swap.dex_program.to_account_info(),
            SendAfho {
                pool_state: swap.pool_state.to_account_info(),
                pool_afho: swap.pool_afho.to_account_info(),
                user_afho: swap.afho_vault.to_account_info(),
                afho_mint: swap.afho_mint.to_account_info(),
                token_program: swap.token_2022_program.to_account_info(),
            },
        ),
        amount_in,
        sol_in,
    )?;
    Ok(())
}

// The ratchet floor is the offer desk's ONLY bear-shutdown mechanism:
// make_offers may never price a lot below the highest realized buyback price,
// so when the live price falls to the floor the desk goes dark on its own.
// It therefore only ever moves UP — call once per executed buyback fill.
// NOTE: units are (input raw × 1e6) / afho raw — the SOL leg is NOT in the
// same units as the USDC leg; the real-DEX adapter must report USDC-
// denominated execution price. Fine for the stub era.
pub(crate) fn ratchet_buyback_basis(amm_state: &mut AmmState, executed_price: u64) {
    if executed_price > amm_state.highest_buyback_basis {
        amm_state.highest_buyback_basis = executed_price;
    }
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Invalid market status")]
    InvalidMarketStatus,
    #[msg("Market is not open")]
    InvalidMarketState,
    #[msg("No offers were taken last night — nothing to buy back")]
    NoFillsToBuyBack,
    #[msg("Invalid SOL price oracle")]
    InvalidOracle,
}