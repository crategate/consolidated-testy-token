# AFHO — defi on Market Hours

> Litepaper v0.1 · devnet stage
> A plain-language description of how AFHO works, what it costs, and what it
> is built on. not investment advice.

---

## Narrative through mechanics

AFHO is an SPL token with features driven by the NYSE market status: while the market is
open, the protocol buys its own token back from the market. When the bell
closes, a nightly "offer desk" sells discounted, vesting bond lots straight
into staking positions.

### a ticker that knows its being watched
The bonds' size, discount rate, and vesting period are determined by the
performance of the token's staking and price.

## The market clock

The whole protocol runs off one on-chain state machine, updated by a
permissionless keeper reading a Switchboard On-Demand feed:

| State | Meaning | What happens |
|---|---|---|
| OPEN | NYSE trading hours | Buybacks run. Stakers can claim. |
| AFTER-HOURS | 4:00–8:00 pm ET | Night desk opens. Unstaking costs a fee. |
| CLOSED | Overnight / weekends | Night desk stays open. Larger unstake fee. |
| HALTED | NYSE trading halt | Everything pauses. Largest unstake fee. |

Anyone can crank the state machine, but the keeper that flips the state earns
a small bounty (~$0.50, +5%/yr), funded automatically from the treasury.

## A day in the life

- **At the bell (OPEN):** buybacks resume — but only if last night's desk
  actually sold bonds. No sales, no buyback: the protocol never spends to
  prop up a token nobody bought.
- **During the day:** the **dip reserve** watches the pool price around the
  clock. A real dip (3%+ below its own recent average) triggers automatic
  buying, dampening the drop.
- **After the close (AFTER-HOURS / CLOSED):** the **night desk** posts a
  fresh sheet of bond lots — AFHO at a discount, delivered directly into
  vesting staked positions. Proceeds split 80/10/10.
- **Back at the next open:** 80% of last night's proceeds buy back AFHO from
  the open market; 10% goes to stakers; 10% refills the dip reserve.

## The night desk — discounted bond sales

Every evening the desk prices three tiers of lots — **small, medium, big** —
from the day's price momentum and how committed stakers are:

- **Discounts are strictly tiered** (big gets the deepest cut, small the
  shallowest) and never price below the **buyback floor** — the highest price
  the protocol itself has ever paid. If the market falls to the floor, the
  desk goes dark on its own rather than undercut its own buyers.
- **Bonds vest**: purchased AFHO lands straight in a staked position locked
  for **3 to 25 trading days**, so every bond buyer is also a staker from
  second one.
- **Guardrails**: at most 5% of the vault is offered per sheet, and the desk
  stays dark until it has at least 5 days of price history. No history, no
  guessing, no sheet.

## Buybacks — 80% of every bond sale

Buybacks only run while the market is OPEN and only after real bond sales.
The 80% share is sliced out over the session rather than dumped at once:

- **Paced**: one slice every 150 slots, sized pseudo-randomly.
- **Front-loaded**: roughly half the day's budget lands in the first hour,
  when a post-close discount is cheapest to correct.
- **Banded**: every fill must land within **5%** of the pool's TWAP price or
  the transaction reverts.
- **Rolls over**: unspent budget stays in the vault for the next session.
- **Ratchets**: every executed buyback raises the desk's pricing floor, so
  the desk can never sell cheaper than the protocol itself paid.

## The dip reserve — 10%

Ten percent of bond proceeds fund an always-on dip buyer:

- Triggers when the pool price falls **3% or more** below the mean of its own
  last 32 samples (sampled every 75 slots).
- Sizes its buys **quadratically** with depth — a 10% dip buys far more than
  twice what a 5% dip buys — and throttles when the 20-day trend is falling.
- Capped at **40% of the reserve per day**, so a knife never empties the
  reserve in one afternoon.

## Stakers — 10% + the rewards engine

Ten percent of every bond sale is converted to AFHO and distributed to
stakers. Rewards are split by **weight**, and weight grows with commitment:

- **Trading-day multiplier**: weight ramps from 1.0x toward a configured cap
  (default **3.0x**) along a saturating curve — early days grow fast, later
  days slow down.
- **Claims are market-open only** (the desk's reward pool only pays out while
  the market is live), with a **5% protocol tax** that refills bond-sale
  inventory.
- **Vested bond positions** participate with full weight immediately and
  unlock after their vesting period.

## Fees, penalties & costs at a glance

- **Pool fee**: Raydium CPMM's 0.25% per swap — paid by bond buyers on the
  payment leg (SOL buyers pay +25 bps to cover the conversion).
- **Claim tax**: 5% of every claim (default, set at pool init).
- **Unstake penalties** (principal, by market state — defaults):
  - OPEN: none
  - AFTER-HOURS: 3%
  - CLOSED: 6%
  - HALTED: 18%
- **Keeper bounty**: ~$0.50 per real state flip, +5%/yr, auto-funded by the
  treasury.
- All bps parameters are fixed at pool initialization and capped at 100%.

## Token & liquidity

- **Supply**: 1,000,000,000 AFHO, SPL **Token-2022**.
- **Trust posture**: mint authority revoked; token metadata immutable.
- **Liquidity**: protocol-owned Raydium CPMM pool. Pricing (TWAP) comes from
  the same pool the swaps execute against, so the desk, the dip buyer, and
  the buyback all read and trade one honest venue.
- **Launch plan**: 25% of supply seeded to the pool, 75% to the protocol
  vault, per the mainnet checklist.

## Roles

- **Authority** — sets the keeper, pins the pools, moves protocol funds.
- **Keeper** — a hot wallet running the daily crank bot: flips market state,
  posts the sheet, fires buyback/dip slices. Cannot re-pin pools or touch
  vault funds directly.
- **Bond buyers & stakers** — the protocol's whole reason to exist.

## Tech stack

- **Programs (Rust, Anchor 0.31)**: `amm` (offer desk, buybacks, dip,
  claims), `staking` (pool, multipliers, rewards), `crank-oracle` (market
  status + keeper bounty). A devnet-only mock DEX powers localnet tests and
  is removed before mainnet.
- **DEX**: Raydium CPMM via raw `swap_base_input` CPI + a hand-written TWAP
  reader.
- **Oracle**: Switchboard On-Demand for the market-status feed.
- **Frontend**: React + Vite, wallet-connected, with a dev dashboard.
- **Ops**: TypeScript scripts — deploy, pool pinning, the keeper, and X /
  Telegram announcement bots that post every protocol event with the
  receipts.

## Status

Devnet. The full launch checklist lives in `MAINNET_CHECKLIST.md` in the
repo (build-in-public progress): security fixes from two audit passes are
landed, the Raydium adapter and TWAP pricing are live on devnet, and the
remaining work is liquidity seeding, devnet-only code removal, and a final
external audit.

---

## Risks & disclaimer (summary)

AFHO is experimental software in development. The token has no intrinsic
value and no guarantee of appreciation; staking, bonding, and buybacks do not
imply profit. Parameters described here are current defaults and may change
before launch. Trading crypto involves risk of total loss, and nothing here
is an offer, solicitation, or investment advice. See the full risk disclaimer
on the website for details.
