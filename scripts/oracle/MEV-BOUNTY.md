# AFHO Market-Status Crank Bounty — Bot Guide

The crank-oracle program pays SOL to **anyone** who cranks the NYSE market-status
PDA with a fresh Switchboard quote. This doc is everything a third-party MEV bot
needs to collect it.

## Program & PDAs

- Program: `ENJn9r8uCBLZXJ4unADAJfgNScWZuEm3rHD2LoBDpAki` (crank_oracle)
- `market_status` PDA: `findProgramAddress(["market_status"], program)`
- `bounty_config` PDA: `findProgramAddress(["bounty_config"], program)` — holds
  `authority`, `bounty_amount`, `last_crank_slot`
- `bounty_vault` PDA: `findProgramAddress(["bounty_vault"], program)` — SOL
  lamports paid out to crankers
- Switchboard quote account: see `app/public/deployment.json` →
  `oracleQuoteAccount` (covers `[market_status, price_change_24h]` feeds)

## The race

`permissionless_crank` pays the bounty when ALL of these hold:

1. **Fresh quote**: `current_slot - quote_account.slot <= max_age`, where
   `max_age = 100` slots while the market is open/after-hours (states 0/1) and
   `300` otherwise (~40 s / ~2 min).
2. **Monotonic**: `quote_account.slot > bounty_config.last_crank_slot` — each
   distinct quote slot pays **exactly once**, first-come-first-served. The
   winner's crank writes `last_crank_slot = quote_slot`, so losing bots must
   wait for the next quote.
3. **Valid state**: feed 0 converts to a u8 in 0–3 (open / after-hours /
   closed / halted).
4. **Funded vault**: the vault keeps a rent floor and errors `BountyExhausted`
   when empty — it can never be drained to zero.

Note: the bounty pays **only when the market state actually changes**
(open ↔ after-hours ↔ closed ↔ halted). A no-op crank that re-posts the same
state is still accepted (it keeps `market_status` fresh and advances the
anti-replay slot guard) but pays nothing. This is what keeps the burn rate
proportional to real NYSE events (~2 transitions/day plus halts) rather than
to Solana slot cadence.

## Crank transaction

Accounts: `cranker` (any signer — you), `bounty_config`, `bounty_vault`,
`quote_account`, `clock`, `market_status`, `system_program`.

```ts
const crankIx = await crankProgram.methods
    .permissionlessCrank()
    .accountsStrict({
        cranker: botKeypair.publicKey,
        bountyConfig: bountyConfigPda,
        bountyVault: bountyVaultPda,
        quoteAccount,
        clock: SYSVAR_CLOCK_PUBKEY,
        marketStatus: marketStatusPda,
        systemProgram: SystemProgram.programId,
    })
    .instruction();
```

A crank only succeeds if a fresh Switchboard quote exists for the slot you're
cranking. Pushing a fresh quote is itself permissionless — `mev-keeper.ts`
does `queue.fetchManagedUpdateIxs(crossbar, feedIds, { payer })` then appends
the crank instruction to the same transaction, so a new quote + the crank land
atomically (quote fee and your tx fee are on you; the bounty is the profit).

The market-status feed needs no API keys. The combined quote's price feed
(`priceChange24h`) reads third-party price APIs and only resolves with the
`variableOverrides` keys (`MASSIVE_API_KEY`, `EARNINGS_API_KEY`, `JUP_API_KEY`)
used by the protocol's own keeper. A status-only bot can skip the price feed
entirely and crank with just the status feed. Feed IDs and the quote account
are in `deployment.json`.

Reference implementation: `scripts/oracle/mev-keeper.ts` (the protocol's own
keeper competes in the same race).

## Economics

- Default bounty: `5_000_000` lamports = **0.005 SOL per transition** (set at
  `initialize_bounty`; adjustable on-chain via `set_bounty_amount`, authority
  only).
- Burn rate is proportional to state changes, not quote cadence: a normal
  trading day is ~2 transitions (open → after-hours, then → open) plus halts,
  so ~0.01–0.02 SOL/day at the default bounty. Heartbeat cranks cost nothing.
  The vault is topped up by the authority via `fund_bounty`.
- Your costs: transaction fee + priority fee + the Switchboard quote-update
  fee. Bid accordingly — the winner is whoever lands the newest quote slot
  first; `last_crank_slot` makes losers' txs fail cleanly with `StaleQuote`.

## What the bounty does NOT pay

Only `permissionless_crank` pays. The protocol's other instructions
(`make_offers`, `calc_completed_offers`, `update_tradeday_stats`,
`dex_buyback`, `buy_the_dip`, `distribute_staker_rewards`) pay nothing and are
gated to the protocol authority/keeper — those are run by the protocol's own
bot, which pays its own tx fees from its own keypair. No protocol vault pays
transaction fees.
