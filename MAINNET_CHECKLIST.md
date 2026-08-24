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

## 3. Real price oracles — ⏳ plan: Raydium TWAP + Switchboard(status) + optional JUP(24h)

- [ ] `spot_oracle` → Raydium CPMM pool **TWAP** (`observation_state`), not raw reserves. Used by claims, floor decay, dip trigger.
- [ ] `sol_oracle` → Raydium SOL/USDC pool TWAP.
- [ ] `priceChange24h` (momentum) → keep Jupiter Price API via Switchboard for now (market-wide 24h change); optional later: self-sampled daily diff of the pool TWAP. **Revisit `calculate_momentum_score` weighting once the source changes** (see §9).
- [ ] Staleness/validity checks on whatever replaces the raw-u64 stubs.

## 4. Real DEX integration — ⏳ Raydium CPMM

- [ ] Rewrite `execute_swap` via `raydium_cp_swap` CPI (`swap_base_input`). Spec in `docs/DEX-INTEGRATION.md`. Dep: `raydium-cp-swap` (crates.io).
- [ ] `amm_state.dex_program` → CPMM program; pin pool state/vaults/`amm_config`/`observation_state` in state (H1 re-pin).
- [ ] SOL leg → **WSOL** handling (wrap `sol_vault` lamports) or route through AFHO/USDC only (decision).
- [ ] Adapter reports USDC-denominated exec price for the ratchet.
- [ ] `minimum_amount_out` from the spot oracle (front-line M3 band) inside the CPI.

## 5. Liquidity pool (Raydium CPMM — Token-2022 compatible)

- [x] **Programmatic pool init.** `scripts/mint-launch.ts` now scaffolds `raydium.cpmm.createPool` (devnet; mainnet USDC swap line commented). Replaces the old "manual UI" plan.
- [ ] **Launch split 25% LP / 75% protocol.** Seed via the create-pool call at launch; both sides (AFHO + USDC) from a dedicated LP-funder account, not `afho_vault`.
- [ ] **1% of bond sales → LP until target.** 4th split leg in `offer_claim` routing 1% of proceeds to an LP-funding vault + a permissionless `lp_fund` instruction that CPI-`addLiquidity` until pool liquidity ≥ target. **Target: $100,000** (sanity: at 0.25% fee this is enough to make swap depth / TWAP meaningful; revisit after launch volume).
- [ ] **LP custody.** Burn vs lock LP tokens (Raydium `cpmm.lockLiquidity` supports locking). Protocol-owned PDA affects "target size" measurement + withdrawal risk.

## 6. Bounty / keeper / treasury

- [x] Rotate keeper off authority via `set_keeper` (H1 urgency reduced post-pin, still do it).
- [x] Bounty vault rent floor + setters (L5).
- [x] Bounty pays only on state transitions (rate ~2/day).
- [ ] **Bounty auto-top-up from POSR vault.** When `bounty_vault` SOL < 0.2 SOL, swap AFHO from POSR → SOL via the DEX, then fund `bounty_vault` to 0.4 SOL. (Blocked on §4 swap; POSR vault is staking-owned, so this is an AMM↔staking CPI or a keeper-run swap.)
- [ ] Size bounty amount (`set_bounty_amount`) — 0.005 SOL/transition is fine; tune post-launch.

## 7. Ops / launch sequence

- [x] Staking issues: `amm_stake.rs` is_signer (verify after §4 CPI), `Stake` INIT_SPACE — check.
- [ ] `current_stake_ratio` uses `total_supply` vs circulating (`helpers_make_offers.rs:31-33`) — resolve or accept.
- [x] Fresh `anchor build` + full test suite green (**34/34** local suites).
- [ ] `amm-init` with real mint/pool/oracle addresses; verify `deployment.json` consumed by app.
- [ ] External audit pass on the final diff (§1 fixes + §4 adapter + §5 LP).
- [ ] Doc cleanup: staking header describes removed claim penalties; stale comment in `dex_buyback.rs:332-334`.

## 8. Token / program trust posture

- [x] Revoke **mint authority** (in `mint-launch.ts`); freeze authority already `null`.
- [ ] Revoke **metadata update authority** (immutable name/symbol/URI) — needs the `@solana/spl-token-metadata` update-authority call; add to launch script.
- [ ] **Program upgrade authorities** for amm/staking/crank-oracle → multisig or renounce (separate from the mint; BPFLoader `set_authority`).
- [ ] Burn/lock LP tokens (see §5).
- [ ] No hidden mint path: confirm `mintTo` only via revoked mint authority.

## 9. Momentum metric soundness (question raised)

- [ ] **Review `calculate_momentum_score` weighting.** Current input is `priceChange24h` (centi-percent, 20-day ring). Design intent (more offers in bullish regimes) is sound; the risk is the *source*: if Jupiter's 24h change is unavailable/stale for a fresh mint, `record_price_change` silently skips → flat momentum → conservative offer sizing (safe, but may under-offer). Decide: keep JUP 24h, or switch to self-sampled daily pool-price diffs, and re-tune the bump-taper coefficients against `sim/`.

## 10. Switchboard → mainnet

- [ ] Redeploy feeds to the **mainnet default queue** (`A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w`) — `feed-deploy.ts` currently uses `getDefaultQueue(rpcEndpoint)`; confirm it resolves mainnet.
- [ ] Set mainnet feed job API keys (MASSIVE/EARNINGS/JUP) as `variableOverrides`.
- [ ] Confirm Jupiter indexes the mainnet mint (unlocks the combined `[status, price]` quote); else status-only fallback stays.
- [ ] Mainnet oracle-program/quote-program IDs (see switchboard skill) vs devnet.

## 11. Frontend

- [x] Position card tint by market state (after-hours `#f7dec0`, closed/halted `#ddd6ff`).
- [x] Exit button shows per-state principal-penalty % (incl. 0% open).
- [ ] UI smoke test on devnet for claim/unstake + the new penalty label.

## DEX strategy note

Jupiter is a **router/aggregator**, not a pool — it can't host the protocol-owned liquidity or serve as the CPI swap target for `execute_swap`. Canonical shape: **Raydium CPMM pool** (protocol-seeded, §5) as the pool + price source; Jupiter only for mint indexing (unlocks the combined Switchboard quote) and as an optional sanity oracle — not the swap path.
