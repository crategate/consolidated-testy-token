# NYSEH (nyse-hours) — Agent Guide

SPL token protocol tied to NYSE trading hours. Market status (open / after-hours / closed / halted) drives staking incentives/penalties and an end-of-day "offer desk" that sells bonded token lots; proceeds split 80% DEX buybacks / 10% stakers / 10% dip reserve.

## Layout

- `programs/amm` — offer desk: `make_offers` (builds daily offer sheet via the sequential combinator — step 1 totals done, steps 2–5 TODO; metric helpers in `instructions/helpers_make_offers.rs`), `calc_completed_offers` (scores fill % at day end), `load_test_data` (**devnet-only, remove before mainnet**), `dex_buyback` (execution TODO; `ratchet_buyback_basis` wired), `set_keeper`. State in `state/offersState.rs`: `AmmState` (incl. `highest_buyback_basis` ratchet floor, `keeper`, `price_oracle`), `MarketMetrics` (20-day `price_changes` ring + `sample_head`, `trailing_stake_health[5]`), `AcceptedOffers` (3×[u8;5] fill %), `OfferList` + `lot_sizer` (tiers 0–21).
- `programs/crank-oracle` — market-status PDA (`b"market_status"`). Status byte at offset 8, day index u64 at bytes 17..25. Mapping: 0=open, 1=after-hours, 2=closed, 3=halted.
- `programs/staking` — staking pool, bounty.
- `scripts/` — deployment/ops TS scripts; `scripts/oracle/` holds Switchboard feed deploy + keeper (`mev-keeper.ts` is the deployed crank: collects bounty, updates quote, fires `makeOffers` on transitions 0→1, 0→2, 3→2).
- `sim/` — pure-stdlib Python simulation; exact ports of the 3 metrics + combiner design space. `python3 sim/run.py` (`--quiet`).
- `app/` — Vite/React frontend; `/dash` dev dashboard route; reads `app/public/deployment.json`.

## Commands

- Build/check: `anchor build`; `cargo check -p amm` (fast iteration; ignore anchor macro `cfg` warnings)
- Tests: `yarn test` (all), `yarn test-staking`
- Ops (via `anchor run …`): `mint` → `init` → `feed-deploy` → `amm-init` → `amm-test-data` → `bount` (keeper). PDAs from earlier steps are inputs to later ones — order matters.
- Lint: `yarn lint`

## Conventions & invariants

- **Devnet only.** `overflow-checks = true` in release — all metric math must widen before multiply (see u32 cast in `offer_accepted_aggression`).
- Units: price changes are centi-percent i16 (1% = 100); metric scores are 0–10000 (stake health 0–100); `discount_bps` u8 is tenths of a percent (115 = 11.5%).
- Caller gates: `make_offers` / `calc_completed_offers` accept `authority || keeper`; funds move on `authority` only. Keeper defaults to authority at init, rotate via `set_keeper`.
- Offer desk rules: never offer below `highest_buyback_basis` (ratchet floor); never offer more than 5% of vault per sheet; no offer sheet until ≥5 price samples (cold start = dark desk).
- Offer constraints: sml lot tier < med < big (≥1 tier apart); discount strictly big > med > sml.
- Switchboard: Secrets feature is **deprecated** — use variableOverrides. Canonical quote covers `[market_status, price]` feeds; `make_offers` reads `feeds[1]` as priceChange24h, skips write if <2 feeds or >300 slots stale.

## Gotchas

- Devnet: Jupiter won't index devnet mints, so the combined [status, price] quote never resolves — for pipeline tests set `NYSEH_MINT` in `.env` to a liquid mainnet mint before `feed-deploy`.
- `feed-deploy.ts` writes `marketStatusFeedId` / `priceFeedId` / `oracleQuoteAccount` to `app/public/deployment.json`; `amm-init.ts` consumes it.
- Known staking issues (not yet fixed): `amm_stake.rs` `is_signer` check on program ID blocks offer_claim CPI; `Stake` position space uses wrong INIT_SPACE; `dex_buyback.rs` has a duplicate `record_acceptance` to remove.
- `programs/staking/tests/test_staking.ts` has a pre-existing broken import (`../target/types/crank_oracle`).
- Root `tsc` shows pre-existing errors from `app/` — check script files individually instead.
