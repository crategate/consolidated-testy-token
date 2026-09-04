use crate::state::offersState::{AcceptedOffers, AmmState};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

// Minimum slots between slices (~1 min) — pacing so one crank burst can't
// drain the day's budget in a single block.
const MIN_SLICE_SLOTS: u64 = 400;
// Slice weights: 1.9% of remaining budget during the first hour after open,
// 5% after. With ~1 slice/min (36 first-hour slices) ~50% of the day's volume
// lands in the first hour on average; the 5% tail spends the rest by close.
const FIRST_HOUR_WEIGHT_BPS: u64 = 190;
const TAIL_WEIGHT_BPS: u64 = 500;

// M3 — per-fill sanity band vs the spot oracle: a fill whose exec price
// overpays the oracle by more than this reverts the whole tx (the swap rolls
// back with it), and the floor ratchets only inside the band — a price spike
// into a fill can't pin the offer-desk floor above market.
pub(crate) const MAX_SLIPPAGE_BPS: u64 = 500; // 5%

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
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- Raydium CPMM — the ONLY swap venue and price source. The pool pins
    // (program/pool/config) live in AmmState via set_cpmm_pool; the handler
    // hard-errors when they are unset, and validates every account below
    // against the pool's own derived PDAs (H1 re-pin). ---
    /// CHECK: CPMM pool state PDA (pinned in state via set_cpmm_pool)
    #[account(mut)]
    pub cpmm_pool_state: UncheckedAccount<'info>,
    /// CHECK: CPMM amm_config (pinned in state via set_cpmm_pool)
    pub cpmm_amm_config: UncheckedAccount<'info>,
    /// CHECK: pool's input (USDC) vault
    #[account(mut)]
    pub cpmm_input_vault: UncheckedAccount<'info>,
    /// CHECK: pool's output (AFHO) vault
    #[account(mut)]
    pub cpmm_output_vault: UncheckedAccount<'info>,
    /// CHECK: pool's observation (TWAP) account
    #[account(mut)]
    pub cpmm_observation: UncheckedAccount<'info>,
    /// CHECK: pool authority PDA (signs vault/LP-mint transfers)
    pub cpmm_authority: UncheckedAccount<'info>,
    /// CHECK: the Raydium CPMM program itself — the runtime refuses the CPI
    /// unless the callee program is among the caller instruction's accounts;
    /// address-pinned to AmmState.cpmm_program.
    #[account(address = amm_state.cpmm_program)]
    pub cpmm_program: UncheckedAccount<'info>,

    /// Classic SPL (USDC in-leg)
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (AFHO out-leg via the pool)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

// AccountInfo clones handed to the swap adapter, collected before amm_state
// is mutably borrowed (avoids whole-struct borrow conflicts). Shared with
// distribute_staker_rewards — the `usdc_vault` slot holds whichever vault
// funds the swap (buyback vault or staker-rewards holding vault).
pub(crate) struct SwapInfos<'info> {
    pub amm_state: AccountInfo<'info>,
    pub usdc_vault: AccountInfo<'info>,
    pub afho_vault: AccountInfo<'info>,
    pub afho_mint: AccountInfo<'info>,
    pub usdc_mint: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub token_2022_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    pub cpmm_pool_state: AccountInfo<'info>,
    pub cpmm_amm_config: AccountInfo<'info>,
    pub cpmm_input_vault: AccountInfo<'info>,
    pub cpmm_output_vault: AccountInfo<'info>,
    pub cpmm_observation: AccountInfo<'info>,
    pub cpmm_authority: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DexBuyback>) -> Result<()> {
    let swap = SwapInfos {
        amm_state: ctx.accounts.amm_state.to_account_info(),
        usdc_vault: ctx.accounts.usdc_vault.to_account_info(),
        afho_vault: ctx.accounts.afho_vault.to_account_info(),
        afho_mint: ctx.accounts.afho_mint.to_account_info(),
        usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
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

    // The CPMM pool is the only swap venue: hard-error when unpinned.
    require!(
        amm_state.cpmm_pool_state != Pubkey::default(),
        ErrorCode::PoolNotPinned
    );
    // H1 re-pin: the swap/pricing accounts must be the pool's own derived
    // PDAs.
    require!(
        super::raydium::pinned_pool_accounts_valid(
            amm_state.cpmm_program,
            amm_state.cpmm_pool_state,
            amm_state.cpmm_amm_config,
            ctx.accounts.afho_mint.key(),
            ctx.accounts.usdc_mint.key(),
            &ctx.accounts.cpmm_pool_state.to_account_info(),
            &ctx.accounts.cpmm_amm_config.to_account_info(),
            &ctx.accounts.cpmm_output_vault.to_account_info(),
            &ctx.accounts.cpmm_input_vault.to_account_info(),
            &ctx.accounts.cpmm_observation.to_account_info(),
            &ctx.accounts.cpmm_authority.to_account_info(),
        ),
        ErrorCode::InvalidPoolAccount
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

    // New trading day: snapshot the USDC vault balance as today's budget.
    // Unspent budget stays in the vault — rollover needs no bookkeeping.
    if amm_state.bb_day_index != current_day {
        amm_state.bb_day_index = current_day;
        amm_state.bb_budget_usdc = ctx.accounts.usdc_vault.amount;
        amm_state.bb_spent_usdc = 0;
        amm_state.bb_slice_count = 0;
        amm_state.bb_last_slot = 0;
    }

    // Pacing: at most one slice per MIN_SLICE_SLOTS.
    if amm_state.bb_last_slot != 0 && clock.slot - amm_state.bb_last_slot < MIN_SLICE_SLOTS {
        return Ok(());
    }

    let remaining_usdc = amm_state
        .bb_budget_usdc
        .saturating_sub(amm_state.bb_spent_usdc)
        .min(ctx.accounts.usdc_vault.amount);
    if remaining_usdc == 0 {
        return Ok(());
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

    // USDC leg.
    let slice_usdc = ((remaining_usdc as u128 * weight_bps as u128 * factor_bps as u128)
        / 100_000_000u128) as u64;
    let slice_usdc = slice_usdc.min(remaining_usdc);
    if slice_usdc > 0 {
        // Live AFHO/USDC price in floor units: pinned CPMM pool TWAP with
        // the pool's own vault-ratio fallback. The mock oracle is gone.
        let spot = super::raydium::read_price(
            &ctx.accounts.cpmm_pool_state.to_account_info(),
            &ctx.accounts.cpmm_observation.to_account_info(),
            &ctx.accounts.cpmm_output_vault.to_account_info(), // AFHO (base) vault
            &ctx.accounts.cpmm_input_vault.to_account_info(),  // USDC (quote) vault
            &ctx.accounts.afho_mint.key(),
            &ctx.accounts.usdc_mint.key(),
            clock.unix_timestamp as u64,
        )
        .ok_or(ErrorCode::InvalidOracle)?;
        // min-out for the CPMM swap: preview the pool's actual constant-product
        // output from its vault balances. The old TWAP-anchored floor ignored
        // the trade's own price impact and lagged the live pool during the
        // day's buyback climb — a rising pool pays fewer AFHO than the stale
        // TWAP floor demands, failing slices with Raydium 0x1775. Residual
        // tolerance stays MAX_SLIPPAGE_BPS (5%) for the input fee + concurrent
        // trades; flat-floor fallback only if the vaults are unreadable.
        let min_out = super::raydium::cpmm_swap_min_out_from_vaults(
            &swap.cpmm_input_vault,  // pool USDC (input) vault
            &swap.cpmm_output_vault, // pool AFHO (output) vault
            slice_usdc,
            MAX_SLIPPAGE_BPS,
        )
        .unwrap_or_else(|| {
            if spot > 0 {
                (slice_usdc as u128 * 1_000_000_000_000u128 * 10_000u128
                    / (spot as u128 * (10_000 + MAX_SLIPPAGE_BPS) as u128)) as u64
            } else {
                0
            }
        });
        let before = ctx.accounts.afho_vault.amount;
        execute_swap(
            &swap,
            mint_key,
            state_bump,
            slice_usdc,
            min_out,
            amm_state.cpmm_program,
        )?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            ratchet_within_band(
                amm_state,
                (slice_usdc as u128 * 1_000_000_000_000 / out as u128) as u64,
                spot,
            )?;
        }
        amm_state.bb_spent_usdc += slice_usdc;
    }

    amm_state.bb_slice_count += 1;
    amm_state.bb_last_slot = clock.slot;
    msg!(
        "buyback slice {}: {} usdc (spent {}/{})",
        amm_state.bb_slice_count,
        slice_usdc,
        amm_state.bb_spent_usdc,
        amm_state.bb_budget_usdc,
    );
    Ok(())
}

// Swap adapter: USDC → AFHO via Raydium CPMM swap_base_input ONLY (raw
// invoke_signed — raydium-cpmm-cpi pins anchor 1.0, incompatible with anchor
// 0.31). The mock-dex-pool venue is gone; callers hard-error when the pool
// is unpinned. Everything else in this file is swap-agnostic.
pub(crate) fn execute_swap(
    swap: &SwapInfos,
    mint_key: Pubkey,
    state_bump: u8,
    amount_in: u64,
    min_amount_out: u64,
    cpmm_program: Pubkey,
) -> Result<()> {
    let pool_state = &swap.cpmm_pool_state;
    let amm_config = &swap.cpmm_amm_config;
    let input_vault = &swap.cpmm_input_vault;
    let output_vault = &swap.cpmm_output_vault;
    let observation = &swap.cpmm_observation;
    let authority = &swap.cpmm_authority;
    let ix = crate::instructions::raydium::cpmm_swap_base_input_ix(
        cpmm_program,
        swap.amm_state.key(), // payer (PDA signs)
        authority.key(),
        amm_config.key(),
        pool_state.key(),
        swap.usdc_vault.key(), // input_token_account
        swap.afho_vault.key(), // output_token_account
        input_vault.key(),
        output_vault.key(),
        swap.token_program.key(),      // input token program (USDC)
        swap.token_2022_program.key(), // output token program (AFHO)
        swap.usdc_mint.key(),          // input token mint
        swap.afho_mint.key(),          // output token mint
        observation.key(),
        amount_in,
        min_amount_out,
    );
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    let infos = vec![
        swap.amm_state.clone(),
        authority.clone(),
        amm_config.clone(),
        pool_state.clone(),
        swap.usdc_vault.clone(),
        swap.afho_vault.clone(),
        input_vault.clone(),
        output_vault.clone(),
        swap.token_program.to_account_info(),
        swap.token_2022_program.to_account_info(),
        swap.usdc_mint.clone(),
        swap.afho_mint.clone(),
        observation.clone(),
    ];
    anchor_lang::solana_program::program::invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

// The ratchet floor is the offer desk's ONLY bear-shutdown mechanism:
// make_offers may never price a lot below the highest realized buyback price,
// so when the live price falls to the floor the desk goes dark on its own.
// It therefore only ever moves UP — call once per executed buyback fill.
// Units: (input raw × 1e6) / afho raw — USDC-denominated for both swap paths.
// buy_the_dip and distribute_staker_rewards ratchet through the same helper.
pub(crate) fn ratchet_buyback_basis(amm_state: &mut AmmState, executed_price: u64) {
    if executed_price > amm_state.highest_buyback_basis {
        amm_state.highest_buyback_basis = executed_price;
    }
}

// M3 — gate a fill's ratchet on the spot-oracle band (MAX_SLIPPAGE_BPS).
// Overpaying fills are a hard error, reverting the whole tx — the in-leg
// transfer and the out-leg CPI roll back with it. In-band fills ratchet;
// underpaying fills (exec below oracle) ratchet too — they can only move the
// floor up BELOW market, never pin it above. Missing/unreadable/zero oracle
// fails closed (the read_price check).
pub(crate) fn ratchet_within_band(
    amm_state: &mut AmmState,
    exec_price: u64,
    oracle_price: u64,
) -> Result<()> {
    require!(oracle_price > 0, ErrorCode::InvalidOracle);
    let cap = (oracle_price as u128 * (10_000 + MAX_SLIPPAGE_BPS) as u128 / 10_000) as u64;
    require!(exec_price <= cap, ErrorCode::SlippageExceeded);
    ratchet_buyback_basis(amm_state, exec_price);
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
    #[msg("No offers were taken last night — nothing to buy back")]
    NoFillsToBuyBack,
    #[msg("Fill exec price overpays the spot oracle beyond MAX_SLIPPAGE_BPS")]
    SlippageExceeded,
    #[msg("Invalid SOL price oracle")]
    InvalidOracle,
    #[msg("CPMM pool account mismatch")]
    InvalidPoolAccount,
    #[msg("CPMM pool not pinned — run set_cpmm_pool")]
    PoolNotPinned,
}

