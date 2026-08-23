// programs/amm/src/instructions/buy_the_dip.rs
//
// The dip buyer — "always on" counterpart to dex_buyback. Not gated on market
// state, not gated on offer fills: any time the live spot price sits below
// the recent norm, the protocol spends a slice of the dip reserve (the 10%
// claim split) buying AFHO back.
//
// Spec (modeled in sim/dip.py + sim/run_dip.py — see those for evidence):
//   reference = mean of the nonzero samples in the high-frequency spot ring
//               (MarketMetrics.spot_prices, self-sampled on every call,
//               throttled to one write per SPOT_SAMPLE_SLOTS)
//   depth_bps = (reference - spot) * 10000 / reference
//   trigger   : depth_bps >= DIP_TRIGGER_BPS (3% below the recent norm)
//   size      = DIP_BASE_SPEND_BPS x (depth/FULL_DEPTH)^2 x trend_mult
//               quadratic: a 3% dip spends 9% of base, 6% spends 36%, 10%
//               spends 100% — shallow dips stay cheap, powder kept for deeper
//   trend_mult= clamp(10000 + slope*10, 2500, 12500) where slope is the
//               recent-5 minus older-15 mean of the 20-day price_changes ring
//               (same split/clamp as momentum): uptrend pullback -> buy harder,
//               chained metric rolling over -> knife guard at 25%
//   day cap   = DIP_DAY_CAP_BPS of the day-start reserve snapshot per leg
//   pacing    = one slice per DIP_MIN_SLICE_SLOTS (same rhythm as dex_buyback)
//
// Fills ratchet highest_buyback_basis exactly like dex_buyback fills (the
// ratchet only moves up, so cheap dip buys never lower the offer-desk floor).
// Bought AFHO lands in the main afho_vault — desk inventory.
//
// NOTE (mainnet): spot_oracle / sol_oracle are raw-u64 mock PDAs on devnet;
// swap in the real price-source adapters with the real DEX pool.

use crate::state::offersState::{AmmState, MarketMetrics};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::dex_buyback::{execute_swap, ratchet_buyback_basis, SwapInfos};
use super::offer_claim::read_live_price;

// Spot ring: ~30s between samples, 32 slots of history, 5 samples before the
// trigger arms (cold start = no dip buys).
const SPOT_SAMPLE_SLOTS: u64 = 75;
const SPOT_MIN_SAMPLES: usize = 5;

// Trigger/sizing (bps of reference depth, bps of reserve).
const DIP_TRIGGER_BPS: u64 = 300; // 3% below the recent norm
const DIP_FULL_DEPTH_BPS: u64 = 1_000; // 10% below = full aggression
const DIP_BASE_SPEND_BPS: u64 = 2_500; // 25% of reserve at full depth, flat trend
const DIP_TREND_GAIN: i64 = 10; // multiplier bps per centi-percent of slope
const DIP_TREND_FLOOR_BPS: i64 = 2_500; // knife guard: 25% of base
const DIP_TREND_CAP_BPS: i64 = 12_500; // uptrend boost: 125% of base
const DIP_DAY_CAP_BPS: u64 = 4_000; // <=40% of the day-start reserve per leg
const DIP_MIN_SLICE_SLOTS: u64 = 150;

// Same per-sample clamp as calculate_momentum_score.
const SAMPLE_CAP_CP: i64 = 1_000;

#[derive(Accounts)]
pub struct BuyTheDip<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: market status PDA — only the day index is read (dip buys are
    /// allowed in EVERY market state; the day index drives the daily cap)
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"metrics", amm_state.afho_mint.as_ref()], bump)]
    pub metrics: Box<Account<'info, MarketMetrics>>,

    /// CHECK: live absolute spot price (raw-u64 mock PDA on devnet; real
    /// price source adapter at mainnet). Address pinned at init.
    #[account(address = amm_state.spot_oracle)]
    pub spot_oracle: UncheckedAccount<'info>,
    /// CHECK: SOL/USD price oracle — SOL-leg fills are converted to USDC
    /// units with this before ratcheting the floor
    #[account(address = amm_state.sol_oracle)]
    pub sol_oracle: UncheckedAccount<'info>,

    /// 10% claim split — USDC dip reserve (PDA token account, amm_state signs)
    #[account(mut, address = amm_state.usdc_dip)]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: SOL dip reserve (space-0 system PDA)
    #[account(mut, address = amm_state.sol_dip)]
    pub sol_dip: AccountInfo<'info>,
    /// Swap out-leg destination: main desk inventory
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
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
    /// CHECK: lamport destination for the SOL leg (mock ignores it)
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

// Mean of the nonzero spot-ring samples + how many there were.
fn spot_reference(metrics: &MarketMetrics) -> (u64, usize) {
    let mut sum: u128 = 0;
    let mut n: usize = 0;
    for &p in metrics.spot_prices.iter() {
        if p > 0 {
            sum += p as u128;
            n += 1;
        }
    }
    if n == 0 {
        return (0, 0);
    }
    ((sum / n as u128) as u64, n)
}

// Slope of the chained 20-day metric: recent-5 mean minus older-15 mean,
// centi-percent (exact port of sim/dip.py::trend_slope_cp; truncating
// division, ±SAMPLE_CAP_CP per sample, 0 reads as "no sample").
fn trend_slope_cp(metrics: &MarketMetrics) -> i64 {
    const RECENT: usize = 5;
    let n = metrics.price_changes.len();
    let head = metrics.sample_head as usize % n;
    let mut recent_sum: i64 = 0;
    let mut recent_n: i64 = 0;
    let mut older_sum: i64 = 0;
    let mut older_n: i64 = 0;
    for age in 0..n {
        let raw = metrics.price_changes[(head + age) % n];
        if raw == 0 {
            continue;
        }
        let v = (raw as i64).clamp(-SAMPLE_CAP_CP, SAMPLE_CAP_CP);
        if age >= n - RECENT {
            recent_sum += v;
            recent_n += 1;
        } else {
            older_sum += v;
            older_n += 1;
        }
    }
    let recent = if recent_n > 0 { recent_sum / recent_n } else { 0 };
    let older = if older_n > 0 { older_sum / older_n } else { 0 };
    recent - older
}

// bps of the current dip reserve to spend on this slice (0 = no buy).
fn dip_spend_bps(depth_bps: u64, slope_cp: i64) -> u64 {
    if depth_bps < DIP_TRIGGER_BPS {
        return 0;
    }
    let clamped = depth_bps.min(DIP_FULL_DEPTH_BPS) as u128;
    // quadratic depth: (depth/FULL_DEPTH)^2 in bps
    let depth2 =
        clamped * clamped * 10_000u128 / (DIP_FULL_DEPTH_BPS as u128 * DIP_FULL_DEPTH_BPS as u128);
    let mult =
        (10_000i64 + slope_cp * DIP_TREND_GAIN).clamp(DIP_TREND_FLOOR_BPS, DIP_TREND_CAP_BPS);
    (DIP_BASE_SPEND_BPS as u128 * depth2 * mult as u128 / 100_000_000u128) as u64
}

pub fn handler(ctx: Context<BuyTheDip>) -> Result<()> {
    let swap = SwapInfos {
        amm_state: ctx.accounts.amm_state.to_account_info(),
        // the vault slots carry the DIP reserve vaults here
        usdc_vault: ctx.accounts.usdc_dip.to_account_info(),
        afho_vault: ctx.accounts.afho_vault.to_account_info(),
        sol_vault: ctx.accounts.sol_dip.to_account_info(),
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
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());

    let clock = Clock::get()?;
    let spot = read_live_price(&ctx.accounts.spot_oracle.to_account_info())?;
    require!(spot > 0, ErrorCode::InvalidOracle);

    let metrics = &mut ctx.accounts.metrics;

    // Reference = mean of the ring BEFORE this sample goes in, so the fresh
    // (dipped) price doesn't dilute the norm it's measured against.
    let (reference, samples) = spot_reference(metrics);

    // Self-sample the spot price (throttled) — the keeper calling this
    // instruction on every loop is what keeps the ring fresh.
    if clock.slot.saturating_sub(metrics.spot_last_slot) >= SPOT_SAMPLE_SLOTS {
        let head = (metrics.spot_head as usize) % metrics.spot_prices.len();
        metrics.spot_prices[head] = spot;
        metrics.spot_head = ((head + 1) % metrics.spot_prices.len()) as u8;
        metrics.spot_last_slot = clock.slot;
    }

    // Cold start: not enough reference history yet — no dip buys.
    if samples < SPOT_MIN_SAMPLES {
        return Ok(());
    }
    // At/above the norm — nothing to do.
    if spot >= reference {
        return Ok(());
    }
    let depth_bps = ((reference - spot) as u128 * 10_000u128 / reference as u128) as u64;
    let slope = trend_slope_cp(metrics);
    let spend_bps = dip_spend_bps(depth_bps, slope);
    if spend_bps == 0 {
        return Ok(());
    }

    // Rent floor for the space-0 system PDA sol_dip.
    let sol_floor = Rent::get()?.minimum_balance(0);

    // New trading day: snapshot the dip reserves as today's budget base.
    if amm_state.dip_day_index != current_day {
        amm_state.dip_day_index = current_day;
        amm_state.dip_day_usdc = ctx.accounts.usdc_dip.amount;
        amm_state.dip_day_sol = ctx.accounts.sol_dip.lamports().saturating_sub(sol_floor);
        amm_state.dip_spent_usdc = 0;
        amm_state.dip_spent_sol = 0;
        amm_state.dip_slice_count = 0;
        amm_state.dip_last_slot = 0;
    }

    // Pacing: at most one slice per DIP_MIN_SLICE_SLOTS.
    if amm_state.dip_last_slot != 0 && clock.slot - amm_state.dip_last_slot < DIP_MIN_SLICE_SLOTS {
        return Ok(());
    }

    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;
    let sol_dip_bump = amm_state.sol_dip_bump;

    // ---- USDC leg ----
    let day_cap_usdc = amm_state.dip_day_usdc as u128 * DIP_DAY_CAP_BPS as u128 / 10_000u128;
    let cap_left_usdc = day_cap_usdc.saturating_sub(amm_state.dip_spent_usdc as u128) as u64;
    let slice_usdc = (ctx.accounts.usdc_dip.amount as u128 * spend_bps as u128 / 10_000u128) as u64;
    let slice_usdc = slice_usdc.min(cap_left_usdc);
    if slice_usdc > 0 {
        let before = ctx.accounts.afho_vault.amount;
        execute_swap(&swap, mint_key, state_bump, b"amm_sol_dip", sol_dip_bump, slice_usdc, false)?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            ratchet_buyback_basis(amm_state, (slice_usdc as u128 * 1_000_000 / out as u128) as u64);
        }
        amm_state.dip_spent_usdc += slice_usdc;
    }

    // ---- SOL leg ----
    let day_cap_sol = amm_state.dip_day_sol as u128 * DIP_DAY_CAP_BPS as u128 / 10_000u128;
    let cap_left_sol = day_cap_sol.saturating_sub(amm_state.dip_spent_sol as u128) as u64;
    let sol_available = ctx.accounts.sol_dip.lamports().saturating_sub(sol_floor);
    let slice_sol = (sol_available as u128 * spend_bps as u128 / 10_000u128) as u64;
    let slice_sol = slice_sol.min(cap_left_sol);
    if slice_sol > 0 {
        let before = ctx.accounts.afho_vault.amount;
        execute_swap(&swap, mint_key, state_bump, b"amm_sol_dip", sol_dip_bump, slice_sol, true)?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            // Ratchet in USDC units (lamports x sol_price / out), same as
            // dex_buyback's SOL leg — never mix units in the floor.
            let sol_price = read_live_price(&ctx.accounts.sol_oracle.to_account_info())?;
            require!(sol_price > 0, ErrorCode::InvalidOracle);
            let px = (slice_sol as u128).saturating_mul(sol_price as u128) / out as u128;
            ratchet_buyback_basis(amm_state, u64::try_from(px).unwrap_or(u64::MAX));
        }
        amm_state.dip_spent_sol += slice_sol;
    }

    if slice_usdc == 0 && slice_sol == 0 {
        return Ok(()); // day cap exhausted / empty reserves
    }

    amm_state.dip_slice_count += 1;
    amm_state.dip_last_slot = clock.slot;
    msg!(
        "dip slice {}: depth {}bps, slope {}cp, spend {}bps -> {} usdc, {} sol (spent {}/{} usdc, {}/{} sol)",
        amm_state.dip_slice_count,
        depth_bps,
        slope,
        spend_bps,
        slice_usdc,
        slice_sol,
        amm_state.dip_spent_usdc,
        amm_state.dip_day_usdc,
        amm_state.dip_spent_sol,
        amm_state.dip_day_sol,
    );
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Invalid market status")]
    InvalidMarketStatus,
    #[msg("Invalid price oracle")]
    InvalidOracle,
}
