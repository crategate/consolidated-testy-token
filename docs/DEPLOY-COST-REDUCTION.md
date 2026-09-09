# Deploy-Cost Reduction Proposal — AFHO Contract Suite

Status: proposal (2026-09-09). All sizes measured from `target/deploy/*.so` built 2026-09-08;
all rent figures use the verified formula below. Estimated savings are flagged as estimates and
must be re-measured (Phase 0).

## 1. Where the 7 SOL goes (measured, verified)

Rent-exempt formula (verified against `solana-cli 3.1.8` probes, 12 data points, exact match):

```
rent-exempt = (data_len + 128) × rate   lamports
rate = 5,080 lamports/byte  — devnet / post-v4.2-reduction rate
rate = 6,334 lamports/byte  — mainnet current rate (per MAINNET_CHECKLIST §12, measured 2026-09-08)
```

The `+128` account-header term creates an effective floor of ~0.00065 SOL per account — small
accounts are disproportionately expensive.

Per-program programdata rent (the ~7 SOL the user quoted):

```
program             .so size    @5,080 (target)   @6,334 (mainnet today)
amm                 656,704 B   3.3367 SOL         4.1604 SOL
staking             414,944 B   2.1086 SOL         2.6291 SOL
crank_oracle        305,512 B   1.5527 SOL         1.9359 SOL
────────────────────────────────────────────────────────────
TOTAL                           6.9980 SOL         8.7253 SOL
```

Optional on-chain IDLs (only if `anchor idl init` is run on mainnet — scripts read `target/idl/*.json`
locally, so this is skippable): amm 0.3658 / crank 0.0945 / staking 0.1039 → **+0.5642 SOL**.

Marginal cost: **1 KB of ELF ≈ 0.0052 SOL (target rate) / 0.0065 SOL (current mainnet)**.

Section breakdown (llvm-size): `.text` is 82–87% of every binary (amm 574 KB / staking 359 KB /
crank 249 KB), `.rel.dyn` 27–47 KB, `.rodata` 16–21 KB, already symbol-stripped. The bloat is
compiled dependency code, not debug data — so it is only removable by *compiling less code*.

## 2. Compression: what it can and cannot do (skill-based)

**It cannot reduce the 7 SOL.** That bill is programdata rent, a pure function of ELF bytes.
There is no compressed-binary deployment; Light/ZK compression targets *state* accounts
(compressed PDAs ~5,000 lamports creation vs ~1.3M+ for a 128-byte account; compressed token
accounts ~11,000 lamports vs ~1.49M for an SPL ATA). Program deployment is untouched.

**What compression CAN do here** — per-user state, not singletons:

- **Staking positions.** Per staker today: `StakePosition` (~146 B, 0.0014 SOL) +
  `UserStakeIndex` (16 B, 0.0007 SOL) + user ATA (165 B, 0.0015 SOL) ≈ **0.0036 SOL/staker**.
  At scale: 1,000 → 3.6 SOL, 5,000 → 18.1 SOL, 50,000 → 180.6 SOL of user-side rent (refundable
  on close). The Light-PDA path (`light-sdk`, `#[light_account(init)]` — minimal Anchor diffs)
  cuts the position+index pair to ~5,000 lamports (~146×) and the compressed-token path cuts the
  ATA to ~11,000 lamports (~135×): 50,000 stakers ≈ 0.80 SOL total. Positions are written only on
  stake/claim/unstake (mostly *cold*), which is exactly the access pattern compression fits.
- **Bond claims / vesting records.** The reference `merkle-distributor` (compressed PDA claim
  tracking, linear vesting, partial claims, clawback) maps 1:1 onto the desk's bond/vesting model
  if per-buyer records ever replace the singleton sheet. Optional post-launch track.
- **Token balances.** Compressed AFHO balances (Phantom/Backpack-native) could defer per-user ATA
  rent; a decompress step is then required before staking or DEX trading. Only worth it if the
  protocol sponsors user rent (`payments` skill: sponsored rent-exemption) or at large scale.

**What compression should NOT touch here:**

- **Protocol singletons** (AmmState, MarketMetrics, OfferList, AcceptedOffers, vaults, market_status,
  bounty_config): total ≈ 0.02 SOL of rent, written by the keeper every minute/day. Compressing
  them adds validity-proof verification + CU + latency on the keeper's hot path for nothing, and
  changes the fail-closed semantics the whole desk depends on. Skip.
- **The AFHO mint and all vaults**: must stay SPL/Token-2022 — Raydium CPMM pools require them.
  The Light Token Program mint is not Raydium-composable. LP positions can't be compressed either.

**Operational cost of adopting compression**: Helius ZK-enabled RPC (both RPC endpoints), client
SDK changes (`@lightprotocol/stateless.js`), ~4 compressed accounts/tx limit, +15k–400k CU and
+100–2,400 tx bytes per cold-account load. The SOL claim tx already runs ~153–163k CU of a 400k
budget — cold loads must be measured before committing. Frontend/indexers: compressed state is
invisible to `getProgramAccounts`; needs Light RPC methods / Laserstream (`data-streaming` skill).

## 3. Lever matrix (ordered by ROI)

| # | Lever | Savings (est, @5,080) | Effort / Risk |
|---|-------|----------------------|---------------|
| A | ✅ LANDED (2026-09-09): skip on-chain IDLs on mainnet (serve `target/idl/*.json`) — no pipeline step uploads IDLs today; policy now recorded in MAINNET_CHECKLIST §12 | **−0.56 SOL** | None. Zero risk. |
| B | Pre-mainnet removals already planned (§2 checklist): `load_test_data`, `load_offers`, `migrate_offer_list`, crank `test_set_state`/`test_collect_bounty`, dead AmmState fields — **deferred per user request (2026-09-09)** | −0.16 to −0.42 SOL | Planned anyway. Only the *size* is new info. |
| C | ✅ LANDED (2026-09-09): `panic = "abort"` + per-crate `opt-level = "z"` (crank/staking) + crank `anchor-spl` dep removed. **Measured: −25.8 KB ≈ −0.13 SOL** (amm −3,296 / staking −16,576 / crank −6,544 B) — fat-LTO runs the link pass at profile `"s"`, so per-crate `"z"` only reshapes pre-LTO codegen and LTO had already dead-stripped the unused dep. Verified: full staking suite 8/8 on local validator, app `yarn build` clean. | **−0.13 SOL (measured)** | Landed. |
| D | ✅ LANDED (2026-09-09): crank-oracle native rewrite (`solana-program` + vendored SBOD `ParsedEd25519Instruction`, no anchor-lang in the binary). **Measured: 298,968 → 155,832 B (−47.9%) ≈ −0.73 SOL.** Same program ID, PDA seeds/bumps, account layouts, instruction discriminators, arg encoding, and error codes (6000–6008) — proven by: 10/10 native litesvm tests (incl. permissionless_crank with a fabricated SBOD quote, USD-priced bounty via pinned pool vaults, day rollover, staleness/monotonic gates), 8/8 staking tests via the anchor IDL client, and the real `init-bounty`/`fund-bounty`/`set-bounty-usd` scripts against a local validator with IDL decode verified. The original anchor source lives on as `src/idl_spec.rs`, compiled ONLY under the `idl-build` feature so `anchor build` regenerates the IDL **byte-identically** (sha-verified) — `anchor-lang` is an optional dep absent from the deployed build. A drift test (`idl_discriminators_match`) fails if the native constants ever diverge from the IDL (it already caught one transcription error). | **−0.73 SOL (measured)** | Landed. |
| E | Fold crank logic into amm (alternative to D): delete crank programdata (1.55 SOL) + its IDL (0.09); amm gains SBOD dep (+0.3–0.5 SOL) | **−1.0 to −1.2 SOL net** | Architecture change: market_status/bounty vaults become amm PDAs; keeper loop + gating rework; amm grows near the stack-sensitive range; re-audit everything. |
| F | staking native rewrite (405 KB → ~60–100 KB) | **−1.6 to −1.7 SOL** | Self-contained math (weighted stake, penalties, checkpointing); medium-large effort; re-audit. |
| G | amm native/Pinocchio rewrite (641 KB → ~250–350 KB native / ~120–180 KB Pinocchio) | −1.8 to −2.6 SOL | 6,299 lines + the whole invariant surface; high regression risk given stack/CU history. Quasar was already evaluated and deferred (checklist §13) — rent alone does not justify a framework swap. |

Rejected: replacing crank-oracle with a keeper-signed plain data account (no program) would delete
1.55 SOL outright, but it removes the permissionless Switchboard attestation, makes the bounty
mechanism meaningless (keeper paying itself), and expands the hot-wallet trust surface the audit
explicitly tightened. Not recommended.

Rolling totals (@5,080): A+C+D (landed) → **~6.14 SOL** (7.00 → 6.86 flags → 6.14 rewrite) · +B → **~5.9–6.0 SOL** · +E → **~5.1–5.3 SOL** · +F → **~3.4–4.0 SOL** ·
+G → **~1.5–2.3 SOL**. Compression adds $0 to this bill. (At mainnet's current 6,334 rate the same binaries are ~8.7 SOL → ~7.65 SOL after A+C+D.)

## 4. Sequencing notes

- **Upgrades refund rent.** Every `anchor upgrade` closes the old programdata and returns its
  lamports; the new binary pays only its own rent. Shrink work shipped *after* launch still
  recovers the delta — the 7 SOL is a one-time outlay, not a permanent cost.
- **Immutability is a deadline.** `solana program set-upgrade-authority --final` (planned in the
  mainnet checklist) freezes the binary forever. All shrink work must land and be verified BEFORE
  finalization, or the 7 SOL is locked in.
- **Never delete `target/deploy/*-keypair.json`** (already in checklist §12) — fresh program IDs
  would pay full rent again.
- Deploy-time buffers are 2× the binary and fully refunded on close — cash-flow only, not cost.
- Mainnet today is still at 6,334/byte (~8.7 SOL for the same binaries); the Agave v4.2 reduction
  brings it to the 5,080 used here. Plan against whichever rate applies at deploy.

## 5. Recommended phases

- **Phase 0 — measurement (≈1 day, no logic changes):** build-matrix sweep in CI: baseline vs
  `panic=abort`, per-crate `opt-level="z"` (crank/staking), `no-idl` feature, and a
  feature-gated "no devnet tools" build. Replaces every estimate above with real KB per lever.
  `tools/rent-calc.py` is the cost-model calculator for this. *(Done implicitly 2026-09-09: flags
  built and measured — see lever C.)*
- **Phase 1 — zero-risk wins (LANDED 2026-09-09):** skip on-chain IDLs (−0.56, policy recorded in
  MAINNET_CHECKLIST §12) + codegen flags (−0.13 measured). Pre-mainnet removals (B) deferred per
  user request. Remaining zero-risk item when B is un-deferred: feature-gate the devnet tools and
  measure the KB before deleting.
- **Phase 2 — crank decision:** either D (native rewrite, preserves architecture) or E (fold into
  amm, simpler ops, bigger audit surface). Decide on the bounty trust model first.
- **Phase 3 — post-launch, pre-final:** staking native rewrite (F); amm rewrite (G) only if CU
  profiling or other needs justify it — rent alone does not.
- **Compression track (independent, scale-gated):** adopt Light-PDA staking positions once adoption
  makes ~0.0036 SOL/staker matter; bond-claim compression via the merkle-distributor pattern only
  if per-buyer records are introduced. Never for singletons.

## 6. Open decisions for the user

1. Plan against 5,080 (post-reduction) or 6,334 (mainnet today)?
2. Crank-oracle: native rewrite (D) vs fold into amm (E) vs leave as-is?
3. Does any mainnet tooling depend on on-chain IDLs, or can they be skipped (−0.56 SOL)?
4. What per-program size budget do we record in the checklist §12 (it asks for one)?
5. Is the keeper/switchboard permissionless attestation a hard security requirement, or would a
   keeper-signed state write ever be acceptable (rejected above, but it is the single biggest
   cost cut at 1.55 SOL)?
