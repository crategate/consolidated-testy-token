# Real-DEX Swap Adapter — Raydium CPMM (implemented)

How `execute_swap` in `programs/amm/src/instructions/dex_buyback.rs` is wired
to Raydium CPMM. **Status: implemented** (raw `invoke_signed`, USDC-only) —
this doc describes what the code does, not a plan. The earlier draft of this
doc prescribed the typed `raydium_cpi` crate CPI; that route was abandoned
because `raydium-cpmm-cpi` pins anchor 1.0, incompatible with this repo's
anchor 0.31. The adapter is hand-built in `programs/amm/src/instructions/raydium.rs`
(`cpmm_swap_base_input_ix` + the TWAP/price readers).

## What the Raydium skill gives us

- **CPMM program IDs** — mainnet `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`,
  devnet `CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW`.
- **Pool topology** — CPMM pools are Token-2022 friendly, matching the AFHO
  mint (Token-2022).
- **Vault/observation/authority PDAs** — derived from the pool state with
  `b"pool_vault"` / `b"observation"` / `b"vault_and_lp_mint_auth_seed"`; used by
  `pinned_pool_accounts_valid` / `pinned_sol_usdc_accounts_valid` to gate the
  swap and pricing accounts (H1 re-pin).

## The seam (current signature)

```rust
pub(crate) fn execute_swap(
    swap: &SwapInfos,
    mint_key: Pubkey,
    state_bump: u8,
    amount_in: u64,
    min_amount_out: u64,
    cpmm_program: Pubkey,
    cpmm_active: bool,
) -> Result<()>
```

Everything else in `dex_buyback` / `buy_the_dip` is swap-agnostic (budgeting,
pacing, ratchet band, vault accounting). `cpmm_active` is
`amm_state.cpmm_pool_state != Pubkey::default()` — when the pool is pinned the
CPMM path runs; otherwise (localnet tests) the mock-dex-pool fallback runs.
USDC in-leg only: the SOL legs in `dex_buyback` / `buy_the_dip` /
`distribute_staker_rewards` are retired (see "SOL handling" below).

## USDC leg — the CPMM path

`swap_base_input` moves the input *from* `input_token_account` *into* the pool's
`input_vault`, and the output *from* the pool's `output_vault` *into*
`output_token_account` — the CPI does **both** legs. Mapping:

| CPMM `Swap` account | AMM account | Note |
|---|---|---|
| `payer` | `amm_state` (PDA, signs via seeds) | in-leg authority |
| `authority` | CPMM pool authority PDA | derived from `pool_state` |
| `amm_config` | `cpmm_amm_config` | pinned in state via `set_cpmm_pool` |
| `pool_state` | `cpmm_pool_state` | pinned in state |
| `input_token_account` | `usdc_vault` | ATA of `amm_state` |
| `output_token_account` | `afho_vault` | ATA of `amm_state` |
| `input_vault` | `cpmm_input_vault` | pool's USDC reserve |
| `output_vault` | `cpmm_output_vault` | pool's AFHO reserve |
| `input_token_program` | `token_program` | USDC (classic SPL) |
| `output_token_program` | `token_2022_program` | AFHO (Token-2022) |
| `input_token_mint` | `usdc_mint` | |
| `output_token_mint` | `afho_mint` | |
| `observation_state` | `cpmm_observation` | CPMM price observation |

The instruction is built by `raydium::cpmm_swap_base_input_ix` and executed
with `program::invoke_signed` (no typed CPI), signing with the `amm_state` seeds:

```rust
let ix = cpmm_swap_base_input_ix(cpmm_program, /* payer */ swap.amm_state.key(),
    authority.key(), amm_config.key(), pool_state.key(),
    swap.usdc_vault.key(), swap.afho_vault.key(),
    input_vault.key(), output_vault.key(),
    swap.token_program.key(), swap.token_2022_program.key(),
    swap.usdc_mint.key(), swap.afho_mint.key(), observation.key(),
    amount_in, min_amount_out)?;
program::invoke_signed(&ix, &infos, &[amm_state_seeds])?;
```

## SOL handling (retired / converted, not a swap leg)

The old native-SOL in-leg (wrap `sol_vault` lamports, swap WSOL → AFHO) is
**removed**. SOL enters the protocol only through `offer_claim_sol`, which wraps
the buyer's lamports into the `wsol_vault` ATA and swaps SOL → USDC on the
pinned SOL/USDC CPMM pool, then splits USDC 80/10/10 — so every downstream swap
and every ratchet is USDC-denominated. `bounty_top_up` likewise hops
AFHO → USDC → wSOL → lamports to fund the keeper bounty. The legacy
`sol_vault` / `sol_dip` / `sol_rewards` / `sol_oracle` accounts still exist in
the instruction structs but are vestigial (see MAINNET_CHECKLIST §4 — remove
them with the state-field cleanup).

## H1 re-pinning (implemented)

CPMM vaults are **not** ATAs of `pool_state` — they are their own PDAs derived
from the pool. Whenever the pool is pinned, `pinned_pool_accounts_valid` /
`pinned_sol_usdc_accounts_valid` verify the passed pool/observation/vault/
authority accounts against those derived PDAs (and `require_pinned_pricing_accounts`
does the same for the claim paths), so a compromised keeper can't redirect the
pricing reads or the swap in/out legs.

## M3 hardened at the CPI level (implemented)

`minimum_amount_out` is computed from the spot oracle with the same
`MAX_SLIPPAGE_BPS` band before the CPI — `min_out = amount_in * 1e6 /
(spot * (1 + band))` — bounding the realized price *inside* the atomic swap.
`ratchet_within_band` still ratchets the floor post-swap from the reloaded
vault deltas.

## What remains for mainnet

- §2 of MAINNET_CHECKLIST: delete the mock fallback path (mock-dex-pool,
  `send_afho` CPI, `dex_program`) once localnet tests migrate off it.
- §4: remove the vestigial SOL accounts + `sol_*`/`sol_oracle` state fields.
- §5: seed the mainnet CPMM pool (25% LP / 75% protocol) and pin it with
  `set_cpmm_pool` + `set_sol_usdc_pool`.
- Devnet runtime-verify the SOL claim + `bounty_top_up` end-to-end.
