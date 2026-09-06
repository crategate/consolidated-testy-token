// ─────────────────────────────────────────────────────────────────────
// mev-keeper-mainnet — PRODUCTION keeper (mainnet).
//
// Production-only copy of scripts/oracle/mev-keeper.ts: no --test-state,
// no test_set_state / test_collect_bounty, no devnet genesis gate, no
// TEST_* env/argv knobs. Cranks the real Switchboard managed quote and
// fires the same transition sequences (update_tradeday_stats →
// make_offers, calc_completed_offers, dex_buyback, buy_the_dip,
// bounty_top_up) and the records snapshot.
//
// MAINNET CONFIG CHECKLIST (everything this file assumes):
//   1. ANCHOR_PROVIDER_URL = mainnet RPC (helius/quicknode/etc — not the
//      public api.mainnet-beta.solana.com for a crank loop) and
//      ANCHOR_WALLET = the keeper keypair (rotate off authority via
//      set_keeper; the keeper does NOT need authority).
//   2. deployment.json points at the MAINNET deployment (program IDs,
//      mint, Switchboard queue/feed, marketStatusFeedId, oracleQuoteAccount).
//   3. AmmState pool pins: cpmm_pool_state = the AFHO/USDC pool created by
//      mint-launch, cpmm_sol_usdc_pool = the deep canonical wSOL/USDC pool
//      (creator fee OFF) — set via set-cpmm-pool / set-sol-usdc-pool with
//      DEVNET_SOL_USDC_POOL/_CONFIG pointing at it. Bounty pricing and
//      SOL claims read these pins from bounty_config/amm_state, so nothing
//      is hardcoded here.
//   4. Env: MASSIVE_API_KEY + EARNINGSAPI_KEY (Switchboard variableOverrides
//      for the managed quote). BOUNTY_RECYCLE=0 to disable bounty recycling
//      (ON by default — see the note below). Optional VITE-style RPC url is
//      NOT used here; the provider URL above is the single endpoint.
//   5. Solana price sanity: the bounty is USD-denominated but converts at
//      the pinned pool's price, so keep an eye on the logged sol_price
//      until the canonical pool proves anchored.
// ─────────────────────────────────────────────────────────────────────
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";  // Anchor re-exports BN
import * as sb from "@switchboard-xyz/on-demand";
import { OracleQuote } from '@switchboard-xyz/on-demand';
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import {
    getAssociatedTokenAddressSync,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { CrankOracle } from "../../target/types/crank_oracle";

dotenv.config();

async function main() {
    const { connection, keypair, queue, crossbar } = await sb.AnchorUtils.loadEnv();
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {});

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(idlPath)) {
        throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
    }

    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider) as unknown as anchor.Program<CrankOracle>;
    const programId = program.programId;

    const [marketStatusPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        programId
    );
    const [bountyConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")],
        programId
    );
    const [bountyVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_vault")],
        programId
    );

    // Feed IDs: deployment.json (written by feed-deploy) wins, env FEED_ID is the legacy fallback.
    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const statusFeedId = deployment.marketStatusFeedId ?? process.env.FEED_ID!;
    // Status-only quote: the price feed is gone (momentum is a self-sampled
    // close→close change computed on-chain from the spot oracle), so the
    // quote covers [market_status] alone.
    const feedIds = [statusFeedId];
    const [quoteAccount] = OracleQuote.getCanonicalPubkey(queue.pubkey, feedIds);

    // AMM program client for firing make_offers at end of trading day
    const ammIdl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8")
    );
    const ammProgram = new anchor.Program(ammIdl as anchor.Idl, provider);
    const afhoMint = new PublicKey(deployment.mint);
    const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
    const ammPda = (seed: string) =>
        anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(seed), afhoMint.toBuffer()],
            ammProgram.programId
        )[0];
    const ammStatePda = ammPda("amm_state");
    const offerListPda = ammPda("offer_list");
    const metricsPda = ammPda("metrics");
    const acceptedOffersPda = ammPda("accepted_offers");

    // Raydium CPMM accounts for the swap adapter. When the pool is pinned in
    // The CPMM pool is the ONLY swap venue and price source. The pool pins
    // live in AmmState; an unpinned pool is a hard error (the on-chain
    // instructions reject it with PoolNotPinned) — never a stub price.
    function cpmmAccountsFor(
        ammState: any,
        usdcMint: PublicKey
    ) {
        if (!ammState.cpmmPoolState || !ammState.cpmmProgram) {
            throw new Error(
                "CPMM pool not pinned in AmmState — run 'anchor run set-cpmm-pool' (and 'set-sol-usdc-pool' for the SOL leg)."
            );
        }
        const program = new PublicKey(ammState.cpmmProgram);
        const pool = new PublicKey(ammState.cpmmPoolState);
        const [authority] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault_and_lp_mint_auth_seed")],
            program
        );
        const [observation] = PublicKey.findProgramAddressSync(
            [Buffer.from("observation"), pool.toBuffer()],
            program
        );
        const [inputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), usdcMint.toBuffer()],
            program
        );
        const [outputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), afhoMint.toBuffer()],
            program
        );
        return {
            cpmmPoolState: pool,
            cpmmAmmConfig: new PublicKey(ammState.cpmmAmmConfig),
            cpmmInputVault: inputVault,
            cpmmOutputVault: outputVault,
            cpmmObservation: observation,
            cpmmAuthority: authority,
            // The CPMM program itself must be among the instruction's
            // accounts or the swap CPI fails with MissingAccount.
            cpmmProgram: program,
        };
    }

    // Raydium SOL/USDC CPMM accounts for bounty_top_up / offer_claim_sol.
    // Returns null when the pool isn't pinned in state.
    function solUsdcAccountsFor(ammState: any) {
        if (!ammState.cpmmSolUsdcPool || !ammState.cpmmProgram) {
            return null;
        }
        const program = new PublicKey(ammState.cpmmProgram);
        const pool = new PublicKey(ammState.cpmmSolUsdcPool);
        const usdcMint = new PublicKey(ammState.usdcMint);
        const [authority] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault_and_lp_mint_auth_seed")],
            program
        );
        const [observation] = PublicKey.findProgramAddressSync(
            [Buffer.from("observation"), pool.toBuffer()],
            program
        );
        const [inputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), WSOL_MINT.toBuffer()],
            program
        );
        const [outputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), usdcMint.toBuffer()],
            program
        );
        return {
            solUsdcPoolState: pool,
            solUsdcAmmConfig: new PublicKey(ammState.cpmmSolUsdcConfig),
            solUsdcInputVault: inputVault,
            solUsdcOutputVault: outputVault,
            solUsdcObservation: observation,
            solUsdcAuthority: authority,
        };
    }

    // SOL/USDC pool vaults for the crank bounty's USD price read — null when
    // the pool isn't pinned in the bounty config (fixed-lamport fallback).
    // Shared by the production crank and the test-mode fee collection.
    function solUsdcCrankVaults(cfg: any) {
        if (!cfg.solUsdcPool || new PublicKey(cfg.solUsdcPool).equals(PublicKey.default)) {
            return null;
        }
        const cpmmProgram = new PublicKey(cfg.cpmmProgram);
        const pool = new PublicKey(cfg.solUsdcPool);
        const usdcMint = new PublicKey(cfg.usdcMint);
        const [wsolVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), WSOL_MINT.toBuffer()],
            cpmmProgram
        );
        const [usdcVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), usdcMint.toBuffer()],
            cpmmProgram
        );
        return { solUsdcWsolVault: wsolVault, solUsdcUsdcVault: usdcVault };
    }

    // ── descriptive-log helpers (amounts + % of vaults) ───────────────────
    const fmtRaw = (raw: bigint, decimals: number, maxFrac = 4): string => {
        const unit = 10n ** BigInt(decimals);
        const whole = raw / unit;
        let frac = (raw % unit).toString().padStart(decimals, "0").slice(0, maxFrac);
        frac = frac.replace(/0+$/, "");
        return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
    };
    const fmtUsdc = (raw: bigint) => `${fmtRaw(raw, 6)} USDC`;
    const fmtSolL = (raw: bigint) => `${fmtRaw(raw, 9)} SOL`;
    const fmtAfho = (raw: bigint) => `${fmtRaw(raw, 9, 2)} AFHO`;
    // Floor units = price per whole token × 1e9 (nano-USD).
    const fmtPrice = (floor: bigint) => `$${fmtRaw(floor, 9, 9)}`;
    const pctOf = (num: bigint, den: bigint): string =>
        den <= 0n ? "—" : `${(Number((num * 10000n) / den) / 100).toFixed(2)}%`;
    const bn = (v: unknown): bigint => BigInt((v as any).toString());

    // Custom error code out of a failed simulation ({"InstructionError":[..,{"Custom":N}]}).
    function customErrCode(err: unknown): number | null {
        const m = JSON.stringify(err).match(/"Custom":(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }
    const reason = (err: unknown, map: Record<number, string>): string => {
        const code = customErrCode(err);
        return code !== null ? (map[code] ?? `custom ${code}`) : JSON.stringify(err);
    };

    // SPL token amount (u64 LE at offset 64) — null when the account is absent.
    async function tokenAmount(pk: PublicKey): Promise<bigint | null> {
        const a = await connection.getAccountInfo(pk, "confirmed");
        if (!a || a.data.length < 72) return null;
        return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
    }

    // Bounty recycling: immediately re-fund the bounty vault with whatever
    // the crank just paid out. While this keeper is the only earner the
    // operator is effectively paying themselves (the keeper nets ~0 minus
    // the recycle tx fee), and the vault stays above the 0.2 SOL
    // bounty_top_up threshold so AFHO-funded top-ups never fire. Set
    // BOUNTY_RECYCLE=0 once third-party keepers win transitions — their
    // collections then drain the vault and top-ups resume as designed.
    const RECYCLE = process.env.BOUNTY_RECYCLE ?? "1";
    const recycleBounty = RECYCLE === "1";

    console.log(" Keeper started");
    console.log("Program ID:", programId.toBase58());
    console.log("Market Status:", marketStatusPda.toBase58());
    console.log("Bounty Config:", bountyConfigPda.toBase58());
    console.log("Bounty Vault:", bountyVaultPda.toBase58());
    if (recycleBounty) console.log("Bounty recycling: ON (BOUNTY_RECYCLE=0 to disable)");

    function getSleepDuration(): number {
        const now = new Date();
        const etHour = now.getUTCHours() - (now.getTimezoneOffset() === 240 ? 4 : 5);

        if ((etHour >= 9 && etHour < 10) || (etHour >= 15 && etHour < 16)) {
            return 60_000;
        }
        if (etHour >= 10 && etHour < 15) {
            return 300_000;
        }
        if (etHour >= 4 && etHour < 20) {
            return 900_000;
        }
        return 3_600_000;
    }

    while (true) {
        const sleepMs = getSleepDuration();
        try {
            const marketStatus = await program.account.marketStatus.fetch(marketStatusPda);
            const bountyConfig = await program.account.bountyConfig.fetch(bountyConfigPda);
            await logSlotTimeOnce(connection);
            let prevState: number = marketStatus.currentState as number;
            let newStatus: any = null;
            const quoteAccountInfo = await connection.getAccountInfo(quoteAccount);

            if (!quoteAccountInfo) {
                console.log("Quote account not found, sleeping...");
                await sleep(sleepMs);
                continue;
            }

            // Switchboard quote layout: discriminator(8) + queue(32) + slot(8) ...
            const quoteSlot = quoteAccountInfo
                ? new BN(quoteAccountInfo.data.readBigUInt64LE(40).toString())
                : new BN(0);

            if (quoteSlot.gt(bountyConfig.lastCrankSlot)) {
                // Real Switchboard crank (production path): push a fresh
                // managed quote + permissionless_crank in one transaction.
                const overrides = {
                    MASSIVE_API_KEY: process.env.MASSIVE_API_KEY!,
                    EARNINGSAPI_KEY: process.env.EARNINGSAPI_KEY!,
                };
                const ixs = await queue.fetchManagedUpdateIxs(crossbar, feedIds, {
                    variableOverrides: overrides,
                    payer: keypair.publicKey,
                });
                const crankQuote = quoteAccount;

                const crankAccounts: any = {
                    cranker: keypair.publicKey,
                    bountyConfig: bountyConfigPda,
                    bountyVault: bountyVaultPda,
                    quoteAccount: crankQuote,
                    clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
                    marketStatus: marketStatusPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                };
                Object.assign(crankAccounts, solUsdcCrankVaults(bountyConfig));

                const crankIx = await program.methods.permissionlessCrank().accountsStrict(crankAccounts).instruction();

                ixs.push(crankIx);

                const tx = await sb.asV0Tx({
                    connection,
                    ixs,
                    signers: [keypair],
                    computeUnitPrice: 20_000,
                });

                const sim = await connection.simulateTransaction(tx);
                if (sim.value.err) {
                    console.error("Simulation failed:", sim.value.err);
                    console.error(sim.value.logs?.join("\n") || "NO LOGS :(")
                    await sleep(sleepMs);
                    continue;
                }

                const bountyBalBefore = await connection.getBalance(bountyVaultPda);
                const sig = await connection.sendTransaction(tx);
                await connection.confirmTransaction(sig, "confirmed");
                console.log(` Cranked! ${sig}`);
                if (recycleBounty) {
                    // Vault delta = the bounty that just paid out (only the
                    // crank instruction moves the bounty vault). Recycle it.
                    try {
                        const paid = BigInt(await connection.getBalance(bountyVaultPda)) - BigInt(bountyBalBefore);
                        if (paid > 0n) {
                            const recycleTx = await sb.asV0Tx({
                                connection,
                                ixs: [
                                    anchor.web3.SystemProgram.transfer({
                                        fromPubkey: keypair.publicKey,
                                        toPubkey: bountyVaultPda,
                                        lamports: Number(paid),
                                    }),
                                ],
                                signers: [keypair],
                                computeUnitPrice: 20_000,
                            });
                            const recycleSig = await connection.sendTransaction(recycleTx);
                            await connection.confirmTransaction(recycleSig, "confirmed");
                            console.log(` bounty recycled: ${fmtSolL(paid)} straight back into the bounty vault — ${recycleSig}`);
                        }
                    } catch (e) {
                        console.error("!! bounty recycle failed:", (e as Error).message);
                    }
                }
                newStatus = await program.account.marketStatus.fetch(marketStatusPda);
                }

                // Trading day ends on 0→1 (open→after-hours), 0→2 (open→closed, holiday),
                // or 3→2 (halted→closed). Fire update_tradeday_stats FIRST (it owns all
                // end-of-day metric writes), then make_offers (read-only + posts sheet).
                if (newStatus !== null) {
                const dayEnded =
                    (prevState === 0 && (newStatus.currentState === 1 || newStatus.currentState === 2)) ||
                    (prevState === 3 && newStatus.currentState === 2);
                if (dayEnded) {
                    console.log(` Day ended (${prevState} → ${newStatus.currentState}). Firing update_tradeday_stats + make_offers...`);
                    try {
                        const ammStateForStats = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const statsUsdcMint = new PublicKey(ammStateForStats.usdcMint);
                        const statsCpmm = cpmmAccountsFor(ammStateForStats, statsUsdcMint);
                        const statsIx = await ammProgram.methods
                            .updateTradedayStats()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                marketMetrics: metricsPda,
                                marketStatus: marketStatusPda,
                                cpmmPoolState: statsCpmm.cpmmPoolState,
                                cpmmObservation: statsCpmm.cpmmObservation,
                                cpmmInputVault: statsCpmm.cpmmInputVault,
                                cpmmOutputVault: statsCpmm.cpmmOutputVault,
                                stakingPool: ammStateForStats.stakingPool,
                                afhoMint,
                            })
                            .instruction();
                        const statsTx = await sb.asV0Tx({
                            connection,
                            ixs: [statsIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const statsSim = await connection.simulateTransaction(statsTx);
                        if (statsSim.value.err) {
                            console.error("update_tradeday_stats simulation failed (already updated today?):", statsSim.value.err);
                        } else {
                            const statsSig = await connection.sendTransaction(statsTx);
                            await connection.confirmTransaction(statsSig, "confirmed");
                            console.log(` update_tradeday_stats fired! ${statsSig}`);
                        }

                        const makeOffersIx = await ammProgram.methods
                            .makeOffers()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                offerList: offerListPda,
                                marketStatus: marketStatusPda,
                                metrics: metricsPda,
                                acceptedOffers: acceptedOffersPda,
                                afhoMint: afhoMint,
                                afhoVault: new PublicKey(deployment.ammAfhoVault),
                                systemProgram: anchor.web3.SystemProgram.programId,
                            })
                            .instruction();

                        const offersTx = await sb.asV0Tx({
                            connection,
                            ixs: [makeOffersIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const offersSim = await connection.simulateTransaction(offersTx);
                        if (offersSim.value.err) {
                            console.error("make_offers simulation failed (already built today?):", offersSim.value.err);
                        } else {
                            const offersSig = await connection.sendTransaction(offersTx);
                            await connection.confirmTransaction(offersSig, "confirmed");
                            console.log(` make_offers fired! ${offersSig}`);
                        }
                    } catch (e) {
                        // Never let an offer-sheet failure kill the crank loop
                        console.error("!! end-of-day AMM sequence failed:", e);
                    }
                }

                // Trading day STARTS on a 1→0 or 2→0 transition — the same
                // canonical pair the crank increments trading_day_index on.
                // Never any other →0 (3→0 is a halt lift, not a new day; the
                // normal path is 2→1→0, so a watcher must not require a
                // direct 2→0).
                const dayStarted =
                    (prevState === 1 || prevState === 2) && newStatus.currentState === 0;
                if (dayStarted) {
                    console.log(` Day started (${prevState} → 0). Firing calc_completed_offers...`);
                    try {
                        // Live price for ratchet decay: the pinned CPMM pool
                        // (TWAP / vault-ratio) — the only price source.
                        const ammStateForCalc = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const calcUsdcMint = new PublicKey(ammStateForCalc.usdcMint);
                        const calcCpmm = cpmmAccountsFor(ammStateForCalc, calcUsdcMint);
                        const calcIx = await ammProgram.methods
                            .calcCompletedOffers()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                offerList: offerListPda,
                                marketStatus: marketStatusPda,
                                acceptedOffers: acceptedOffersPda,
                                cpmmPoolState: calcCpmm.cpmmPoolState,
                                cpmmObservation: calcCpmm.cpmmObservation,
                                cpmmInputVault: calcCpmm.cpmmInputVault,
                                cpmmOutputVault: calcCpmm.cpmmOutputVault,
                            })
                            .instruction();
                        const calcTx = await sb.asV0Tx({
                            connection,
                            ixs: [calcIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const calcSim = await connection.simulateTransaction(calcTx);
                        if (calcSim.value.err) {
                            console.error("calc_completed_offers simulation failed (already recorded today?):", calcSim.value.err);
                        } else {
                            const calcSig = await connection.sendTransaction(calcTx);
                            await connection.confirmTransaction(calcSig, "confirmed");
                            console.log(` calc_completed_offers fired! ${calcSig}`);
                        }
                    } catch (e) {
                        console.error("!! calc_completed_offers failed:", e);
                    }

                    // Staker distribution: swap yesterday's 10% USDC share to
                    // AFHO and deposit into the staking reward vault. Once per
                    // day (on-chain day_index guard); a sim failure (nothing
                    // collected / no stakers) is expected and skipped.
                    try {
                        const ammStateForDist = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const usdcMint = new PublicKey(ammStateForDist.usdcMint);
                        const stakingPoolPda = new PublicKey(ammStateForDist.stakingPool);
                        const stakingIdl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", "staking.json"), "utf-8"));
                        const stakingProgramId = new PublicKey(stakingIdl.address ?? stakingIdl.metadata?.address);
                        const [stakingRewardVault] = PublicKey.findProgramAddressSync(
                            [Buffer.from("rewards"), stakingPoolPda.toBuffer()],
                            stakingProgramId
                        );
                        const distIx = await ammProgram.methods
                            .distributeStakerRewards()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                marketStatus: marketStatusPda,
                                usdcRewards: ammStateForDist.usdcRewards,
                                afhoVault: ammStateForDist.afhoVault,
                                afhoMint,
                                usdcMint,
                                ...cpmmAccountsFor(ammStateForDist, usdcMint),
                                stakingProgram: stakingProgramId,
                                stakingPool: stakingPoolPda,
                                stakingRewardVault,
                                tokenProgram: TOKEN_PROGRAM_ID,
                                token2022Program: TOKEN_2022_PROGRAM_ID,
                                systemProgram: anchor.web3.SystemProgram.programId,
                            })
                            .instruction();
                        const distTx = await sb.asV0Tx({
                            connection,
                            ixs: [distIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const distSim = await connection.simulateTransaction(distTx);
                        if (distSim.value.err) {
                            console.log("distribute_staker_rewards skipped (already done / nothing to distribute / no stakers):", JSON.stringify(distSim.value.err));
                            console.log("  last logs:", distSim.value.logs?.slice(-4) ?? []);
                        } else {
                            const distSig = await connection.sendTransaction(distTx);
                            await connection.confirmTransaction(distSig, "confirmed");
                            console.log(` distribute_staker_rewards fired! ${distSig}`);
                        }
                    } catch (e) {
                        console.error("!! distribute_staker_rewards failed:", (e as Error).message);
                    }

                    // Records ledger: snapshot the day-start state for the
                    // /records page (app/public/records.json). Best-effort —
                    // a failed snapshot never fails the crank loop. Logs
                    // NEW vs updated so a stuck day index is obvious: the row
                    // is keyed by the on-chain trading_day_index, NOT the
                    // calendar date — a new row only appears when the day
                    // index rolls (1/2 → 0 transition).
                    try {
                        const { recordDay } = await import("../record-day");
                        const { row, inserted } = await recordDay(connection);
                        console.log(
                            ` records ledger: ${inserted ? "NEW trading day" : "updated existing day"} ` +
                                `#${row.dayIndex} (${row.date}, state ${row.marketState}) -> app/public/records.json`,
                        );
                    } catch (e) {
                        console.error("!! records snapshot failed:", (e as Error).message);
                    }
                }
            } else {
                console.log("No fresh quote, nothing to do.");
            }

            // dex_buyback slices: attempt every loop while the market is open.
            // On-chain pacing (MIN_SLICE_SLOTS) turns extra fires into cheap
            // no-ops; sim failures (no fills, budget spent) are expected.
            try {
                const statusNow = await program.account.marketStatus.fetch(marketStatusPda);
                if (statusNow.currentState === 0) {
                    const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                    const usdcMint = new PublicKey(ammState.usdcMint);
                    const bbVault = (await tokenAmount(ammState.usdcVault)) ?? 0n;
                    const bbAfhoBefore = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                    const bbBudget = bn(ammState.bbBudgetUsdc);
                    const bbSpent = bn(ammState.bbSpentUsdc);
                    const bbRemaining = bbBudget > bbSpent ? bbBudget - bbSpent : 0n;
                    const bbSpendable = bbRemaining < bbVault ? bbRemaining : bbVault;
                    const bbElapsed = Math.max(
                        0,
                        Math.floor(Date.now() / 1000) - Number(bn(statusNow.lastUpdatedTimestamp))
                    );
                    const bbWeight = bbElapsed < 3600 ? 150n : 500n;
                    const slotNow = BigInt(await connection.getSlot());
                    const bbX =
                        slotNow ^ (bn(statusNow.tradingDayIndex) << 16n) ^ bn(ammState.bbSliceCount);
                    const bbFactor = 5000n + (bbX % 10001n);
                    const estSlice = (bbSpendable * bbWeight * bbFactor) / 100_000_000n;
                    const estSliceCapped = estSlice > bbSpendable ? bbSpendable : estSlice;
                    const pacingLeft =
                        bn(ammState.bbLastSlot) > 0n &&
                        slotNow - bn(ammState.bbLastSlot) < BigInt(PACE_SLOTS)
                            ? Number(BigInt(PACE_SLOTS) - (slotNow - bn(ammState.bbLastSlot)))
                            : 0;
                    console.log(
                        ` dex_buyback: budget=${fmtUsdc(bbBudget)} spent=${fmtUsdc(bbSpent)} ` +
                        `(${pctOf(bbSpent, bbBudget)} of budget) vault=${fmtUsdc(bbVault)} ` +
                        `est slice=${fmtUsdc(estSliceCapped)} (${pctOf(estSliceCapped, bbVault)} of vault)` +
                        `${pacingLeft ? `, pacing ${pacingLeft} slots` : ""}`
                    );
                    const bbIx = await ammProgram.methods
                        .dexBuyback()
                        .accountsStrict({
                            cranker: keypair.publicKey,
                            ammState: ammStatePda,
                            marketStatus: marketStatusPda,
                            acceptedOffers: acceptedOffersPda,
                            usdcVault: ammState.usdcVault,
                            afhoVault: ammState.afhoVault,
                            afhoMint,
                            usdcMint,
                            ...cpmmAccountsFor(ammState, usdcMint),
                            tokenProgram: TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                            systemProgram: anchor.web3.SystemProgram.programId,
                        })
                        .instruction();
                    const bbTx = await sb.asV0Tx({
                        connection,
                        ixs: [bbIx],
                        signers: [keypair],
                        computeUnitPrice: 20_000,
                    });
                    const bbSim = await connection.simulateTransaction(bbTx);
                    if (bbSim.value.err) {
                        const bbReasons: Record<number, string> = {
                            6000: "unauthorized caller",
                            6001: "invalid market status",
                            6002: "market not open",
                            6003: "no offers taken last night — nothing to buy back",
                            6004: "slippage exceeded",
                            6005: "invalid oracle (or a Raydium CPI code propagated)",
                            6006: "CPMM pool account mismatch",
                            6007: "CPMM pool not pinned",
                        };
                        console.log(
                            ` dex_buyback skipped (${reason(bbSim.value.err, bbReasons)}): ` +
                            `spendable=${fmtUsdc(bbSpendable)} (${pctOf(bbSpendable, bbVault)} of vault)`
                        );
                        console.log("  last logs:", bbSim.value.logs?.slice(-4) ?? []);
                    } else {
                        const bbSig = await connection.sendTransaction(bbTx);
                        await connection.confirmTransaction(bbSig, "confirmed");
                        const after = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const spentDelta = bn(after.bbSpentUsdc) - bbSpent;
                        const bbVaultAfter = (await tokenAmount(ammState.usdcVault)) ?? 0n;
                        const bbAfhoAfter = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                        console.log(
                            ` dex_buyback slice fired: +${fmtUsdc(spentDelta)} ` +
                            `(${pctOf(spentDelta, bbVault)} of vault, ${pctOf(bn(after.bbSpentUsdc), bn(after.bbBudgetUsdc))} of budget) ` +
                            `+${fmtAfho(bbAfhoAfter - bbAfhoBefore)} → vault now=${fmtUsdc(bbVaultAfter)} — ${bbSig}`
                        );
                    }
                }
            } catch (e) {
                // Never let a buyback attempt kill the crank loop
                console.error("!! dex_buyback attempt failed:", (e as Error).message);
            }

            // buy_the_dip: attempt EVERY loop, any market state — the dip
            // buyer is always on. Calling it is also what keeps the spot-price
            // ring sampled. On-chain pacing + trigger turn most fires into
            // cheap no-ops; sim failures (cold start, no dip, day cap) are
            // expected.
            try {
                const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                const usdcMint = new PublicKey(ammState.usdcMint);
                const dipMetrics = await (ammProgram.account as any).marketMetrics.fetch(metricsPda);
                const cp = cpmmAccountsFor(ammState, usdcMint);
                // Client-side mirror of the on-chain trigger, for the log:
                // spot ≈ pool vault ratio (the on-chain read prefers the TWAP
                // when fresh, so this can drift slightly — marked "≈").
                const afhoPool = (await tokenAmount(cp.cpmmOutputVault)) ?? 0n;
                const usdcPool = (await tokenAmount(cp.cpmmInputVault)) ?? 0n;
                const dipSpot = afhoPool > 0n && usdcPool > 0n ? (usdcPool * 1_000_000_000_000n) / afhoPool : null;
                const dipReserve = (await tokenAmount(ammState.usdcDip)) ?? 0n;
                const dipAfhoBefore = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                const ring: bigint[] = (dipMetrics.spotPrices as unknown[]).map((v) => bn(v));
                let refSum = 0n;
                let dipSamples = 0;
                for (const p of ring) {
                    if (p > 0n) {
                        refSum += p;
                        dipSamples++;
                    }
                }
                const dipRef = dipSamples > 0 ? refSum / BigInt(dipSamples) : 0n;
                let dipDepthBps = 0n;
                if (dipSpot !== null && dipSamples >= 5 && dipRef > 0n && dipSpot < dipRef) {
                    dipDepthBps = ((dipRef - dipSpot) * 10_000n) / dipRef;
                }
                // trend slope (port of trend_slope_cp): recent-5 minus older-15
                // mean of the 20-day price_changes ring, ±1000 per sample, zeros skipped.
                const changes: number[] = (dipMetrics.priceChanges as unknown[]).map((v) => Number(v));
                const n = changes.length;
                const head = Number(bn(dipMetrics.sampleHead)) % n;
                let recentSum = 0;
                let recentN = 0;
                let olderSum = 0;
                let olderN = 0;
                for (let age = 0; age < n; age++) {
                    const raw = changes[(head + age) % n];
                    if (raw === 0) continue;
                    const v = Math.max(-1000, Math.min(1000, raw));
                    if (age >= n - 5) {
                        recentSum += v;
                        recentN++;
                    } else {
                        olderSum += v;
                        olderN++;
                    }
                }
                const dipSlope = (recentN ? recentSum / recentN : 0) - (olderN ? olderSum / olderN : 0);
                // spend bps (port of dip_spend_bps): 2500 × depth² × trend mult.
                let dipSpendBps = 0n;
                if (dipDepthBps >= 300n) {
                    const clamped = dipDepthBps > 1000n ? 1000n : dipDepthBps;
                    const depth2 = (clamped * clamped * 10_000n) / 1_000_000n;
                    const mult = Math.max(2500, Math.min(12500, 10000 + Math.trunc(dipSlope) * 10));
                    dipSpendBps = (2500n * depth2 * BigInt(mult)) / 100_000_000n;
                }
                const dipDayCap = (bn(ammState.dipDayUsdc) * 4000n) / 10_000n;
                const dipCapLeft = dipDayCap > bn(ammState.dipSpentUsdc) ? dipDayCap - bn(ammState.dipSpentUsdc) : 0n;
                const dipSliceRaw = (dipReserve * dipSpendBps) / 10_000n;
                const dipEstSlice = dipSliceRaw > dipCapLeft ? dipCapLeft : dipSliceRaw;
                const dipSlot = BigInt(await connection.getSlot());
                const dipPacingLeft =
                    bn(ammState.dipLastSlot) > 0n &&
                    dipSlot - bn(ammState.dipLastSlot) < BigInt(PACE_SLOTS)
                        ? Number(BigInt(PACE_SLOTS) - (dipSlot - bn(ammState.dipLastSlot)))
                        : 0;
                console.log(
                    ` buy_the_dip: reserve=${fmtUsdc(dipReserve)} dayBudget=${fmtUsdc(bn(ammState.dipDayUsdc))} ` +
                    `spent=${fmtUsdc(bn(ammState.dipSpentUsdc))} (${pctOf(bn(ammState.dipSpentUsdc), dipDayCap)} of 40% day cap) ` +
                    `spot≈${dipSpot !== null ? fmtPrice(dipSpot) : "—"} ref=${dipRef > 0n ? fmtPrice(dipRef) : "—"} ` +
                    `depth=${(Number(dipDepthBps) / 100).toFixed(2)}% (trigger 3%) samples=${dipSamples} slope=${Math.trunc(dipSlope)}cp ` +
                    `→ est slice=${fmtUsdc(dipEstSlice)} (${pctOf(dipEstSlice, dipReserve)} of reserve)` +
                    `${dipPacingLeft ? `, pacing ${dipPacingLeft} slots` : ""}`
                );
                const dipIx = await ammProgram.methods
                    .buyTheDip()
                    .accountsStrict({
                        cranker: keypair.publicKey,
                        ammState: ammStatePda,
                        marketStatus: marketStatusPda,
                        metrics: metricsPda,
                        usdcDip: ammState.usdcDip,
                        afhoVault: ammState.afhoVault,
                        afhoMint,
                        usdcMint,
                        ...cpmmAccountsFor(ammState, usdcMint),
                        tokenProgram: TOKEN_PROGRAM_ID,
                        token2022Program: TOKEN_2022_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .instruction();
                const dipTx = await sb.asV0Tx({
                    connection,
                    ixs: [dipIx],
                    signers: [keypair],
                    computeUnitPrice: 20_000,
                });
                const dipSim = await connection.simulateTransaction(dipTx);
                if (dipSim.value.err) {
                    const dipReasons: Record<number, string> = {
                        6000: "unauthorized caller",
                        6001: "invalid market status",
                        6002: "invalid oracle (or a Raydium CPI code propagated)",
                        6003: "CPMM pool account mismatch",
                        6004: "CPMM pool not pinned",
                        6005: "Raydium ExceededSlippage propagated (see last logs)",
                        6006: "Raydium ZeroTradingTokens propagated (see last logs)",
                        6007: "Raydium NotSupportMint propagated (see last logs)",
                        6008: "Raydium InvalidVault propagated (see last logs)",
                    };
                    console.log(
                        ` buy_the_dip skipped (${reason(dipSim.value.err, dipReasons)}): ` +
                        `reserve=${fmtUsdc(dipReserve)} est slice=${fmtUsdc(dipEstSlice)}`
                    );
                    console.log("  last logs:", dipSim.value.logs?.slice(-4) ?? []);
                } else {
                    const dipSig = await connection.sendTransaction(dipTx);
                    await connection.confirmTransaction(dipSig, "confirmed");
                    // NB: a successful tx is usually a no-op (ring sampling / no dip
                    // / pacing) — the on-chain trigger decides whether a slice is spent.
                    const after = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                    const spentDelta = bn(after.dipSpentUsdc) - bn(ammState.dipSpentUsdc);
                    const dipReserveAfter = (await tokenAmount(ammState.usdcDip)) ?? 0n;
                    const dipAfhoAfter = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                    if (spentDelta > 0n) {
                        console.log(
                            ` buy_the_dip slice FIRED: +${fmtUsdc(spentDelta)} ` +
                            `(${pctOf(spentDelta, dipReserve)} of reserve, ${pctOf(bn(after.dipSpentUsdc), dipDayCap)} of day cap) ` +
                            `+${fmtAfho(dipAfhoAfter - dipAfhoBefore)} → reserve now=${fmtUsdc(dipReserveAfter)} — ${dipSig}`
                        );
                    } else {
                        const noopWhy =
                            dipSamples < 5
                                ? `cold start (${dipSamples}/5 samples)`
                                : dipDepthBps < 300n
                                    ? `no dip (depth ${(Number(dipDepthBps) / 100).toFixed(2)}% < 3%)`
                                    : dipPacingLeft
                                        ? `pacing (${dipPacingLeft} slots left)`
                                        : "day cap reached / reserve empty";
                        console.log(` buy_the_dip no-op (${noopWhy}) — ${dipSig}`);
                    }
                }
            } catch (e) {
                // Never let a dip attempt kill the crank loop
                console.error("!! buy_the_dip attempt failed:", (e as Error).message);
            }

            // bounty_top_up: attempt every loop — permissionless, and the
            // on-chain low-water check turns healthy vaults into a cheap no-op.
            try {
                const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                const solUsdc = solUsdcAccountsFor(ammState);
                const afhoUsdc = cpmmAccountsFor(
                    ammState,
                    new PublicKey(ammState.usdcMint)
                );
                if (solUsdc && ammState.cpmmPoolState && !new PublicKey(ammState.cpmmPoolState).equals(PublicKey.default)) {
                    const usdcMint = new PublicKey(ammState.usdcMint);
                    const afhoMint = new PublicKey(ammState.afhoMint);
                    const wsolVault = getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true);
                    // Amounts for the log: bounty balance, both pool prices
                    // (vault-ratio ≈), and the AFHO the top-up would sell.
                    const bountyBal = BigInt(await connection.getBalance(bountyVaultPda));
                    const afhoVaultBal = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                    const afhoPoolRaw = (await tokenAmount(afhoUsdc.cpmmOutputVault)) ?? 0n;
                    const usdcPoolRaw = (await tokenAmount(afhoUsdc.cpmmInputVault)) ?? 0n;
                    const wsolPoolRaw = (await tokenAmount(solUsdc.solUsdcInputVault)) ?? 0n;
                    const solPoolUsdc = (await tokenAmount(solUsdc.solUsdcOutputVault)) ?? 0n;
                    const afhoPrice = afhoPoolRaw > 0n && usdcPoolRaw > 0n ? (usdcPoolRaw * 1_000_000_000_000n) / afhoPoolRaw : 0n;
                    const solPrice = wsolPoolRaw > 0n && solPoolUsdc > 0n ? (solPoolUsdc * 1_000_000_000_000n) / wsolPoolRaw : 0n;
                    const TOPUP_SOL = 400_000_000n; // 0.4 SOL added each top-up
                    const usdcNeeded = solPrice > 0n ? (TOPUP_SOL * solPrice * 10_025n) / 1_000_000_000_000n / 10_000n : 0n;
                    const afhoIn = afhoPrice > 0n ? (usdcNeeded * 1_000_000_000_000n * 10_025n) / afhoPrice / 10_000n : 0n;
                    console.log(
                        ` bounty_top_up: bounty=${fmtSolL(bountyBal)} (tops up +0.4 SOL when < 0.2) ` +
                        `afho_price=${afhoPrice > 0n ? fmtPrice(afhoPrice) : "—"} sol_price=${solPrice > 0n ? fmtPrice(solPrice) : "—"} ` +
                        `→ est AFHO sold=${fmtAfho(afhoIn)} (${pctOf(afhoIn, afhoVaultBal)} of afho_vault) ` +
                        `est USDC hop=${fmtUsdc(usdcNeeded)}`
                    );
                    const topupIx = await ammProgram.methods
                        .bountyTopUp()
                        .accountsStrict({
                            cranker: keypair.publicKey,
                            ammState: ammStatePda,
                            bountyVault: bountyVaultPda,
                            afhoVault: ammState.afhoVault,
                            usdcVault: ammState.usdcVault,
                            afhoMint,
                            usdcMint,
                            wsolVault,
                            wrappedSolMint: WSOL_MINT,
                            cpmmPoolState: afhoUsdc.cpmmPoolState,
                            cpmmAmmConfig: afhoUsdc.cpmmAmmConfig,
                            cpmmInputVault: afhoUsdc.cpmmInputVault,
                            cpmmOutputVault: afhoUsdc.cpmmOutputVault,
                            cpmmObservation: afhoUsdc.cpmmObservation,
                            cpmmAuthority: afhoUsdc.cpmmAuthority,
                            cpmmProgram: afhoUsdc.cpmmProgram,
                            ...solUsdc,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                            systemProgram: anchor.web3.SystemProgram.programId,
                        })
                        .instruction();
                    const topupTx = await sb.asV0Tx({
                        connection,
                        ixs: [topupIx],
                        signers: [keypair],
                        computeUnitPrice: 20_000,
                    });
                    const topupSim = await connection.simulateTransaction(topupTx);
                    if (topupSim.value.err) {
                        const topupReasons: Record<number, string> = {
                            6000: "invalid pool price oracle",
                            6001: "AFHO/USDC or SOL/USDC pool not pinned",
                            6002: "computed AFHO amount is zero",
                            6003: "treasury AFHO too low to top up",
                            6004: "CPMM pool account mismatch",
                            6005: "AFHO→USDC swap returned nothing (or a Raydium CPI code propagated)",
                            6006: "math overflow",
                        };
                        console.log(
                            ` bounty_top_up skipped (${reason(topupSim.value.err, topupReasons)}): ` +
                            `bounty=${fmtSolL(bountyBal)} est AFHO=${fmtAfho(afhoIn)} (${pctOf(afhoIn, afhoVaultBal)} of afho_vault)`
                        );
                        console.log("  last logs:", topupSim.value.logs?.slice(-4) ?? []);
                    } else if (bountyBal >= 200_000_000n) {
                        // Simulation passed because the on-chain low-water check
                        // no-ops — don't spend a tx on a healthy vault.
                        console.log(` bounty_top_up no-op (vault healthy: ${fmtSolL(bountyBal)} ≥ 0.2 SOL)`);
                    } else {
                        const topupSig = await connection.sendTransaction(topupTx);
                        await connection.confirmTransaction(topupSig, "confirmed");
                        const bountyAfter = BigInt(await connection.getBalance(bountyVaultPda));
                        console.log(
                            ` bounty_top_up fired: bounty ${fmtSolL(bountyBal)} → ${fmtSolL(bountyAfter)} ` +
                            `(+${fmtSolL(bountyAfter - bountyBal)} SOL, sold ≈${fmtAfho(afhoIn)} AFHO = ${pctOf(afhoIn, afhoVaultBal)} of afho_vault) — ${topupSig}`
                        );
                    }
                }
            } catch (e) {
                console.error("!! bounty_top_up attempt failed:", (e as Error).message);
            }
        } catch (e) {
            console.error("!! Crank attempt failed:", e);
        }

        await sleep(sleepMs);
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

// ── Slot-time assumption watch ─────────────────────────────────────────────
// All on-chain pacing (MIN_SLICE_SLOTS / DIP_MIN_SLICE_SLOTS / SPOT_SAMPLE_SLOTS)
// is slot-denominated and derives from NOMINAL_SLOT_MS in dex_buyback.rs at
// compile time. Solana's nominal slot time is 400ms today; a ~200ms target is
// ATTEMPTED (Alpenglow-class consensus change), not guaranteed — if it lands,
// flip NOMINAL_SLOT_MS to 200 and redeploy (pacing re-derives: 300/300/150),
// BEFORE `solana program set-upgrade-authority --final`. This log prints the
// chain's MEASURED slot time (getRecentPerformanceSamples) against that
// assumption every ~5 min so drift — devnet already runs slower than nominal —
// is visible next to the pacing math.
const NOMINAL_SLOT_MS = 400; // mirrors dex_buyback.rs — flip both together
const PACE_SLOTS = 60_000 / NOMINAL_SLOT_MS; // ~1 slice/min — mirrors MIN_SLICE_SLOTS
let lastSlotTimeCheck = 0;
async function logSlotTimeOnce(connection: anchor.web3.Connection) {
    const now = Date.now();
    if (now - lastSlotTimeCheck < 300_000) return;
    lastSlotTimeCheck = now;
    try {
        const samples = await connection.getRecentPerformanceSamples(3);
        if (samples.length < 2) return;
        const span = samples[0].slot - samples[samples.length - 1].slot;
        const secs = samples.reduce((acc, s) => acc + s.samplePeriodSecs, 0);
        if (span > 0) {
            const msPerSlot = (secs * 1000) / span;
            console.log(
                ` slot time: ~${msPerSlot.toFixed(0)}ms/slot measured vs ${NOMINAL_SLOT_MS}ms ` +
                    `assumed for pacing constants (MIN_SLICE = ${PACE_SLOTS} slots ≈ 60s)`
            );
        }
    } catch {
        // informational only — perf samples unavailable on this RPC
    }
}

main();