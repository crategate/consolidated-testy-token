# AFHO Mainnet Checklist

Everything required to go from the current devnet build to a mainnet launch, in rough dependency order. Source: full codebase audit (2026-08-22) + AGENTS.md gotchas. File:line refs point at the code as of that audit.

## 1. Blocking security fixes (from audit)

- [ ] **H1 — keeper can steal swap in-leg funds.** `pool_usdc` is mint-constrained only and `pool_sol` is unconstrained in `dex_buyback.rs:59-66`, `buy_the_dip.rs:104-110`, `distribute_staker_rewards.rs:64-71`; `execute_swap` (`dex_buyback.rs:272`) pays the in-leg before the CPI and never validates the recipients. A compromised keeper pockets the day's buyback/dip/rewards spend. Fix when writing the real-DEX adapter: pin pool receiving accounts in state (`address =` constraints) or have the CPI validate both legs.
- [ ] **M1 — `read_oracle_data` bypasses crank safety** (`crank-oracle/src/lib.rs:113-154`). No staleness bound, no monotonic quote-slot check, no signer, no `seeds = [b"market_status"]` — anyone can write a stale quote's state/day into the canonical market-status PDA. Add the same guards as `permissionless_crank`.
- [ ] **M2 — `calc_completed_offers` scores stale sheets** (`calc_completed_offers.rs:64-113`). No `offer_list.day_index` freshness check: a missed `make_offers` night double-counts fill %, and a partially-filled stale sheet keeps `untaken_days` reset forever — permanently blocking ratchet-floor decay, the desk's only bear-market escape. Require the scored sheet to be yesterday's or skip.
- [ ] **M3 — predictable slices + unbounded ratchet.** Buyback/dip slices fire on a public 150-slot cadence with derivable sizes (sandwichable), and every fill ratchets `highest_buyback_basis` from raw exec price with no oracle bound — a price spike into a fill can pin the floor above market and DoS the desk. Cap per-fill slippage vs. spot oracle; only ratchet fills within a tolerance band.
- [ ] **L1 — day-0 deadlock.** All `*_day_index` guards init to 0 and the first trading day is day 0, so `make_offers` / `update_tradeday_stats` / `calc_completed_offers` fail their idempotency checks on launch day. Init guards to `u64::MAX`.
- [ ] **L2 — `stake()` takes arbitrary `index`/`days`** (`staking/src/lib.rs:234-287`): `index = u64::MAX` panics; `days = 0` makes locks decorative for direct stakers. Require `index == user_index.next_index`.
- [ ] **L3 — unbounded penalty/tax bps at `initialize_pool`** (`staking/src/lib.rs:84-130`): penalty > 10_000 bps drains the shared vault via the rewards leg. `require!(each_bps <= 10_000)`.
- [ ] **L4 — unbounded `market_state` / empty feed panic** (`crank-oracle/src/lib.rs:65-82`): `require!(market_state <= 3)`, `require!(!feeds.is_empty())`.
- [ ] **L5 — bounty vault drain-to-zero / no rotation** (`crank-oracle/src/lib.rs:96-103, 194-211`): keep a rent floor (`>= bounty + minimum_balance(1)`), add authority-gated setters for `bounty_amount`/authority.
- [ ] **Frontend claim/unstake broken against current IDL** — `app/src/hooks/stake/useClaimAll.ts:47-58` and `useUnstake.ts:73-85` pass `posrVault` and omit the required `afhoVault`; rename `posrVault` → `afhoVault` (same `[b"posr", pool]` PDA). As written, UI claim/exit transactions fail to build.

## 2. Remove devnet-only code

- [ ] `programs/mock-dex-pool` entirely — its `send_afho` is a permissionless free-AFHO faucet; **fatal if shipped**.
- [ ] `load_test_data` (amm), `test_set_state` (crank-oracle), `update_amm_program` (staking).
- [ ] Permissionless `set_price` mock oracle PDAs.

## 3. Real price oracles (replace raw-u64 stubs)

- [ ] `price_oracle` / `spot_oracle`: real absolute-price source in floor units (usdc_raw×1e6/afho_raw) — `read_live_price` (`offer_claim.rs:579`) currently trusts one stale-able u64 with no staleness/validity check. Claims, floor decay, dip trigger all depend on it. Add staleness bounds.
- [ ] `sol_oracle`: real SOL/USD feed for SOL-leg pricing/ratchets (`dex_buyback.rs:241`, `buy_the_dip.rs:299`).
- [ ] Switchboard combined `[status, price]` quote resolves on mainnet once Jupiter indexes the mint (devnet gotcha disappears); keeper fallback path still worth keeping.

## 4. Real DEX integration (see "DEX strategy" below)

- [ ] Rewrite `execute_swap` (`dex_buyback.rs:272-326`) against the real pool — the ONLY swap-agnostic seam; used by `dex_buyback`, `buy_the_dip`, `distribute_staker_rewards`.
- [ ] Adapter must report a USDC-denominated exec price for the ratchet (both legs same units).
- [ ] `amm_state.dex_program` pointed at the real pool program at init.
- [ ] Close H1's account-validation gap in the same pass.

## 5. Liquidity pool (Raydium CPMM — supports Token-2022, AFHO-compatible)

- [ ] **Launch split 25% LP / 75% protocol vault**: do it manually at launch via the Raydium UI — it's a one-off; codifying buys nothing. (Automating = a custom init-time CPI creating the CPMM pool + deposit; real risk, zero recurring value.)
- [ ] **1% of bond sales → LP until target size**: requires (a) a 4th split leg in `offer_claim` routing 1% of proceeds to an LP-funding vault, (b) a target-size check, (c) a periodic permissionless `lp_fund` instruction that CPI-deposits into the CPMM pool (both sides — AFHO from `afho_vault` + USDC/SOL from the skim) until the pool's liquidity ≥ target. Moderate lift (~1 new instruction + split change + keeper hook), blocked on §4's real pool existing. Keeper calls it per loop like `buyTheDip`.
- [ ] Decide LP custody: burned/locked LP tokens vs. protocol-owned PDA (affects withdrawal risk and the "target size" measurement).

## 6. Ops / launch sequence

- [ ] Rotate keeper off the authority key via `set_keeper` (H1 makes this urgent even before the fix).
- [ ] Fund + size the bounty vault; monitor drain rate (bounty pays once per fresh quote slot on the status crank only — buyback/dip loops cost the keeper tx fees only).
- [ ] Fix known staking issues: `amm_stake.rs` `is_signer` check blocking offer_claim CPI; `Stake` position space INIT_SPACE.
- [ ] `current_stake_ratio` uses `total_supply` instead of circulating (`helpers_make_offers.rs:31-33`) — resolve or accept.
- [ ] Fresh `anchor build` + full test suite green (26/26 local suites as of 2026-08-22).
- [ ] `amm-init` with real mint/pool/oracle addresses; verify `deployment.json` consumed by the app.
- [ ] External audit pass on the final diff (this checklist's §1 fixes included).
- [ ] Doc cleanup: staking header describes removed claim penalties (`staking/src/lib.rs:37-41`); stale comment in `dex_buyback.rs:332-334`.

## DEX strategy note

Jupiter is a **router/aggregator**, not a pool — it can't host the protocol-owned liquidity or serve as the CPI swap target for `execute_swap`. The right mainnet shape: Raydium CPMM pool (protocol-seeded, §5) as the canonical pool + price source; optionally route through Jupiter *inside* the adapter if better execution exists elsewhere, but that adds JITO-sized complexity for little gain at launch volume. The Jupiter skill's relevant pieces for launch: making sure the mint is indexed (unlocks the combined Switchboard quote) and the Price API for a sanity-check oracle — not the swap path.
