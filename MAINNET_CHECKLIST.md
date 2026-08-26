# AFHO Mainnet Checklist

Everything required to go from the current devnet build to a mainnet launch, in rough dependency order. Source: full codebase audit (2026-08-22) + AGENTS.md gotchas + subsequent fixes.

## 1. Blocking security fixes (from audit) — ✅ DONE

- [x] **H1 — keeper can steal swap in-leg funds.** Pinned `pool_afho`/`pool_usdc`/`pool_sol` to the pool's topology in `dex_buyback`, `buy_the_dip`, `distribute_staker_rewards`. Re-pin to Raydium CPMM vault PDAs in §4 (mock pins are mock-specific).
- [x] **M1 — `read_oracle_data` bypasses crank safety.** Added `cranker: Signer`, `bounty_config`/`market_status` seeds, staleness bound, monotonic quote-slot check, `state <= 3`, non-empty feeds.
- [x] **M2 — `calc_completed_offers` scores stale sheets.** Hard-errors unless `offer_list.day_index == yesterday`. (Note: "error" not "skip" — a missed `make_offers` freezes scoring until a new sheet posts.)
- [x] **M3 — predictable slices + unbounded ratchet.** `ratchet_within_band` (5% vs spot oracle) on every fill in all three swap paths; `spot_oracle`/`usdc_mint` accounts added.
- [x] **L1 — day-0 deadlock.** Day-index guards init to `u64::MAX`.
- [x] **L2 — `stake()` arbitrary `index`.** `require!(index == user_index.next_index)`.
- [x] **L3 — unbounded penalty/tax bps.** `require!(bps <= 10_000)` at `initialize_pool` (boxed the `InitializePool` token accounts to keep the SBF frame under 4KB).
- [x] **L4 — unbounded `market_state` / empty feed.** `require!(market_state <= 3)` + `require!(!feeds.is_empty())`.
- [x] **L5 — bounty vault drain / no rotation.** Rent floor + `set_bounty_amount` / `set_authority`.
- [x] **Frontend claim/unstake IDL.** Renamed `posrVault` → `afhoVault` in `useClaimAll.ts` / `useUnstake.ts`. (Needs a devnet UI smoke test.)

### Post-audit hardening (done)

- [x] **SBF stack-budget fixes.** Boxed the large accounts in `make_offers`, `calc_completed_offers`, `update_tradeday_stats`, `load_test_data`, `set_keeper`, and `staking::InitializePool`. Vendored `switchboard-on-demand` to gate `OracleAccountData`'s anchor deserialize on `client` (struct is ~4.8KB > 4KB frame limit). Build is clean of "Stack offset exceeded".
- [x] **Bounty state-change gating.** `permissionless_crank` now pays only on a real market-state transition; heartbeat cranks are free. Burn rate ≈ 0.01–0.02 SOL/day, not slot-cadence-bound.

## 2. Remove devnet-only code — ⏳ keep until §4 lands

- [ ] `programs/mock-dex-pool` (permissionless AFHO faucet — **fatal if shipped**).
- [ ] `load_test_data` (amm), `test_set_state` (crank-oracle), `update_amm_program` (staking).
- [ ] Permissionless `set_price` mock oracle PDAs.
- Note: these stay for devnet testing until the real DEX adapter + oracles (§3/§4) are in and green.

## 3. Real price oracles — 🚧 TWAP module written, not wired

- [x] **Raydium CPMM TWAP reader** exists (`programs/amm/src/instructions/raydium.rs::read_twap_token0_in_token1`) — reads the `observation` ring and computes the time-weighted token_0/token_1 price (Q32.32).
- [ ] `spot_oracle` → wire the CPMM pool **TWAP** (`observation_state`) for claims, floor decay, dip trigger. Currently still the raw-u64 mock PDA.
- [ ] `sol_oracle` → Raydium SOL/USDC pool TWAP (or keep an external SOL/USD feed). Devnet: raw-u64 mock pinned at 200 USDC/SOL (200000) by `amm-init` — the claim prices lamports from it, and the devnet-created SOL/USDC pool is seeded at the same 200:1 parity so min-out math lines up. MAINNET: a real feed + a deep canonical pool are both required (claim reverts when the pool can't deliver ≥98% of the oracle-priced cost).
- [ ] `priceChange24h` (momentum) → keep Jupiter Price API via Switchboard for now (market-wide 24h change); optional later: self-sampled daily diff of the pool TWAP. **Revisit `calculate_momentum_score` weighting once the source changes** (see §9).
- [ ] Staleness/validity checks on whatever replaces the raw-u64 stubs.

## 4. Real DEX integration — 🚧 Raydium CPMM, USDC leg live (Path A raw CPI)

- [x] **Rewrite `execute_swap` via raw `invoke_signed`** (not a typed Anchor CPI — the modern `raydium-cpmm-cpi` crate pins anchor 1.0, incompatible with our 0.31). The `raydium.rs` module builds the exact `swap_base_input` instruction (discriminator + 13 accounts) + PDAs. USDC leg routed when `cpmm_pool_state` is pinned; mock is the fallback.
- [x] **Pin the CPMM in state** — `AmmState.cpmm_program` / `cpmm_pool_state` / `cpmm_amm_config`, set via `set_cpmm_pool` (3 args, authority||keeper) + `scripts/set-cpmm-pool.ts`. Keeper derives the real vault/observation/authority PDAs.
- [ ] **H1 re-pin for CPMM** — the CPMM accounts are currently `UncheckedAccount` (validated only by the CPI); pin `address =` constraints against the derived vault/observation/authority PDAs so a compromised keeper can't redirect them.
- [x] **All-USDC claim conversion + SOL-leg retirement.** `offer_claim_sol` wraps the buyer's SOL → `swap_base_input` on the SOL/USDC pool → splits USDC 80/10/10 into `usdc_vault`/`usdc_dip`/`usdc_rewards`. Buyer covers the CPMM 0.25% input fee (+25bps on the lamports); min-out = 98% of cost (2% tolerance for pool drift/slippage — never binds on a deep mainnet pool). `wsol_vault` ATA is created idempotently on each claim (and in `bounty_top_up`) because the top-up closes it after unwrapping. The SOL swap legs in `dex_buyback`/`buy_the_dip`/`distribute_staker_rewards` are removed (USDC-only); `execute_swap` simplified; `set_sol_usdc_pool` + `cpmm_sol_usdc_pool`/`cpmm_sol_usdc_config` added.
- [ ] Remove the now-dead `sol_vault`/`sol_dip`/`sol_rewards`/`sol_oracle` state fields + accounts (left in place this pass to limit churn).
- [x] **SOL/USDC pool provisioning.** `scripts/set-sol-usdc-pool.ts` pins the pool: env vars (`DEVNET_SOL_USDC_POOL`/`DEVNET_SOL_USDC_CONFIG`) → deployment.json → devnet fallback that creates its own SOL/USDC CPMM pool seeded at 200 USDC/SOL (parity with the mock `sol_oracle`), writing `raydiumSolUsdcPool`/`raydiumSolUsdcConfig`. MAINNET: set the env vars to the canonical Raydium SOL/USDC pool — see §7.
- [ ] Devnet runtime-verify the SOL claim end-to-end (pool created + pinned now; claim swap + wSOL wrap still need a live run).
- [x] **`minimum_amount_out`** from the spot oracle (front-line M3 band) inside the CPI — done for the USDC leg.
- [x] **USDC-denominated exec price for the ratchet** — post-swap `(usdc_raw × 1e6)/afho_raw` reload + `ratchet_within_band` (unchanged).

## 5. Liquidity pool (Raydium CPMM — Token-2022 compatible)

- [x] **Programmatic pool init.** `scripts/mint-launch.ts` creates the devnet CPMM pool via `raydium.cpmm.createPool` and writes `raydiumPool`/`raydiumAmmConfig`/`raydiumProgram` to `deployment.json` (mainnet USDC swap line commented). Replaces the old "manual UI" plan.
- [ ] **Launch split 25% LP / 75% protocol.** Seed via the create-pool call at launch; both sides (AFHO + USDC) from a dedicated LP-funder account, not `afho_vault`. **Where the numbers live:** `scripts/mint-launch.ts` — `amountToMint` (supply) and `seedAfho`/`seedUsdc` (pool seed), marked with `⚠️ MAINNET LAUNCH SPLIT` comments. Swap the devnet test amounts for the real 25/75 split there.
- [ ] **1% of bond sales → LP until target.** 4th split leg in `offer_claim` routing 1% of proceeds to an LP-funding vault + a permissionless `lp_fund` instruction that CPI-`addLiquidity` until pool liquidity ≥ target. **Target: $100,000** (sanity: at 0.25% fee this is enough to make swap depth / TWAP meaningful; revisit after launch volume).
- [ ] **LP custody.** Burn vs lock LP tokens (Raydium `cpmm.lockLiquidity` supports locking). Protocol-owned PDA affects "target size" measurement + withdrawal risk.

## 6. Bounty / keeper / treasury

- [x] Rotate keeper off authority via `set_keeper` (H1 urgency reduced post-pin, still do it).
- [x] Bounty vault rent floor + setters (L5).
- [x] Bounty pays only on state transitions (rate ~2/day).
- [x] **Bounty auto-top-up implemented (`bounty_top_up`, permissionless).** When `bounty_vault` SOL < 0.2 SOL: swap USDC → wSOL through the pinned SOL/USDC pool (USDC from `usdc_vault` — the buyback vault, per the All-USDC route), unwrap via `close_account` into `bounty_vault` up to 0.4 SOL. `wsol_vault` ATA created idempotently each run. NOTE: the earlier "fund from POSR vault" idea was superseded by the All-USDC treasury model — this tops up from the same buyback vault that feeds buybacks/dip/rewards.
- [ ] Devnet runtime-verify `bounty_top_up` (drain `bounty_vault` below 0.2 SOL, crank it, confirm it refills to 0.4 SOL).
- [ ] Size bounty amount (`set_bounty_amount`) — 0.005 SOL/transition is fine; tune post-launch.
- [ ] resize  bounty amount to be priced in USD..?


## 7. Ops / launch sequence

- [x] Staking issues: `amm_stake.rs` is_signer (verify after §4 CPI), `Stake` INIT_SPACE — check.
- [ ] `current_stake_ratio` uses `total_supply` vs circulating (`helpers_make_offers.rs:31-33`) — resolve or accept.
- [x] Fresh `anchor build` + full test suite green (**34/34** local suites).
- [x] **Devnet end-to-end rig** — `anchor run mint` (fresh mint + AFHO/USDC CPMM pool) → `anchor run amm-init` (now also initializes the **staking pool**) → `anchor run set-cpmm-pool` (pins program+pool+config) → `anchor run set-sol-usdc-pool` (pins/creates the SOL/USDC pool) → `anchor run bount` (keeper derives CPMM accounts). USDC legs live; SOL claim leg live on devnet pending a runtime claim test. (`scripts/pool-init.ts` still exists as a standalone staking backfill.)
- [ ] `amm-init` with real mint/pool/oracle addresses; verify `deployment.json` consumed by app.
- [ ] External audit pass on the final diff (§1 fixes + §4 adapter + §5 LP).
- [ ] Doc cleanup: staking header describes removed claim penalties; stale comment in `dex_buyback.rs:332-334`.

## 8. Token / program trust posture

- [x] Revoke **mint authority** (in `mint-launch.ts`); freeze authority already `null`.
- [x] Revoke **metadata update authority** (immutable name/symbol/URI) — `createUpdateAuthorityInstruction` (`newAuthority: null`) added to `mint-launch.ts`.
- [ ] **Program upgrade authorities** for amm/staking/crank-oracle → renounce or multisig. Not blocked — it's a deploy-side CLI step (needs the deployer keypair + a live program): `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority 11111111111111111111111111111111` (burn address = immutability) or point at a multisig. Do at launch after the final audit-pass deploy.
- [x] **Burn LP tokens (smoke test)** — `createBurnInstruction` on the LP mint added to `mint-launch.ts` (1 raw LP, devnet). MAINNET custody decision (burn-all vs `cpmm.lockLiquidity`) still §5.
- [ ] No hidden mint path: confirm `mintTo` only via revoked mint authority.

## 9. Momentum metric soundness — 🚧 rework to self-sampled pool price

- [x] **Source swap + sampling cadence.** Momentum now reads the **spot oracle's close→close change** (`record_price_change` computes `(close−prev)/prev × 10000` centi-percent into the same `price_changes[20]` ring), instead of Jupiter's `priceChange24h`. Cadence is per-trading-day (one close per day). `MarketMetrics.daily_close` holds the baseline.
- [ ] Wire the spot oracle itself to the Raydium pool TWAP (see §3) — currently still the raw-u64 mock PDA.
- [ ] **Diagnosis (done):** design is sound and source-agnostic. Edge: `raw == 0` reads as "no sample", so a perfectly flat market doesn't count toward `MIN_SAMPLES=5`.
- [ ] Re-tune bump-taper coefficients against `sim/` once the source is a live pool price (single venue, not JUP's aggregate).
- [ ] **Diagnosis (done, see below):** the momentum→offer-size design is sound and source-agnostic; only the input changes. Notable edge: `raw == 0` reads as "no sample", so a perfectly flat market doesn't count toward `MIN_SAMPLES=5` and the desk can read cold on a flat open.
- [ ] Re-tune bump-taper coefficients against `sim/` once the source is in (pool price is a single venue, not JUP's market-wide aggregate).

## 10. Switchboard → mainnet

- [x] **Status-only quote.** `feed-deploy.ts` now deploys just the market-status feed (JUP price feed removed); the keeper already falls back to status-only when `priceFeedId` is absent.
- [ ] Redeploy feeds to the **mainnet default queue** (`A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w`) — `feed-deploy.ts` uses `getDefaultQueue(rpcEndpoint)`; confirm it resolves mainnet.
- [ ] Set mainnet feed job API keys (MASSIVE/EARNINGS) as `variableOverrides`.
- [ ] Mainnet oracle-program/quote-program IDs (see switchboard skill) vs devnet.

## 11. Frontend

- [x] Position card tint by market state (after-hours `#f7dec0`, closed/halted `#ddd6ff`).
- [x] Exit button shows per-state principal-penalty % (incl. 0% open).
- [ ] UI smoke test on devnet for claim/unstake + the new penalty label.

## DEX strategy note

Jupiter is a **router/aggregator**, not a pool — it can't host the protocol-owned liquidity or serve as the CPI swap target for `execute_swap`. Canonical shape: **Raydium CPMM pool** (protocol-seeded, §5) as the pool + price source; Jupiter only for mint indexing (unlocks the combined Switchboard quote) and as an optional sanity oracle — not the swap path.
