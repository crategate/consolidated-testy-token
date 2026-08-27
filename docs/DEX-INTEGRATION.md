# Real-DEX Swap Adapter — Raydium CPMM (spec)

How the `execute_swap` seam in `programs/amm/src/instructions/dex_buyback.rs`
gets rewired to a real Raydium pool. Source: the Raydium skill
(`~/.deepseek/skills/raydium`), specifically `resources/program-ids.md`'s CPMM
CPI example and `examples/swap` + `examples/cpmm-pool`.

## What the Raydium skill gives us

The skill is the definitive reference for the pieces we need:

- **CPMM program IDs** — mainnet `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`,
  devnet `CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW`.
- **The exact Rust CPI** — `raydium_cpi::cpmm::cpi::swap_base_input(...)`, which
  is the on-chain equivalent of the SDK's `raydium.cpmm.swap(...)`.
- **Pool topology** — CPMM pools are Token-2022 friendly and don't need
  OpenBook, matching the AFHO mint (Token-2022) and the checklist's §5 choice.

Note the skill's own `swap`/`cpmm-pool` examples are **TypeScript SDK** (client
side) — those are for off-chain tooling (the one-off launch pool, ops scripts).
The on-chain adapter must use the **Rust `raydium_cpi`** crate, which the skill
links (`raydium-io/raydium-cpi`) and quotes directly.

## The seam (unchanged from the mock era)

```rust
pub(crate) fn execute_swap(
    swap: &SwapInfos,
    mint_key: Pubkey,
    state_bump: u8,
    sol_vault_seed: &[u8],
    sol_vault_bump: u8,
    amount_in: u64,
    sol_in: bool,
) -> Result<()>
```

Everything else in `dex_buyback` / `buy_the_dip` / `distribute_staker_rewards`
is swap-agnostic (budgeting, pacing, ratchet band, vault accounting). Only this
function (plus the `SwapInfos`/account-struct pinning) changes.

## USDC leg — clean mapping

`swap_base_input` moves the input *from* `input_token_account` *into* the pool's
`input_vault`, and the output *from* the pool's `output_vault` *into*
`output_token_account` — i.e. the CPI does **both** legs. Mapping to `SwapInfos`:

| CPMM `Swap` account | AMM account today | Note |
|---|---|---|
| `payer` | `amm_state` (PDA, signs via seeds) | currently the in-leg authority |
| `authority` | CPMM pool authority PDA | derived from `pool_state` |
| `amm_config` | new account | CPMM config account |
| `pool_state` | `pool_state` | re-point `dex_program` to CPMM |
| `input_token_account` | `usdc_vault` | ATA of `amm_state` |
| `output_token_account` | `afho_vault` | ATA of `amm_state` |
| `input_vault` | new — CPMM USDC vault | pool's USDC reserve |
| `output_vault` | new — CPMM AFHO vault | pool's AFHO reserve |
| `input_token_program` | `token_program` | USDC (classic SPL) |
| `output_token_program` | `token_2022_program` | AFHO (Token-2022) |
| `input_token_mint` | `usdc_mint` | |
| `output_token_mint` | `afho_mint` | |
| `observation_state` | new account | CPMM price observation |

The in-leg token transfer and the mock `send_afho` CPI are both deleted and
replaced by a single:

```rust
raydium_cpi::cpmm::cpi::swap_base_input(
    CpiContext::new_with_signer(
        swap.dex_program,
        raydium_cpi::cpmm::cpi::accounts::Swap { /* mapping above */ },
        &[amm_state_seeds],
    ),
    amount_in,
    minimum_amount_out,
)?;
```

## SOL leg — the one real adaptation

Raydium CPMM pairs use **WSOL**, not native SOL. The AMM's `sol_vault` is a
native-lamport system PDA, so the SOL leg cannot feed the pool directly. Options
(decide before mainnet):

1. **WSOL reserve** — wrap the `sol_vault` lamports into a WSOL ATA owned by
   `amm_state` (`sync_native`), then swap WSOL → AFHO through the pool. The AMM
   already signs for its own vaults, so this is mechanical; it just adds a
   WSOL ATA to state + init.
2. **Single-USDC pool only** — route SOL proceeds through the AFHO/USDC pool by
   first converting SOL → USDC (either a small AFHO/SOL CPMM pool or an external
   aggregator). More surface area; avoid at launch.

Recommendation: option 1 (keep both legs, WSOL-wrap the SOL vault).

## H1 re-pinning (must change, don't ship the mock pins)

The mock pinned `pool_afho`/`pool_usdc` as ATAs of `pool_state` and
`pool_sol = pool_state`. CPMM vaults are **not** ATAs of `pool_state` — they are
their own PDAs derived from the pool. The H1 fix must be re-expressed as
`address =` constraints against the CPMM vault PDAs (derived in state or via
constraint), so a compromised keeper still can't redirect the in/out legs.

## M3 hardens at the CPI level

`minimum_amount_out` should be computed from `spot_oracle` with the same
`MAX_SLIPPAGE_BPS` band, e.g. `min_out = amount_in * 1e6 / (spot * (1 + band))`.
This bounds the swap's realized price *inside* the CPI (atomic), instead of the
current post-hoc revert. Keep `ratchet_within_band` for the floor ratchet; the
min-out is the front-line sandwich defense.

## What's blocking the code now (not a skill gap)

The pool doesn't exist until the §5 launch (one-off CPMM create + seed). Writing
the Rust CPI now would target a pool address that isn't pinned anywhere yet. The
dependency work (add `raydium_cpi` to `programs/amm/Cargo.toml`, repin accounts,
add WSOL + `amm_config`/`observation_state` to init) is well-understood and can
be scaffolded as soon as the launch pool address + fee config are chosen.
