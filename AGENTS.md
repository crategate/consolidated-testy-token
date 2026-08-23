# AFHO (nyse-hours) — Agent Guide

SPL token protocol tied to NYSE trading hours. Market status (open / after-hours / closed / halted) drives staking incentives/penalties and an end-of-day "offer desk" that sells bonded token lots; proceeds split 80% DEX buybacks / 10% stakers / 10% dip reserve.

## Layout

- `programs/amm` — offer desk: `make_offers` (builds the daily offer sheet via the full 5-step sequential combinator; metric helpers in `instructions/helpers_make_offers.rs`), `calc_completed_offers` (scores fill % at day end), `load_test_data` (**devnet-only, remove before mainnet**), `dex_buyback` (working: slices the day's vault USDC/SOL into the configured DEX pool while market==open; pseudo-random slice sizes weighted 1.9%/5% of remaining first-hour/tail → ~50% of the day's volume lands in hour 1; pacing 150 slots; unspent budget rolls over by staying in the vaults; every fill ratchets `highest_buyback_basis`. Swap CPI is isolated in `execute_swap` — the ONLY function to replace for the real DEX), `buy_the_dip` (always-on dip buyer, ANY market state: spends the 10% dip reserves when spot falls ≥3% below the mean of the self-sampled 32-slot spot ring (sampled every 75 slots by calling the instruction; cold start <5 samples = dark). Slice = 25% of reserve × (depth/10%)² × trend mult (recent-5 minus older-15 mean of `price_changes`, ×10 gain, clamped 0.25x–1.25x); day cap 40% of day-start snapshot per leg; pacing 150 slots; both legs via `execute_swap`; fills ratchet `highest_buyback_basis`), `set_keeper`. State in `state/offersState.rs`: `AmmState` (incl. `highest_buyback_basis` ratchet floor, `keeper`, `price_oracle`, `spot_oracle`, `dex_program`, `bb_*`/`dip_*` day-budget fields), `MarketMetrics` (20-day `price_changes` ring + `sample_head`, 32-slot `spot_prices` ring + `spot_head`/`spot_last_slot`, `trailing_stake_health[5]`), `AcceptedOffers` (3×[u8;5] fill %), `OfferList` + `lot_sizer` (tiers 0–21). Vault topology: `afho_vault`/`usdc_vault` are ATAs of amm_state; `usdc_dip`/`usdc_rewards` are PDA token accounts (`b"amm_usdc_dip"`/`b"amm_usdc_rewards"`, amm_state signs — NOT ATAs, they'd collide with `usdc_vault`); `sol_vault`/`sol_dip`/`sol_rewards` are space-0 system PDAs (rent-funded at init; outbound transfers need `minimum_balance(0)` floors).
- `programs/mock-dex-pool` — **stub "DEX"** (fixed-rate AFHO dispenser; devnet/localnet only, remove before mainnet): `init_pool` (pool PDA `b"mock_pool"`+mint, token vaults are ATAs of the pool PDA), `send_afho` (out-leg CPI target for `dex_buyback`; in-leg transfer is done by the caller), `set_price` (permissionless raw-u64 `b"mock_price"` PDA — the devnet live-price stub read by `offer_claim`/`calc_completed_offers`).
- `programs/crank-oracle` — market-status PDA (`b"market_status"`). Status byte at offset 8, day index u64 at bytes 17..25. Mapping: 0=open, 1=after-hours, 2=closed, 3=halted.
- `programs/staking` — staking pool, bounty.
- `scripts/` — deployment/ops TS scripts; `scripts/oracle/` holds Switchboard feed deploy + keeper (`mev-keeper.ts` is the deployed crank: collects bounty, updates quote, fires `makeOffers` on transitions 0→1, 0→2, 3→2, fires `calcCompletedOffers` on →0, attempts `dexBuyback` slices every loop while market==open, and attempts `buyTheDip` every loop regardless of market state — those calls also keep the spot-price ring sampled).
- `sim/` — pure-stdlib Python simulation; exact ports of the 3 metrics + combiner design space (`python3 sim/run.py --quiet`), plus `sim/dip.py` + `sim/run_dip.py` (buy-the-dip trigger/sizing model that motivated the quadratic-depth + trend-slope spec).
- `app/` — Vite/React frontend; `/dash` dev dashboard route; reads `app/public/deployment.json`.

## Commands

- Build/check: `anchor build`; `cargo check -p amm` (fast iteration; ignore anchor macro `cfg` warnings)
- Tests: `yarn test` (all), `yarn test-staking`; `tests/buy-the-dip.test.ts` + `tests/dex-buyback.test.ts` + `tests/offer-claim.test.ts` + `tests/ratchet-decay.test.ts` run against a local validator (`solana-test-validator --bpf-program …` for all 4 programs) — cover dip-buy cold-start/trigger/depth/throttle/pacing/SOL-leg/auth, buyback gating/weighting/pacing/rollover/ratchet, claim splits/vesting/gating, and floor-decay grace/convergence/reset/guards. `load_test_data` knobs: metrics rings (incl. `spot_prices`/`spot_head`), fill %, `buyback_basis`, `untaken_days`, offer-sheet totals.
- Ops (via `anchor run …`): `mint` → `init` → `feed-deploy` → `amm-init` → `amm-test-data` → `bount` (keeper). PDAs from earlier steps are inputs to later ones — order matters.
- Lint: `yarn lint`

## Conventions & invariants

- **Devnet only.** `overflow-checks = true` in release — all metric math must widen before multiply (see u32 cast in `offer_accepted_aggression`).
- Units: price changes are centi-percent i16 (1% = 100); metric scores are 0–10000 (stake health 0–100); `discount_bps` u8 is tenths of a percent (115 = 11.5%).
- Caller gates: `make_offers` / `calc_completed_offers` / `update_tradeday_stats` accept `authority || keeper`; funds move on `authority` only. Keeper defaults to authority at init, rotate via `set_keeper`.
- Metric-write separation: `make_offers` is READ-ONLY over metrics (calculate + post sheet). End-of-day metric writes (price sample, stake ratio) live in `update_tradeday_stats`, fired by the keeper BEFORE `make_offers`; start-of-day offer accounting (fill % rings) lives in `calc_completed_offers`, fired on any →0 transition. Idempotency guards: `metrics.day_index` (stats), `offer_list.day_index` (sheet), `accepted_offers.day_index` (fills).
- Offer desk rules: never offer below `highest_buyback_basis` (ratchet floor, enforced at claim time in `offer_claim`; moves up via `dex_buyback::ratchet_buyback_basis`, decays DOWN via `calc_completed_offers`: after 15 straight fill-less trading days, floor -= 2% of (floor − live price) per day, never crossing below live; `untaken_days` counter on AmmState; live price from the raw-u64 `price_oracle` stub — **mainnet needs a real absolute-price source in floor units**); never offer more than 5% of vault per sheet; no offer sheet until ≥5 price samples (cold start = dark desk).
- Combinator (make_offers, sequential): 1 totals ← momentum bump-taper · 2 lot tiers ← vault abundance + excitement · 3 counts derived (50/35/15 split ÷ lot sizes) · 4 discount ← momentum bump, aggression-tightened, strictly big>med>sml · 5 vesting ← stake health, compensated for clamped discounts. Sim/tuning: `sim/` (v3 = deployed spec).
- Offer constraints: sml lot tier < med < big (≥1 tier apart); discount strictly big > med > sml.
- Switchboard: Secrets feature is **deprecated** — use variableOverrides. Canonical quote covers `[market_status, price]` feeds; the priceChange24h write lives in `update_tradeday_stats` (reads `feeds[1]`, skips if <2 feeds or >300 slots stale).

## Gotchas

- Devnet: Jupiter won't index devnet mints, so the combined [status, price] quote never resolves — for pipeline tests set `AFHO_MINT` in `.env` to a liquid mainnet mint before `feed-deploy`.
- `feed-deploy.ts` writes `marketStatusFeedId` / `priceFeedId` / `oracleQuoteAccount` to `app/public/deployment.json`; `amm-init.ts` consumes it.
- Known staking issues (not yet fixed): `amm_stake.rs` `is_signer` check on program ID blocks offer_claim CPI; `Stake` position space uses wrong INIT_SPACE.
- `dex_buyback`/`buy_the_dip` ratchet units: exec price = (input raw × 1e6) / AFHO raw — the SOL leg is converted via `sol_oracle` before ratcheting (lamports × sol_price / out), so both legs ratchet in the same USDC-denominated units. The real-DEX adapter must report a USDC-denominated exec price. Fine for the stub era.
- Stack budget: `initialize_amm` blew the SBF stack until the big accounts were boxed and `opt-level = "s"` was added to `[profile.release]` — keep both; and always `anchor build` before running tests (stale .so masks fixes).
- `yarn lint` (prettier --check) fails repo-wide including at HEAD — informational only, don't reformat whole files to satisfy it.
- Before mainnet: remove `mock-dex-pool`, `load_test_data`, crank `test_set_state`; point `amm_state.dex_program` at the real pool program at init and rewrite `execute_swap`; rotate keeper via `set_keeper`.
- `programs/staking/tests/test_staking.ts` has a pre-existing broken import (`../target/types/crank_oracle`).
- Root `tsc` shows pre-existing errors from `app/` — check script files individually instead.
