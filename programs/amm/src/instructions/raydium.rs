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

/// The on-chain oracle account (`["observation", pool_state]`), zero-copy, no
/// anchor discriminator. Layout:
///   initialized: u8, observation_index: u16, pool_id: [u8;32],
///   observations: [Observation; 100], padding: [u64; 4].
pub const OBSERVATION_STATE_HEADER_LEN: usize = 1 + 2 + 32;

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
    if observation_data.len() < HEADER + OBSERVATION_NUM * size_of_observation() {
        return None;
    }
    if observation_data[0] == 0 {
        return None; // oracle not initialized
    }
    let observation_index = u16::from_le_bytes(observation_data[1..3].try_into().ok()?) as usize;
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
    let dcum = latest
        .cumulative_token_0_price_x32
        .saturating_sub(oldest.cumulative_token_0_price_x32);
    Some(dcum / dt as u128)
}

const fn size_of_observation() -> usize {
    std::mem::size_of::<Observation>()
}
