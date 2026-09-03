# AFHO Mainnet Checklist

Everything required to go from the current devnet build to a mainnet launch, in rough dependency order. Source: full codebase audit (2026-08-22) + AGENTS.md gotchas + subsequent fixes.

## 1. Blocking security fixes (from audit) — DONE

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

### Re-audit fixes (2026-08-31) — DONE

- [x] **S1 — staking vault accounts unpinned (HIGH).** `stake`/`claim`/`unstake`/`deposit_rewards` accepted any pool-owned token account as vault (only `token::authority = pool`), letting a staker back a position with reward-vault tokens (free weight, reward dilution). Pinned `address = pool.vault` / `pool.reward_vault` / `pool.penalty_vault`; added `has_one = mint` to `Stake.pool`.
- [x] **S2 — keeper could re-pin the swap pools (HIGH).** `set_cpmm_pool` / `set_sol_usdc_pool` accepted `authority || keeper`; pool pinning routes every swap + claim pricing, so a compromised hot-wallet keeper could repin to its own pool and extract up to the M3 band per slice. Now authority-only.
- [x] **S3 — `read_oracle_data` quote-replay griefing (HIGH).** The non-paying crank path wrote market state without consuming the quote slot, so the same fresh quote could be replayed to burn a transition before the paying cranker saw it. It now sets `last_crank_slot = quote_slot` (and `bounty_config` is `mut`).
- [x] **S4 — `bounty_top_up` leg-2 min-out was 0 (MED).** Added the same 98% (2% drift) min-out used on the claim path so a manipulated SOL/USDC pool can't eat the conversion.
- [x] **S5 — investigated & cleared (not a bug):** every `token_program`/`token_2022_program` field is typed `Interface<'info, TokenInterface>`, which Anchor validates against `[Token, Token-2022]` program IDs — a caller cannot substitute a no-op token program to claim free positions. Keep the `Interface` typing; don't downgrade to `UncheckedAccount`.
- [x] **Stale comment/doc pass.** Rewrote the retired-SOL-leg comments in `dex_buyback`/`buy_the_dip`/`distribute_staker_rewards`/`initialize`/`offersState`, the `priceChange24h` → close→close labels, the legacy Switchboard `price_oracle` notes, the staking header's removed claim penalties, crank-oracle's Cargo description + read-path comment, `docs/DEX-INTEGRATION.md` (now describes the raw-`invoke_signed` implementation), and the stale AGENTS.md gotchas.

## 2. Remove devnet-only code — §3/§4 landed; removal blocked only on migrating localnet tests off the mock fallback

- [ ] `programs/mock-dex-pool` (permissionless AFHO faucet — **fatal if shipped**).
- [ ] `load_test_data` + `load_offers` (amm, incl. `scripts/amm-offers.ts`), `test_set_state` (crank-oracle), `update_amm_program` (staking).
- [ ] Permissionless `set_price` mock oracle PDAs.
- [ ] `test_set_state` has **no on-chain gate at all** (no signer, no state bound) — the devnet check lives only in `scripts/oracle/set-oracle-state.ts`. If it must exist at deploy time, cfg-gate it (`#[cfg(feature = "devnet")]`); otherwise delete it before any non-devnet deploy.
- Note: the mock fallback in `execute_swap` + the vestigial `sol_*` accounts (§4) are what localnet tests still depend on — delete them together in one pass.

## 3. Real price oracles — TWAP wired (devnet-verifiable), mock kept as localnet-only fallback

- [x] **Raydium CPMM TWAP reader** (`programs/amm/src/instructions/raydium.rs::read_twap_token0_in_token1`) — reads the `observation` ring and computes the time-weighted token_0/token_1 price (Q32.32). Fixed the ring layout (the account has an 8-byte anchor discriminator the reader originally skipped) and added a window-density guard (sparse rings fall back to vault ratio instead of returning a stale long-window TWAP).
- [x] `spot_oracle` → CPMM pool **TWAP** (`observation_state`) for claims, floor decay, dip trigger, buyback band. `read_cpmm_price_floor` uses TWAP when the ring is fresh+dense, else the instantaneous pool vault ratio; mock raw-u64 PDA remains the fallback only when `cpmm_pool_state` is unpinned (localnet tests).
- [x] `sol_oracle` → Raydium SOL/USDC pool (same reader, base=wSOL). Used by `offer_claim_sol` (mock `sol_oracle` remains the unpinned fallback). `bounty_top_up` and the crank's USD bounty read the SOL/USDC pool directly (`read_cpmm_price_floor` / vault ratio) and require the pool pinned — no mock fallback. MAINNET: a deep canonical pool is still required (claim reverts when the pool can't deliver ≥98% of the oracle-priced cost).
- [x] `priceChange24h` (momentum) → the close→close sample in `update_tradeday_stats` now reads the pool TWAP (via the same `read_cpmm_price_floor`), so momentum is self-sampled from the pool price, not Jupiter. **Revisit `calculate_momentum_score` weighting once the pool is live** (see §9).
- [x] Staleness/validity checks — fail-closed on missing/zero price; TWAP freshness gate (`TWAP_MAX_AGE_SECONDS`) + window-density guard; pinned-pool PDA verification (H1 re-pin).

## 4. Real DEX integration — Raydium CPMM, USDC leg live (Path A raw CPI)

- [x] **Rewrite `execute_swap` via raw `invoke_signed`** (not a typed Anchor CPI — the modern `raydium-cpmm-cpi` crate pins anchor 1.0, incompatible with our 0.31). The `raydium.rs` module builds the exact `swap_base_input` instruction (discriminator + 13 accounts) + PDAs. USDC leg routed when `cpmm_pool_state` is pinned; mock is the fallback.
- [x] **Pin the CPMM in state** — `AmmState.cpmm_program` / `cpmm_pool_state` / `cpmm_amm_config`, set via `set_cpmm_pool` (3 args, authority||keeper) + `scripts/set-cpmm-pool.ts`. Keeper derives the real vault/observation/authority PDAs.
- [x] **H1 re-pin for CPMM** — the CPMM accounts were `UncheckedAccount` (validated only by the CPI); now gated-verified against the derived vault/observation/authority PDAs whenever the pool is pinned (`pinned_pool_accounts_valid` / `pinned_sol_usdc_accounts_valid` / `require_pinned_pricing_accounts`), so a compromised keeper can't redirect the pricing reads or swap in/out vaults. No-op in mock/localnet mode.
- [x] **All-USDC claim conversion + SOL-leg retirement.** `offer_claim_sol` wraps the buyer's SOL → `swap_base_input` on the SOL/USDC pool → splits USDC 80/10/10 into `usdc_vault`/`usdc_dip`/`usdc_rewards`. Buyer covers the CPMM 0.25% input fee (+25bps on the lamports); min-out = 98% of cost (2% tolerance for pool drift/slippage — never binds on a deep mainnet pool). `wsol_vault` ATA is created idempotently on each claim (and in `bounty_top_up`) because the top-up closes it after unwrapping. The SOL swap legs in `dex_buyback`/`buy_the_dip`/`distribute_staker_rewards` are removed (USDC-only); `execute_swap` simplified; `set_sol_usdc_pool` + `cpmm_sol_usdc_pool`/`cpmm_sol_usdc_config` added.
- [ ] Remove the now-dead `sol_vault`/`sol_dip`/`sol_rewards`/`sol_oracle` state fields + accounts (left in place this pass to limit churn).
- [x] **SOL/USDC pool provisioning.** `scripts/set-sol-usdc-pool.ts` pins the pool: env vars (`DEVNET_SOL_USDC_POOL`/`DEVNET_SOL_USDC_CONFIG`) → deployment.json → devnet fallback that creates its own SOL/USDC CPMM pool seeded at 200 USDC/SOL (parity with the mock `sol_oracle`), writing `raydiumSolUsdcPool`/`raydiumSolUsdcConfig`. MAINNET: set the env vars to the canonical Raydium SOL/USDC pool — see §7.
- [ ] Devnet runtime-verify the SOL claim end-to-end (pool created + pinned now; claim swap + wSOL wrap still need a live run).
- [x] **`minimum_amount_out`** from the spot oracle (front-line M3 band) inside the CPI — done for the USDC leg.
- [x] **USDC-denominated exec price for the ratchet** — post-swap `(usdc_raw × 1e6)/afho_raw` reload + `ratchet_within_band` (unchanged).

## 5. Liquidity pool (Raydium CPMM — Token-2022 compatible)

- [x] **Programmatic pool init.** `scripts/mint-launch.ts` creates the devnet CPMM pool via `raydium.cpmm.createPool` and writes `raydiumPool`/`raydiumAmmConfig`/`raydiumProgram` to `deployment.json` (mainnet USDC swap line commented). Replaces the old "manual UI" plan.
- [ ] **Launch split 25% LP / 75% protocol.** Seed via the create-pool call at launch; both sides (AFHO + USDC) from a dedicated LP-funder account, not `afho_vault`. **Where the numbers live:** `scripts/mint-launch.ts` — `amountToMint` (supply) and `seedAfho`/`seedUsdc` (pool seed), marked with `!! MAINNET LAUNCH SPLIT` comments. Swap the devnet test amounts for the real 25/75 split there.
- [ ] **1% of bond sales → LP until target.** 4th split leg in `offer_claim` routing 1% of proceeds to an LP-funding vault + a permissionless `lp_fund` instruction that CPI-`addLiquidity` until pool liquidity ≥ target. **Target: $100,000** (sanity: at 0.25% fee this is enough to make swap depth / TWAP meaningful; revisit after launch volume).
- [ ] **LP custody.** Burn vs lock LP tokens (Raydium `cpmm.lockLiquidity` supports locking). Protocol-owned PDA affects "target size" measurement + withdrawal risk.

## 6. Bounty / keeper / treasury

- [x] Rotate keeper off authority via `set_keeper` (H1 urgency reduced post-pin, still do it).
- [x] Bounty vault rent floor + setters (L5).
- [x] Bounty pays only on state transitions (rate ~2/day).
- [x] **Bounty auto-top-up implemented (`bounty_top_up`, permissionless).** When `bounty_vault` SOL < 0.2 SOL: sell AFHO from the treasury `afho_vault` → USDC (AFHO/USDC pool) → wSOL (SOL/USDC pool) → unwrap into `bounty_vault`, adding **0.4 SOL per top-up** (BY, not TO). Two pool hops, one atomic instruction (the intermediate USDC passes through `usdc_vault` net-zero within the same instruction). Keeper attempts it every loop.
- [ ] Devnet runtime-verify `bounty_top_up` (drain `bounty_vault` below 0.2 SOL, crank it, confirm it adds 0.4 SOL funded from AFHO).
- [x] **USD-priced bounty + inflation.** `BountyConfig` now stores `bounty_usd_raw` (USDC raw, 6 dp) + `base_year` + `annual_inflation_bps`; `permissionless_crank` pays `lamports = usd_raw × 1e6 / sol_price` where `usd_raw` is the base amount compounded by the configured bps per calendar year since `base_year`. Defaults in `init-bounty.ts`: $0.50, base year 2026, +5%/yr. The SOL price is the pinned SOL/USDC pool vault ratio; falls back to the legacy fixed-lamport `bounty_amount` when the pool isn't configured (the oracle never dies).
- [ ] Devnet runtime-verify the USD bounty (force a transition, confirm ~$0.50 worth of SOL lands).


## 7. Ops / launch sequence

- [x] Staking issues fixed and verified in code: `amm_stake.rs` gate is the AMM-state PDA (not a program-ID is_signer), `Stake`/`CreateAmmPosition` use `8 + StakePosition::INIT_SPACE`; staking tests moved to `tests/staking.test.ts` with a working `crank_oracle` import. (Full test suite re-run pending — see below.)
- [ ] `current_stake_ratio` uses `total_supply` vs circulating (`helpers_make_offers.rs:31-33`) — resolve or accept.
- [x] Fresh `anchor build` + full test suite green (**34/34** local suites) — re-run after the 2026-08-31 re-audit fixes (S1–S4 + authority-only pool pinning).
- [x] **Devnet end-to-end rig** — `anchor run mint` (fresh mint + AFHO/USDC CPMM pool) → `anchor run amm-init` (now also initializes the **staking pool**) → `anchor run set-cpmm-pool` (pins program+pool+config) → `anchor run set-sol-usdc-pool` (pins/creates the SOL/USDC pool) → `anchor run bount` (keeper derives CPMM accounts). USDC legs live; SOL claim leg live on devnet pending a runtime claim test. (`scripts/pool-init.ts` still exists as a standalone staking backfill.)
- [ ] `amm-init` with real mint/pool/oracle addresses; verify `deployment.json` consumed by app.
- [ ] External audit pass on the final diff (§1 fixes + §4 adapter + §5 LP).
- [x] Doc cleanup: staking header (claim penalties removed), stale comment in `dex_buyback.rs` (SOL legs), `docs/DEX-INTEGRATION.md` (raw `invoke_signed`, no typed CPI) — done in the 2026-08-31 pass.

## 8. Token / program trust posture

- [x] Revoke **mint authority** (in `mint-launch.ts`); freeze authority already `null`.
- [x] Revoke **metadata update authority** (immutable name/symbol/URI) — `createUpdateAuthorityInstruction` (`newAuthority: null`) added to `mint-launch.ts`.
- [ ] **Program upgrade authorities** for amm/staking/crank-oracle → renounce or multisig. Not blocked — it's a deploy-side CLI step (needs the deployer keypair + a live program): `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority 11111111111111111111111111111111` (burn address = immutability) or point at a multisig. Do at launch after the final audit-pass deploy.
- [x] **Burn LP tokens (smoke test)** — `createBurnInstruction` on the LP mint added to `mint-launch.ts` (1 raw LP, devnet). MAINNET custody decision (burn-all vs `cpmm.lockLiquidity`) still §5.
- [ ] No hidden mint path: confirm `mintTo` only via revoked mint authority.

## 9. Momentum metric soundness — rework to self-sampled pool price

- [x] **Source swap + sampling cadence.** Momentum now reads the **spot oracle's close→close change** (`record_price_change` computes `(close−prev)/prev × 10000` centi-percent into the same `price_changes[20]` ring), instead of Jupiter's `priceChange24h`. Cadence is per-trading-day (one close per day). `MarketMetrics.daily_close` holds the baseline.
- [x] Wire the spot oracle itself to the Raydium pool TWAP (see §3) — `update_tradeday_stats` now samples the pool TWAP (vault-ratio fallback) as the daily close.
- [ ] Re-tune bump-taper coefficients against `sim/` once the source is a live pool price (single venue, not JUP's aggregate).
- [ ] **Tracked edge:** `raw == 0` reads as "no sample", so a perfectly flat market doesn't count toward `MIN_SAMPLES=5` and the desk can read cold on a flat open. Design is otherwise sound and source-agnostic.

## 10. Switchboard → mainnet

- [x] **Status-only quote.** `feed-deploy.ts` now deploys just the market-status feed (JUP price feed removed); the keeper already falls back to status-only when `priceFeedId` is absent.
- [ ] Redeploy feeds to the **mainnet default queue** (`A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w`) — `feed-deploy.ts` uses `getDefaultQueue(rpcEndpoint)`; confirm it resolves mainnet.
- [ ] Set mainnet feed job API keys (MASSIVE/EARNINGS) as `variableOverrides`.
- [ ] Mainnet oracle-program/quote-program IDs (see switchboard skill) vs devnet.

## 11. Frontend

- [x] Position card tint by market state (after-hours `#f7dec0`, closed/halted `#ddd6ff`).
- [x] Exit button shows per-state principal-penalty % (incl. 0% open).
- [ ] UI smoke test on devnet for claim/unstake + the new penalty label.
- [ ] `useUnstake.ts` hardcodes `principalPenaltyBpsForState` (300/600/1800) for a console.log estimate while the exit button reads the pool's configured bps — thread the pool bps through so the debug log can't drift from the real penalty.
- [ ] `/dash` still renders the vestigial `posrVault` tile (`useDashData.ts`) — remove when the posr PDA is dropped.
- [x] SOL-claim buyer flow exists in the frontend (`useOfferClaim.ts` supports the `sol` payment currency → `offerClaimSol`); devnet runtime smoke test still pending above.

## 12. Deploy cost & program size — the ~690 KB `amm` is the whole ballgame

- [ ] **Never delete `target/deploy/*-keypair.json`.** Those keypairs *are* the program addresses. `rm -rf target` regenerates 4 new IDs, so `anchor deploy` pays full rent for 4 fresh program accounts (~11.5 SOL for the current 1.66 MB total). Iterate with `anchor upgrade <program>` against the same keypairs — an upgrade pays only the *delta* rent plus a transient buffer you close.
- [ ] **Recover stranded devnet rent.** The pre-rotation program IDs (see `git diff` on the four `declare_id!`s) still hold ~11.5 SOL of rent-exempt lamports. If truly orphaned, close them (`solana program close <OLD_ID> --bypass-warning`, devnet only, requires upgrade authority).
- [x] **Cut `amm`'s switchboard type dependency.** `make_offers` now types `price_oracle` as `UncheckedAccount` (`address = amm_state.price_oracle`) and `amm` has no switchboard dependency. Next step: drop the `price_oracle` account + `AmmState.price_oracle` field entirely (still pinned-but-unread).
- [ ] **Program-size budget.** Current sizes: `amm` ~690 KB / `staking` ~414 KB / `crank_oracle` ~299 KB / `mock_dex_pool` ~228 KB (rent ≈ 6,960 lamports/byte). `amm` compiles in `staking` (CPI) and `mock-dex-pool` (CPI); §2's mock removal is the remaining cheap win; record a target size per program before mainnet.

## 13. Framework decision (Quasar) — audit done, recommendation: not pre-mainnet

- [x] **Quasar audit (2026-08-27).** Quasar (`blueshift-gg/quasar`) is a `no_std`, zero-copy, zero-allocation Solana framework (`quasar-lang` + `quasar-derive` + `quasar-spl` + `quasar-profile` + CLI). Near-hand-written CU/size, Anchor-like macros, `QuasarSvm` in-process tests. **Beta and explicitly unaudited — "APIs may change, use at your own risk."**
- [ ] **Decision recorded: do not gate mainnet on a Quasar rewrite.** `amm` + `staking` would have to move together (`amm` CPIs into `staking`; otherwise that CPI becomes raw `invoke`); `crank-oracle` is **not** convertible without reimplementing Switchboard On-Demand parsing (Anchor-only crate); `mock-dex-pool` is pointless (§2 removes it). The switchboard coupling in `amm` is only the dead `price_oracle` (§12).
- [ ] **Revisit post-launch**, gated on (a) a stable/audited Quasar release, (b) measured CU of the current Anchor hot paths (`offer_claim`, `dex_buyback`, `buy_the_dip`, `stake`/`unstake`/`claim`) via `quasar-profile` or a CU profiler, and (c) the fee-schedule SGPs actually landing. The hot-path fee argument is real; the *deploy-rent* argument is not — rent is one-time and solved by §12, not by a framework swap.
- [ ] **Fee-schedule risk (3 SGPs).** Track the in-flight governance proposals that raise fees disproportionately for high-CU (unoptimized Anchor) transactions; they make CU-budgeting the user-facing paths a launch-readiness item even if Quasar is deferred. (SGP numbers not yet pinned to sources — verify before citing in public docs.)

## 14. Open findings from the 2026-08-31 re-audit

- [ ] **Keeper transition-race (robustness).** `mev-keeper.ts` fires `make_offers`/`calc_completed_offers` only when ITS OWN crank call flips the state; if another bot wins the permissionless crank race, the day-end sheet never posts from this keeper. The on-chain idempotency guards (`offer_list.day_index`, `accepted_offers.day_index`) make firing on any observed state change safe — decouple the trigger from the keeper's own crank result.
- [ ] **Keeper timezone inference.** `mev-keeper.ts` `getSleepDuration` infers ET from the host's UTC offset (`offset==240 ? -4 : -5`) — wrong cadence on a UTC host during EDT. Use the Switchboard timestamp or an explicit `TZ=America/New_York` deployment.
- [x] **`initialize_state` writes `current_state = 99`** (crank-oracle) — RESOLVED 2026-09-02 by documentation: the sentinel is intentional (fail-closed until the first real quote); documented in AGENTS.md gotchas. Clamp-to-valid rejected — a valid initial state would open gated flows before any oracle reading.
- [x] **`max_multiplier_bps` uncapped** in `staking::initialize_pool` — FIXED 2026-09-02: `require!(max_multiplier_bps <= 30_000, StakeError::InvalidBps)` beside the other bps caps (spec header claims 1.0x–3.0x).
- [x] **`create_amm_position` accepts index gaps** — FIXED 2026-09-02: `require!(index == user_index.next_index)` at the staking boundary (`StakeError::InvalidIndex` parity with `stake`). The AMM's `validate_user_index` already enforced it pre-CPI, so no behavior change for legitimate claims.
- [ ] **Spot self-reference when TWAP is stale.** The M3 band + claim pricing fall back to the pool's instantaneous vault ratio when the TWAP ring is stale/sparse — the read and the swap share the same pool. Acceptable on a deep pool (launch §5); re-check after the pool matures.
- [ ] **Permissionless-crank bounty griefing (accepted).** Any caller can burn tx fees to consume a transition unpaid (racing the keeper) — inherent to permissionless cranking; the 2026-08-31 fix closes the same-quote replay variant. Track only if keeper reliability suffers.

### 2026-09-02 pass — e9 pricing consistency + ladder trim

- [x] **Frontend floor-unit (e9) pricing inconsistency (launch-blocking UX).** `offerMath.pricePerToken` still used the pre-e9 exponent `×10^(afho−9−usdc)` = /1e6 for the 9/6-dec pair → the offer tile's "≈ Price / lot" and the live-price readout printed 1000× HIGH, while the cart's `quoteCostRaw` already mirrored on-chain `quote_claim` (/1e12) and was correct. Rewrote to `/1e9` (floor units are price × 1e9 by construction) and dropped the meaningless decimals params through `SingleOffer`/`SizedOffers`/`OfferLists`. Audited every other conversion in `app/src`: `chainDataHelpers` pool reads (`×1e12/baseRaw`), `lamportsForCost`, `formatUsdc`, and the stake/position `/1e9` token amounts all agree with the on-chain convention; `bounty_top_up`'s leg-2 min-out was already fixed to `×1e12` in 7c9ef61.
- [x] **Offer-tier ladder trimmed.** Deleted tiers 23–25 (25M/50M/100M tokens/lot) from `lot_sizer`; mirrored in `offerMath.LOT_SIZES` + `sim/mc_sweep.py` (LOT_LADDER, t_hat range, shift/big clamps). Dead-headroom removal only: t_hat ≥ 23 needs a vault ≥ 2.5B tokens vs the 1B supply cap, so posted sheets are unchanged (749M vault → t_hat 21 → tiers 19/16/13).
- [x] **Re-checked 7c9ef61 for security** — no new holes: `bounty_top_up` min-out fix is correct (lamports = `usdc_raw × 1e12 / sol_price`), `offer_claim` guards `remaining >= units` before the `settle_sheet` subtraction (no underflow), `load_offers` tier bumps (13/16/19) match the ladder formula.


## DEX strategy note

Jupiter is a **router/aggregator**, not a pool — it can't host the protocol-owned liquidity or serve as the CPI swap target for `execute_swap`. Canonical shape: **Raydium CPMM pool** (protocol-seeded, §5) as the pool + price source; Jupiter only for mint indexing (unlocks the combined Switchboard quote) and as an optional sanity oracle — not the swap path.
