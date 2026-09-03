//! Raw Raydium CPMM integration (Path A — no typed CPI dependency).
//!
//! The modern CPMM CPI crate (`raydium-cpmm-cpi`) pins `anchor-lang =1.0.2`,
//! which is incompatible with this repo's anchor 0.31. Rather than upgrade the
//! whole workspace, the CPMM `swap_base_input` instruction is built by hand and
//! invoked with `invoke_signed`.
//!
//! Reference: https://github.com/raydium-io/raydium-cpi (`programs/cpmm-cpi`)
//!   mainnet CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
//!   devnet  DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

/// Pool authority / vault / LP-mint authority PDA seed.
pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const OBSERVATION_SEED: &[u8] = b"observation";

/// 8-byte anchor discriminator = sha256("global:swap_base_input")[..8].
pub const SWAP_BASE_INPUT_DISCRIMINATOR: [u8; 8] =
    [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];

pub const OBSERVATION_NUM: usize = 100;
/// Q32.32 scale used by the cumulative price accumulators.
pub const Q32: u128 = 1 << 32;

// ────────────────────────────── PDA derivation ──────────────────────────────

fn sorted(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// `["pool", amm_config, token_0_mint, token_1_mint]` with mints sorted.
pub fn pool_state_pda(
    program: &Pubkey,
    amm_config: Pubkey,
    mint_a: Pubkey,
    mint_b: Pubkey,
) -> (Pubkey, u8) {
    let (t0, t1) = sorted(mint_a, mint_b);
    Pubkey::find_program_address(
        &[POOL_SEED, amm_config.as_ref(), t0.as_ref(), t1.as_ref()],
        program,
    )
}

/// `["pool_vault", pool_state, mint]`.
pub fn pool_vault_pda(program: &Pubkey, pool_state: Pubkey, mint: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_VAULT_SEED, pool_state.as_ref(), mint.as_ref()], program)
}

/// `["observation", pool_state]`.
pub fn observation_pda(program: &Pubkey, pool_state: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[OBSERVATION_SEED, pool_state.as_ref()], program)
}

/// `["vault_and_lp_mint_auth_seed"]`.
pub fn pool_authority_pda(program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[AUTH_SEED], program)
}

// ────────────────────────────── state layouts ───────────────────────────────

/// One element of the CPMM oracle ring. `#[repr(C, packed)]`, no anchor
/// discriminator (zero-copy account).
#[repr(C, packed)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Observation {
    pub block_timestamp: u64,
    /// cumulative `token_1 per token_0` price, Q32.32 (×2^32), time-integrated.
    pub cumulative_token_0_price_x32: u128,
    /// cumulative `token_0 per token_1` price, Q32.32 (×2^32), time-integrated.
    pub cumulative_token_1_price_x32: u128,
}

/// The on-chain oracle account (`["observation", pool_state]`), an anchor
/// `#[account(zero_copy)]` account. On-chain layout (verified against devnet):
///   discriminator: [u8;8] (= sha256("account:ObservationState")[..8]),
///   initialized: u8, observation_index: u16, pool_id: [u8;32],
///   observations: [Observation; 100], padding: [u64; 4].
/// The 8-byte discriminator IS present in the raw account data, unlike the
/// struct's own fields.
pub const OBSERVATION_STATE_DISCRIMINATOR_LEN: usize = 8;
pub const OBSERVATION_STATE_HEADER_LEN: usize = 8 + 1 + 2 + 32;

// ────────────────────────────── swap CPI ────────────────────────────────────

/// Build the raw `swap_base_input` instruction. The caller must assemble the
/// matching `&[AccountInfo]` (same order as the accounts below) and call
/// `invoke_signed` with the AMM PDA's seeds, because `payer` signs the swap.
#[allow(clippy::too_many_arguments)]
pub fn cpmm_swap_base_input_ix(
    program: Pubkey,
    // payer is the authority of the input/output token accounts (our PDA signs)
    payer: Pubkey,
    authority: Pubkey,
    amm_config: Pubkey,
    pool_state: Pubkey,
    input_token_account: Pubkey,
    output_token_account: Pubkey,
    input_vault: Pubkey,
    output_vault: Pubkey,
    input_token_program: Pubkey,
    output_token_program: Pubkey,
    input_token_mint: Pubkey,
    output_token_mint: Pubkey,
    observation_state: Pubkey,
    amount_in: u64,
    minimum_amount_out: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 8 + 8);
    data.extend_from_slice(&SWAP_BASE_INPUT_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());

    Instruction {
        program_id: program,
        accounts: vec![
            // payer — signer, read-only
            AccountMeta::new_readonly(payer, true),
            // authority (pool vault/LP-mint authority PDA) — read-only
            AccountMeta::new_readonly(authority, false),
            // amm_config — read-only
            AccountMeta::new_readonly(amm_config, false),
            // pool_state — writable
            AccountMeta::new(pool_state, false),
            // input_token_account — writable
            AccountMeta::new(input_token_account, false),
            // output_token_account — writable
            AccountMeta::new(output_token_account, false),
            // input_vault — writable
            AccountMeta::new(input_vault, false),
            // output_vault — writable
            AccountMeta::new(output_vault, false),
            // input_token_program — read-only
            AccountMeta::new_readonly(input_token_program, false),
            // output_token_program — read-only
            AccountMeta::new_readonly(output_token_program, false),
            // input_token_mint — read-only
            AccountMeta::new_readonly(input_token_mint, false),
            // output_token_mint — read-only
            AccountMeta::new_readonly(output_token_mint, false),
            // observation_state — writable
            AccountMeta::new(observation_state, false),
        ],
        data,
    }
}

/// The account-metas order the CPI expects (exposed so callers can build the
/// matching `&[AccountInfo]` without re-deriving the ordering).
pub const SWAP_ACCOUNT_KEYS: usize = 13;

// ────────────────────────────── oracle (TWAP) ───────────────────────────────

/// Time-weighted average price of `token_0` denominated in `token_1`, as Q32
/// (×2^32), over the last `window_seconds`.
///
/// Returns `None` when the oracle isn't initialized or there aren't two
/// observations spanning the window. `cumulative_token_0_price_x32` accrues
/// "token_1 per token_0", so this is the price a unit of token_0 fetches in
/// token_1 (for an AFHO/USDC pool with AFHO as token_0, that's USDC per AFHO).
pub fn read_twap_token0_in_token1(
    observation_data: &[u8],
    now: u64,
    window_seconds: u64,
) -> Option<u128> {
    const HEADER: usize = OBSERVATION_STATE_HEADER_LEN;
    const DISC: usize = OBSERVATION_STATE_DISCRIMINATOR_LEN;
    if observation_data.len() < HEADER + OBSERVATION_NUM * size_of_observation() {
        return None;
    }
    if observation_data[DISC] == 0 {
        return None; // oracle not initialized
    }
    let observation_index =
        u16::from_le_bytes(observation_data[DISC + 1..DISC + 3].try_into().ok()?) as usize;
    let obs = &observation_data[HEADER..HEADER + OBSERVATION_NUM * size_of_observation()];

    let read = |idx: usize| -> Observation {
        let s = (idx % OBSERVATION_NUM) * size_of_observation();
        *bytemuck::from_bytes::<Observation>(&obs[s..s + size_of_observation()])
    };

    let latest = read(observation_index);
    if latest.block_timestamp == 0 {
        return None;
    }
    // Walk backwards to the newest observation at or before (now - window).
    let mut oldest: Option<Observation> = None;
    for step in 0..OBSERVATION_NUM {
        let idx = (observation_index + OBSERVATION_NUM - step) % OBSERVATION_NUM;
        let o = read(idx);
        if o.block_timestamp == 0 {
            break;
        }
        oldest = Some(o);
        if o.block_timestamp <= now.saturating_sub(window_seconds)
            || o.block_timestamp <= latest.block_timestamp.saturating_sub(window_seconds)
        {
            break;
        }
    }
    let oldest = oldest?;
    let dt = latest.block_timestamp.saturating_sub(oldest.block_timestamp);
    if dt == 0 {
        return None;
    }
    // The ring must be dense enough to actually span the requested window — a
    // sparse ring (a long gap between trades) would otherwise return a stale
    // TWAP over a much longer interval than the caller asked for.
    if dt > window_seconds.saturating_mul(2) {
        return None;
    }
    let dcum = latest
        .cumulative_token_0_price_x32
        .saturating_sub(oldest.cumulative_token_0_price_x32);
    Some(dcum / dt as u128)
}

/// Verify a full pinned SOL/USDC CPMM account set (wSOL in, USDC out). No-op
/// when the pool isn't pinned.
#[allow(clippy::too_many_arguments)]
pub fn pinned_sol_usdc_accounts_valid(
    cpmm_program: Pubkey,
    pool_state: Pubkey,
    amm_config: Pubkey,
    wrapped_sol_mint: Pubkey,
    usdc_mint: Pubkey,
    acct_pool_state: &AccountInfo,
    acct_amm_config: &AccountInfo,
    acct_wrapped_sol_vault: &AccountInfo,
    acct_usdc_vault: &AccountInfo,
    acct_observation: &AccountInfo,
    acct_authority: &AccountInfo,
) -> bool {
    let (obs, _) = observation_pda(&cpmm_program, pool_state);
    let (wsol_vault, _) = pool_vault_pda(&cpmm_program, pool_state, wrapped_sol_mint);
    let (usdc_vault, _) = pool_vault_pda(&cpmm_program, pool_state, usdc_mint);
    let (authority, _) = pool_authority_pda(&cpmm_program);
    let ok = acct_pool_state.key() == pool_state
        && acct_amm_config.key() == amm_config
        && acct_wrapped_sol_vault.key() == wsol_vault
        && acct_usdc_vault.key() == usdc_vault
        && acct_observation.key() == obs
        && acct_authority.key() == authority;
    if !ok {
        msg!(
            "SOL/USDC CPMM account pin mismatch: pool {} amm_config {} wsol_vault {} usdc_vault {} observation {} authority {}",
            acct_pool_state.key(),
            acct_amm_config.key(),
            acct_wrapped_sol_vault.key(),
            acct_usdc_vault.key(),
            acct_observation.key(),
            acct_authority.key(),
        );
    }
    ok
}

const fn size_of_observation() -> usize {
    std::mem::size_of::<Observation>()
}

// ────────────────────────────── floor-units pricing ─────────────────────────

/// TWAP lookback window. Long enough to be manipulation-resistant, short
/// enough that a freshly-created protocol pool arms quickly once the keeper's
/// swap slices begin writing observations.
pub const TWAP_WINDOW_SECONDS: u64 = 600;

/// Maximum age of the LATEST observation for the TWAP to be considered fresh.
/// Set to one window (600s): if the pool hasn't traded in the last 10 minutes
/// the TWAP is treated as stale and we use the instantaneous vault ratio
/// instead (which is always current, not stale).
pub const TWAP_MAX_AGE_SECONDS: u64 = 600;

/// Conversion factor from a Q32.32 whole-token price to this protocol's
/// floor-units price: floor = (quote_raw × 1e6) / base_raw. With both the
/// AFHO/USDC and SOL/USDC pools using 9-dp base / 6-dp quote tokens, a Q32
/// quote-per-base price × 1000 == floor units.
/// Floor units = USDC price per whole token × 1e9 (nano-dollar). This scale
/// must represent sub-cent launch prices (a $1,300 LP against 250M AFHO is
/// $5.2e-6 → 5,200 floor units) while keeping headroom: u64 holds up to
/// ~$1.8e10 per token.
pub const FLOOR_UNITS_PER_Q32: u128 = 1_000_000_000;

/// Latest observation timestamp (the ring's `observation_index` points at the
/// most recently written entry).
pub fn observation_latest_timestamp(observation_data: &[u8]) -> Option<u64> {
    const DISC: usize = OBSERVATION_STATE_DISCRIMINATOR_LEN;
    const HEADER: usize = OBSERVATION_STATE_HEADER_LEN;
    if observation_data.len() < HEADER + size_of_observation() {
        return None;
    }
    if observation_data[DISC] == 0 {
        return None;
    }
    let index = u16::from_le_bytes(observation_data[DISC + 1..DISC + 3].try_into().ok()?) as usize;
    let s = HEADER + (index % OBSERVATION_NUM) * size_of_observation();
    Some(u64::from_le_bytes(observation_data[s..s + 8].try_into().ok()?))
}

/// Token-account `amount` field (u64 LE at offset 64), identical for classic
/// SPL and Token-2022.
pub fn token_account_amount(account: &AccountInfo) -> Option<u64> {
    let data = account.try_borrow_data().ok()?;
    Some(u64::from_le_bytes(data.get(64..72)?.try_into().ok()?))
}

/// CPMM pool-state mints: token_0 at offset 168, token_1 at offset 200
/// (after the 8-byte discriminator + config_id/pool_creator/vaults/lp_mint).
pub fn pool_state_mints(pool_state: &AccountInfo) -> Option<(Pubkey, Pubkey)> {
    let data = pool_state.try_borrow_data().ok()?;
    let token_0 = Pubkey::try_from(data.get(168..200)?).ok()?;
    let token_1 = Pubkey::try_from(data.get(200..232)?).ok()?;
    Some((token_0, token_1))
}

/// Convert a token_0-in-token_1 Q32 TWAP to floor units for the requested
/// base/quote pair. Handles the pool listing the pair in either order.
fn q32_to_floor(twap_q32: u128, token_0: Pubkey, token_1: Pubkey, base: Pubkey, quote: Pubkey) -> Option<u64> {
    let price_q32 = if token_0 == base && token_1 == quote {
        twap_q32
    } else if token_0 == quote && token_1 == base {
        // Invert: 1 / (twap / Q32) = Q32^2 / twap.
        (Q32 as u128).checked_mul(Q32 as u128)?.checked_div(twap_q32)?
    } else {
        return None; // pool does not contain this pair
    };
    if price_q32 == 0 {
        return None;
    }
    let floor = price_q32.checked_mul(FLOOR_UNITS_PER_Q32)?.checked_div(Q32 as u128)?;
    Some(u64::try_from(floor).ok()?)
}

/// Floor-units price of `base_mint` quoted in `quote_mint` from a pinned CPMM
/// pool. Primary: observation-ring TWAP over `TWAP_WINDOW_SECONDS`. Fallback:
/// the pool's instantaneous constant-product ratio (quote_vault.amount /
/// base_vault.amount) — used while the ring is still warming up.
/// Returns `None` when the pool is unreadable or the pair doesn't match.
pub fn read_cpmm_price_floor(
    pool_state: &AccountInfo,
    observation: &AccountInfo,
    base_vault: &AccountInfo,
    quote_vault: &AccountInfo,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    now: u64,
) -> Option<u64> {
    let (token_0, token_1) = pool_state_mints(pool_state)?;
    if let Ok(obs) = observation.try_borrow_data() {
        // Only trust the TWAP when the latest observation is fresh — a stale
        // ring can encode a long-gone price (e.g. a pool that was repriced
        // after a quiet period).
        if let Some(latest_ts) = observation_latest_timestamp(&obs) {
            let fresh = now.saturating_sub(latest_ts) <= TWAP_MAX_AGE_SECONDS;
            if fresh {
                if let Some(twap) = read_twap_token0_in_token1(&obs, now, TWAP_WINDOW_SECONDS) {
                    if let Some(floor) = q32_to_floor(twap, token_0, token_1, *base_mint, *quote_mint) {
                        if floor > 0 {
                            return Some(floor);
                        }
                    }
                }
            }
        }
    }
    // Instant spot fallback from the pool's two token vaults.
    let base_raw = token_account_amount(base_vault)?;
    let quote_raw = token_account_amount(quote_vault)?;
    if base_raw == 0 {
        return None;
    }
    Some(u64::try_from(quote_raw as u128 * 1_000_000_000_000u128 / base_raw as u128).ok()?)
}

/// Unified price reader for the whole AMM: the pinned CPMM pool's TWAP,
/// with the pool's own instantaneous vault-ratio as the in-pool fallback.
/// Returns `None` when no price is available — callers fail closed on it.
/// The legacy raw-u64 mock oracle is gone: an unpinned pool is a hard error
/// at the instruction level, never a stub price.
#[allow(clippy::too_many_arguments)]
pub fn read_price(
    pool_state: &AccountInfo,
    observation: &AccountInfo,
    base_vault: &AccountInfo,
    quote_vault: &AccountInfo,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    now: u64,
) -> Option<u64> {
    read_cpmm_price_floor(
        pool_state,
        observation,
        base_vault,
        quote_vault,
        base_mint,
        quote_mint,
        now,
    )
}

/// Verify a full pinned-CPMM account set against the addresses derived from
/// `amm_state` (H1 re-pin: a compromised keeper can't redirect the pricing
/// reads or the swap in/out vaults). The pool is REQUIRED to be pinned —
/// callers check `cpmm_pool_state != default` before calling. Returns false
/// with a `msg!` on any mismatch.
#[allow(clippy::too_many_arguments)]
pub fn pinned_pool_accounts_valid(
    cpmm_program: Pubkey,
    pool_state: Pubkey,
    amm_config: Pubkey,
    afho_mint: Pubkey,
    usdc_mint: Pubkey,
    acct_pool_state: &AccountInfo,
    acct_amm_config: &AccountInfo,
    acct_afho_vault: &AccountInfo,
    acct_usdc_vault: &AccountInfo,
    acct_observation: &AccountInfo,
    acct_authority: &AccountInfo,
) -> bool {
    let (obs, _) = observation_pda(&cpmm_program, pool_state);
    let (afho_vault, _) = pool_vault_pda(&cpmm_program, pool_state, afho_mint);
    let (usdc_vault, _) = pool_vault_pda(&cpmm_program, pool_state, usdc_mint);
    let (authority, _) = pool_authority_pda(&cpmm_program);
    let ok = acct_pool_state.key() == pool_state
        && acct_amm_config.key() == amm_config
        && acct_afho_vault.key() == afho_vault
        && acct_usdc_vault.key() == usdc_vault
        && acct_observation.key() == obs
        && acct_authority.key() == authority;
    if !ok {
        msg!(
            "CPMM account pin mismatch: pool {} amm_config {} afho_vault {} usdc_vault {} observation {} authority {}",
            acct_pool_state.key(),
            acct_amm_config.key(),
            acct_afho_vault.key(),
            acct_usdc_vault.key(),
            acct_observation.key(),
            acct_authority.key(),
        );
    }
    ok
}
