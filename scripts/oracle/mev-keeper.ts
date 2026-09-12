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
import { ANSI, ev, evc, skip, dim } from "./keeper-log";

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
    // Alt desk sheet (state-3 second bond sheet). Created lazily on-chain;
    // the PDA is deterministic so the keeper can pass it pre-creation.
    const altListPda = ammPda("alt_offer_list");
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

    console.log(` ${ev(ANSI.cyan, "Keeper started")}`);
    console.log(`${evc(ANSI.cyan, "Program ID")}${programId.toBase58()}`);
    console.log(`${evc(ANSI.cyan, "Market Status")}${marketStatusPda.toBase58()}`);
    console.log(`${evc(ANSI.cyan, "Bounty Config")}${bountyConfigPda.toBase58()}`);
    console.log(`${evc(ANSI.cyan, "Bounty Vault")}${bountyVaultPda.toBase58()}`);

    // ── TEST-STATE MODE (devnet/localnet only) ─────────────────────────────
    // `--test-state` drives the market-status PDA through a scripted state
    // cycle via crank test_set_state INSTEAD of cranking the real Switchboard
    // feed, then runs the exact same transition sequences (end-of-day stats +
    // make_offers, start-of-day calc_completed_offers, dex_buyback slices,
    // buy_the_dip, bounty_top_up) as the real keeper loop. For exercising the
    // offer desk without waiting for NYSE hours.
    //   --test-day <n>          start trading-day index (default: on-chain)
    //   --test-interval-ms <n>  ms per scripted state (default: 15000)
    //   TEST_STATE_SEQUENCE     env override, e.g. "0,1,2,1,0" (default cycle:
    //                           close → closed → extended hours → open, so the
    //                           trading day rolls on the realistic 1→0 open —
    //                           the crank also counts 2→0 opens, but real days
    //                           nearly always pass through extended hours)
    // DEVNET/TEST ONLY — remove before mainnet together with crank
    // test_set_state and scripts/oracle/set-oracle-state.ts.
    const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    const TEST_STATE = process.argv.includes("--test-state");
    const testStateIdx = process.argv.indexOf("--test-state");
    const TEST_STATE_MODE: "cycle" | "watch" =
        TEST_STATE && process.argv[testStateIdx + 1] === "watch" ? "watch" : "cycle";
    let lastSeenState: number | null = null;
    let lastSeenDay: number | null = null; // trading_day_index at the previous poll
    const testDayArg = process.argv.indexOf("--test-day");
    const TEST_DAY = testDayArg !== -1 ? parseInt(process.argv[testDayArg + 1], 10) : null;
    const testIntervalArg = process.argv.indexOf("--test-interval-ms");
    const TEST_INTERVAL_MS =
        testIntervalArg !== -1 ? parseInt(process.argv[testIntervalArg + 1], 10) : 15_000;
    const TEST_SEQUENCE = (process.env.TEST_STATE_SEQUENCE ?? "0,1,2,1,0")
        .split(",")
        .map((s) => parseInt(s.trim(), 10));
    let testCursor = 0;
    let testDay: number | null = TEST_DAY;

    // Bounty recycling: immediately re-fund the bounty vault with whatever
    // the crank just paid out, so the vault stays above the 10-payment
    // bounty_top_up low water while this keeper is the only earner (the
    // operator is effectively paying themselves; the keeper nets ~0 minus
    // the recycle tx fee). Default ON in production, OFF under --test-state
    // (the test harness drains the vault on purpose so the bounty_top_up
    // refill loop runs for real). BOUNTY_RECYCLE=0/1 overrides either way.
    const RECYCLE = process.env.BOUNTY_RECYCLE ?? (TEST_STATE ? "0" : "1");
    const recycleBounty = RECYCLE === "1";

    if (TEST_STATE) {
        const endpoint = connection.rpcEndpoint;
        const genesisHash = await connection.getGenesisHash();
        const host = (() => {
            try {
                return new URL(endpoint).hostname;
            } catch {
                return "";
            }
        })();
        const isLocalnet = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
        if (!isLocalnet && genesisHash !== DEVNET_GENESIS_HASH) {
            throw new Error(
                `REFUSING: --test-state is a DEVNET/LOCALNET test mode ` +
                    `(endpoint ${endpoint}, genesis ${genesisHash.slice(0, 8)}…). ` +
                    `Run the real keeper without --test-state.`
            );
        }
        console.log(
            TEST_STATE_MODE === "watch"
                ? `${evc(ANSI.brightYellow, "TEST WATCH MODE")}idle + react to external state changes, polling every ${TEST_INTERVAL_MS}ms. ` +
                      `Drive transitions with \`anchor run set-oracle -- <state> [day]\` ` +
                      `(0=open 1=after-hours 2=closed 3=halted). Pause = don't change the state.`
                : `${evc(ANSI.brightYellow, "TEST-STATE MODE")}cycle ${TEST_SEQUENCE.join(" → ")} every ${TEST_INTERVAL_MS}ms`
        );
    }

    // ET wall-clock hour, host-timezone-independent: Intl resolves
    // America/New_York with correct EDT/EST DST handling. (The old
    // `getTimezoneOffset() === 240 ? -4 : -5` inference read the HOST's
    // offset — on a UTC host it subtracted 5 all year, so the cadence was
    // an hour off during EDT.)
    function getSleepDuration(): number {
        const etHour = Number(
            new Intl.DateTimeFormat("en-US", {
                timeZone: "America/New_York",
                hour: "numeric",
                hourCycle: "h23",
            }).format(new Date())
        );

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
        const sleepMs = TEST_STATE ? TEST_INTERVAL_MS : getSleepDuration();
        try {
            const marketStatus = await program.account.marketStatus.fetch(marketStatusPda);
            const bountyConfig = await program.account.bountyConfig.fetch(bountyConfigPda);
            await logSlotTimeOnce(connection);
            let prevState: number = marketStatus.currentState as number;
            let newStatus: any = null;
            let dayRolled = false; // day index advanced since the previous poll
            let quoteAccountInfo: any = null;
            if (!TEST_STATE) {
                quoteAccountInfo = await connection.getAccountInfo(quoteAccount);

                if (!quoteAccountInfo) {
                    console.log(dim("Quote account not found, sleeping..."));
                    await sleep(sleepMs);
                    continue;
                }
            }

            // Switchboard quote layout: discriminator(8) + queue(32) + slot(8) ...
            const quoteSlot = quoteAccountInfo
                ? new BN(quoteAccountInfo.data.readBigUInt64LE(40).toString())
                : new BN(0);

            if (TEST_STATE || quoteSlot.gt(bountyConfig.lastCrankSlot)) {
                if (TEST_STATE && TEST_STATE_MODE === "watch") {
                    // Watch mode: the keeper never writes the market status.
                    // The loop-start fetch IS the (possibly new) on-chain
                    // state; compare with the previous loop and react to any
                    // change exactly like the real keeper reacts to the feed.
                    // The trading_day_index is ALSO watched: state changes
                    // can be driven faster than the poll interval, so a
                    // collapsed 2→1→0 cycle may present as 0→0 — the day
                    // index roll is the canonical proof a new trading day
                    // started and must not be missed.
                    const dayChanged =
                        lastSeenDay !== null &&
                        marketStatus.tradingDayIndex.toNumber() !== lastSeenDay;
                    if (
                        lastSeenState !== null &&
                        (marketStatus.currentState !== lastSeenState || dayChanged)
                    ) {
                        prevState = lastSeenState;
                        newStatus = marketStatus;
                        dayRolled = dayChanged;
                        console.log(
                            `${evc(ANSI.brightYellow, "watch")}${lastSeenState} -> ${marketStatus.currentState} (day ${marketStatus.tradingDayIndex})` +
                                (dayRolled ? " [day rolled]" : "")
                        );
                    } else if (lastSeenState === null) {
                        console.log(
                            `${evc(ANSI.brightYellow, "watch")}first observation (state ${marketStatus.currentState}, day ${marketStatus.tradingDayIndex}) — transition handlers fire from the next state change`
                        );
                    }
                    lastSeenState = marketStatus.currentState as number;
                    lastSeenDay = marketStatus.tradingDayIndex.toNumber();
                } else if (TEST_STATE) {
                    // Scripted fake crank: advance the test cycle via crank
                    // test_set_state (devnet-only) instead of the Switchboard
                    // managed update. The transition handlers below (end of
                    // day / start of day) run identically to the real path.
                    if (testDay === null) testDay = marketStatus.tradingDayIndex.toNumber();
                    const state = TEST_SEQUENCE[testCursor % TEST_SEQUENCE.length];
                    testCursor++;
                    if (
                        state === 0 &&
                        (marketStatus.currentState === 1 || marketStatus.currentState === 2)
                    ) {
                        testDay++; // mirror the crank: 1/2 → 0 rolls the day forward
                    }
                    const ts = Math.floor(Date.now() / 1000);
                    const setTx = await sb.asV0Tx({
                        connection,
                        ixs: [
                            await program.methods
                                .testSetState(state, new BN(testDay), new BN(ts))
                                .accounts({ marketStatus: marketStatusPda })
                                .instruction(),
                        ],
                        signers: [keypair],
                        computeUnitPrice: 20_000,
                    });
                    const setSim = await connection.simulateTransaction(setTx);
                    if (setSim.value.err) {
                        console.error(`${evc(ANSI.red, "test_set_state simulation failed")}${setSim.value.err}`);
                        await sleep(sleepMs);
                        continue;
                    }
                    const setSig = await connection.sendTransaction(setTx);
                    await connection.confirmTransaction(setSig, "confirmed");
                    console.log(
                        `${ev(ANSI.brightYellow, "TEST crank")} ${marketStatus.currentState} -> ${state} (day ${testDay}) [${setSig}]`
                    );
                    newStatus = await program.account.marketStatus.fetch(marketStatusPda);
                } else {
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
                    console.error(`${evc(ANSI.red, "Simulation failed")}${sim.value.err}`);
                    console.error(sim.value.logs?.join("\n") || "NO LOGS :(")
                    await sleep(sleepMs);
                    continue;
                }

                const bountyBalBefore = await connection.getBalance(bountyVaultPda);
                const sig = await connection.sendTransaction(tx);
                await connection.confirmTransaction(sig, "confirmed");
                console.log(`${ev(ANSI.green, "Cranked!")} ${sig}`);
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
                            console.log(`${evc(ANSI.brightGreen, "bounty recycled")}${fmtSolL(paid)} straight back into the bounty vault — ${recycleSig}`);
                        }
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! bounty recycle failed")}${(e as Error).message}`);
                    }
                }
                newStatus = await program.account.marketStatus.fetch(marketStatusPda);
                }

                // Trading day ends on 0→1 (open→after-hours), 0→2 (open→closed, holiday),
                // or 3→2 (halted→closed). Fire update_tradeday_stats FIRST (it owns all
                // end-of-day metric writes), then make_offers (read-only + posts sheet).
                if (newStatus === null) {
                    // watch mode, no state change this loop — skip the transition
                    // handlers; the always-on loops below still run.
                } else {
                // Test-mode crank fee: production pays the transition bounty
                // to whoever lands the state change (permissionless_crank);
                // test_set_state can't, so in --test-state modes the keeper
                // collects the same bounty via the devnet-only
                // test_collect_bounty on each transition it detects/drives.
                // This drains the bounty vault "like testnet" so the
                // bounty_top_up refill loop runs for real.
                if (TEST_STATE) {
                    try {
                        const feeVaults = solUsdcCrankVaults(bountyConfig) ?? {
                            solUsdcWsolVault: null,
                            solUsdcUsdcVault: null,
                        };
                        const feeIx = await program.methods
                            .testCollectBounty()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                bountyConfig: bountyConfigPda,
                                bountyVault: bountyVaultPda,
                                ...feeVaults,
                            })
                            .instruction();
                        const feeTx = await sb.asV0Tx({
                            connection,
                            ixs: [feeIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const feeSim = await connection.simulateTransaction(feeTx);
                        if (feeSim.value.err) {
                            console.log(`${skip("test_collect_bounty skipped")}${JSON.stringify(feeSim.value.err)}`);
                            console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, feeSim.value.logs?.slice(-4) ?? []);
                        } else {
                            const feeBalBefore = BigInt(await connection.getBalance(bountyVaultPda));
                            const feeSig = await connection.sendTransaction(feeTx);
                            await connection.confirmTransaction(feeSig, "confirmed");
                            const feeBalAfter = BigInt(await connection.getBalance(bountyVaultPda));
                            console.log(
                                `${ev(ANSI.brightYellow, "test crank fee collected")} bounty vault ${fmtSolL(feeBalBefore)} → ${fmtSolL(feeBalAfter)} — ${feeSig}`
                            );
                            if (recycleBounty) {
                                const paid = feeBalAfter - feeBalBefore;
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
                                    console.log(`${evc(ANSI.brightGreen, "bounty recycled")}${fmtSolL(paid)} back into the bounty vault — ${recycleSig}`);
                                }
                            }
                        }
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! test_collect_bounty failed")}${(e as Error).message}`);
                    }
                }
                const dayEnded =
                    (prevState === 0 && (newStatus.currentState === 1 || newStatus.currentState === 2)) ||
                    (prevState === 3 && newStatus.currentState === 2);
                if (dayEnded) {
                    console.log(`${ev(ANSI.magenta, "Day ended")} (${prevState} → ${newStatus.currentState}). Firing update_tradeday_stats + make_offers...`);
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
                            console.error(`${evc(ANSI.red, "update_tradeday_stats simulation failed (already updated today?)")}${statsSim.value.err}`);
                        } else {
                            const statsSig = await connection.sendTransaction(statsTx);
                            await connection.confirmTransaction(statsSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "update_tradeday_stats fired!")} ${statsSig}`);
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
                            console.error(`${evc(ANSI.red, "make_offers simulation failed (already built today?)")}${offersSim.value.err}`);
                        } else {
                            const offersSig = await connection.sendTransaction(offersTx);
                            await connection.confirmTransaction(offersSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "make_offers fired!")} ${offersSig}`);
                        }
                    } catch (e) {
                        // Never let an offer-sheet failure kill the crank loop
                        console.error(`${evc(ANSI.red, "!! end-of-day AMM sequence failed")}${e}`);
                    }
                }

                // The alt desk: a →3 transition (from ANY state) posts the
                // second, fixed-terms sheet. One sheet per trading day is
                // enforced on-chain (alt_list.day_index cooldown); the
                // "already posted today" simulation failure is normal noise
                // when a halt flaps. Never let it kill the loop.
                const haltStarted = newStatus.currentState === 3 && prevState !== 3;
                if (haltStarted) {
                    console.log(`${ev(ANSI.brightYellow, "Alt sheet window")} (${prevState} → 3). Firing make_alt_offers...`);
                    try {
                        const altStateForSheet = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const altOffersIx = await ammProgram.methods
                            .makeAltOffers()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                altList: altListPda,
                                marketStatus: marketStatusPda,
                                afhoMint: afhoMint,
                                afhoVault: new PublicKey(deployment.ammAfhoVault),
                                systemProgram: anchor.web3.SystemProgram.programId,
                            })
                            .instruction();
                        const altTx = await sb.asV0Tx({
                            connection,
                            ixs: [altOffersIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const altSim = await connection.simulateTransaction(altTx);
                        if (altSim.value.err) {
                            console.error(`${evc(ANSI.red, "make_alt_offers simulation failed (already posted today?)")}${altSim.value.err}`);
                        } else {
                            const altSig = await connection.sendTransaction(altTx);
                            await connection.confirmTransaction(altSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "make_alt_offers fired!")} ${altSig}`);
                        }
                    } catch (e) {
                        // Never let an alt-sheet failure kill the crank loop
                        console.error(`${evc(ANSI.red, "!! alt sheet sequence failed")}${e}`);
                    }
                }

                // Trading day STARTS on a 1→0 or 2→0 transition — the same
                // canonical pair the crank increments trading_day_index on.
                // Never any other →0 (3→0 is a halt lift, not a new day; the
                // normal path is 2→1→0, so a watcher must not require a
                // direct 2→0). Watch mode ALSO accepts a day-index roll with
                // the state at 0: transitions driven faster than the poll
                // interval can collapse to 0→0, and the rollover is the
                // canonical proof the day started.
                const dayStarted =
                    newStatus.currentState === 0 &&
                    ((prevState === 1 || prevState === 2) || dayRolled);
                if (dayStarted) {
                    console.log(`${ev(ANSI.brightMagenta, "Day started")} (${prevState} → 0${dayRolled ? ", day rolled" : ""}). Firing calc_completed_offers...`);
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
                            console.error(`${evc(ANSI.red, "calc_completed_offers simulation failed (already recorded today?)")}${calcSim.value.err}`);
                        } else {
                            const calcSig = await connection.sendTransaction(calcTx);
                            await connection.confirmTransaction(calcSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "calc_completed_offers fired!")} ${calcSig}`);
                        }
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! calc_completed_offers failed")}${e}`);
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
                            console.log(`${skip("distribute_staker_rewards skipped (already done / nothing to distribute / no stakers)")}${JSON.stringify(distSim.value.err)}`);
                            console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, distSim.value.logs?.slice(-4) ?? []);
                        } else {
                            const distSig = await connection.sendTransaction(distTx);
                            await connection.confirmTransaction(distSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "distribute_staker_rewards fired!")} ${distSig}`);
                        }
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! distribute_staker_rewards failed")}${(e as Error).message}`);
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
                            `${ev(ANSI.cyan, "records ledger")} ${inserted ? "NEW trading day" : "updated existing day"} ` +
                                `#${row.dayIndex} (${row.date}, state ${row.marketState}) -> app/public/records.json`,
                        );
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! records snapshot failed")}${(e as Error).message}`);
                    }
                }
                }
            } else {
                console.log(dim("No fresh quote, nothing to do."));
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
                    const slotNow = BigInt(await connection.getSlot());
                    const bbX =
                        slotNow ^ (bn(statusNow.tradingDayIndex) << 16n) ^ bn(ammState.bbSliceCount);
                    // Mirror the on-chain per-day hour-1 target (30–60%) and
                    // its derived per-slice weight; the tail keeps the
                    // 0.5x–1.5x spread.
                    let bbWeight: bigint;
                    let bbFactor: bigint;
                    if (bbElapsed < 3600) {
                        const mintBytes = afhoMint.toBytes();
                        const daySeed =
                            ((bn(statusNow.tradingDayIndex) * 0x9e37_79b9_7f4a_7c15n) &
                                0xffff_ffff_ffff_ffffn) ^
                            (BigInt(mintBytes[0]) << 56n) ^
                            (BigInt(mintBytes[31]) << 32n);
                        const hour1TargetBps = 3000n + (mix64(daySeed) % 3001n);
                        bbWeight = firstHourSliceWeightBps(hour1TargetBps);
                        bbFactor = 10000n;
                    } else {
                        bbWeight = 500n;
                        bbFactor = 5000n + (bbX % 10001n);
                    }
                    const estSlice = (bbSpendable * bbWeight * bbFactor) / 100_000_000n;
                    const estSliceCapped = estSlice > bbSpendable ? bbSpendable : estSlice;
                    const pacingLeft =
                        bn(ammState.bbLastSlot) > 0n &&
                        slotNow - bn(ammState.bbLastSlot) < BigInt(PACE_SLOTS)
                            ? Number(BigInt(PACE_SLOTS) - (slotNow - bn(ammState.bbLastSlot)))
                            : 0;
                    console.log(
                        `${evc(ANSI.blue, "dex_buyback")}budget=${fmtUsdc(bbBudget)} spent=${fmtUsdc(bbSpent)} ` +
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
                            `${skip(`dex_buyback skipped (${reason(bbSim.value.err, bbReasons)})`)}` +
                            `spendable=${fmtUsdc(bbSpendable)} (${pctOf(bbSpendable, bbVault)} of vault)`
                        );
                        console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, bbSim.value.logs?.slice(-4) ?? []);
                    } else {
                        const bbSig = await connection.sendTransaction(bbTx);
                        await connection.confirmTransaction(bbSig, "confirmed");
                        const after = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const spentDelta = bn(after.bbSpentUsdc) - bbSpent;
                        const bbVaultAfter = (await tokenAmount(ammState.usdcVault)) ?? 0n;
                        const bbAfhoAfter = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                        console.log(
                            `${ev(ANSI.blue, "dex_buyback slice fired")} +${fmtUsdc(spentDelta)} ` +
                            `(${pctOf(spentDelta, bbVault)} of vault, ${pctOf(bn(after.bbSpentUsdc), bn(after.bbBudgetUsdc))} of budget) ` +
                            `+${fmtAfho(bbAfhoAfter - bbAfhoBefore)} → vault now=${fmtUsdc(bbVaultAfter)} — ${bbSig}`
                        );
                    }
                }
            } catch (e) {
                // Never let a buyback attempt kill the crank loop
                console.error(`${evc(ANSI.red, "!! dex_buyback attempt failed")}${(e as Error).message}`);
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
                    `${evc(ANSI.yellow, "buy_the_dip")}reserve=${fmtUsdc(dipReserve)} dayBudget=${fmtUsdc(bn(ammState.dipDayUsdc))} ` +
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
                        `${skip(`buy_the_dip skipped (${reason(dipSim.value.err, dipReasons)})`)}` +
                        `reserve=${fmtUsdc(dipReserve)} est slice=${fmtUsdc(dipEstSlice)}`
                    );
                    console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, dipSim.value.logs?.slice(-4) ?? []);
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
                            `${ev(ANSI.yellow, "buy_the_dip slice FIRED")} +${fmtUsdc(spentDelta)} ` +
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
                        console.log(`${skip(`buy_the_dip no-op (${noopWhy})`)} — ${dipSig}`);
                    }
                }
            } catch (e) {
                // Never let a dip attempt kill the crank loop
                console.error(`${evc(ANSI.red, "!! buy_the_dip attempt failed")}${(e as Error).message}`);
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
                    // Bounty sizing mirrors the on-chain math (bounty_top_up):
                    // refill by TOPUP_PAYMENTS × bounty_usd when the vault's
                    // USDC value (at the pinned pool's SOL price) is at/below
                    // LOW_WATER_PAYMENTS × bounty_usd. bounty_usd_raw is u64 LE
                    // at offset 48..56 of the crank's BountyConfig.
                    const LOW_WATER_PAYMENTS = 10n;
                    const TOPUP_PAYMENTS = 10n;
                    const cfgInfo = await connection.getAccountInfo(bountyConfigPda);
                    const bountyUsd = cfgInfo && cfgInfo.data.length >= 56
                        ? cfgInfo.data.readBigUInt64LE(48)
                        : 0n;
                    const vaultUsdc = solPrice > 0n ? (bountyBal * solPrice) / 1_000_000_000_000n : 0n;
                    const payments = bountyUsd > 0n ? vaultUsdc / bountyUsd : 0n;
                    const neededLamports = solPrice > 0n ? (TOPUP_PAYMENTS * bountyUsd * 1_000_000_000_000n) / solPrice : 0n;
                    const usdcNeeded = solPrice > 0n ? (neededLamports * solPrice * 10_025n) / 1_000_000_000_000n / 10_000n : 0n;
                    const afhoIn = afhoPrice > 0n ? (usdcNeeded * 1_000_000_000_000n * 10_025n) / afhoPrice / 10_000n : 0n;
                    console.log(
                        `${evc(ANSI.brightBlue, "bounty_top_up")}bounty=${fmtSolL(bountyBal)} ≈${payments} payments (${fmtUsdc(vaultUsdc)}) ` +
                        `afho_price=${afhoPrice > 0n ? fmtPrice(afhoPrice) : "—"} sol_price=${solPrice > 0n ? fmtPrice(solPrice) : "—"} ` +
                        `→ refill +${TOPUP_PAYMENTS} payments (${fmtUsdc(usdcNeeded)}) when ≤${LOW_WATER_PAYMENTS} ` +
                        `est AFHO sold=${fmtAfho(afhoIn)} (${pctOf(afhoIn, afhoVaultBal)} of afho_vault)`
                    );
                    const topupIx = await ammProgram.methods
                        .bountyTopUp()
                        .accountsStrict({
                            cranker: keypair.publicKey,
                            ammState: ammStatePda,
                            bountyVault: bountyVaultPda,
                            bountyConfig: bountyConfigPda,
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
                            `${skip(`bounty_top_up skipped (${reason(topupSim.value.err, topupReasons)})`)}` +
                            `bounty=${fmtSolL(bountyBal)} est AFHO=${fmtAfho(afhoIn)} (${pctOf(afhoIn, afhoVaultBal)} of afho_vault)`
                        );
                        console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, topupSim.value.logs?.slice(-4) ?? []);
                    } else if (bountyUsd > 0n && vaultUsdc > LOW_WATER_PAYMENTS * bountyUsd) {
                        // Simulation passed because the on-chain low-water check
                        // no-ops — don't spend a tx on a healthy vault.
                        console.log(`${skip(`bounty_top_up no-op (vault healthy: ${payments} payments > ${LOW_WATER_PAYMENTS} low water)`)}`);
                    } else {
                        const topupSig = await connection.sendTransaction(topupTx);
                        await connection.confirmTransaction(topupSig, "confirmed");
                        const bountyAfter = BigInt(await connection.getBalance(bountyVaultPda));
                        console.log(
                            `${ev(ANSI.brightBlue, "bounty_top_up fired")} bounty ${fmtSolL(bountyBal)} → ${fmtSolL(bountyAfter)} ` +
                            `(+${fmtSolL(bountyAfter - bountyBal)} SOL, sold ≈${fmtAfho(afhoIn)} AFHO = ${pctOf(afhoIn, afhoVaultBal)} of afho_vault) — ${topupSig}`
                        );
                    }
                }
            } catch (e) {
                console.error(`${evc(ANSI.red, "!! bounty_top_up attempt failed")}${(e as Error).message}`);
            }
        } catch (e) {
            console.error(`${evc(ANSI.red, "!! Crank attempt failed")}${e}`);
        }

        await sleep(sleepMs);
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

// Mirror of dex_buyback.rs's per-day hour-1 target → per-slice weight
// conversion (first_hour_slice_weight_bps). Est-slice logging only.
function mix64(x: bigint): bigint {
    let h = x & 0xffff_ffff_ffff_ffffn;
    h ^= h >> 29n;
    h = (h * 0xbf58_476d_1ce4_e5b9n) & 0xffff_ffff_ffff_ffffn;
    h ^= h >> 32n;
    return h;
}

function firstHourSliceWeightBps(hour1TargetBps: bigint): bigint {
    // -ln(1-F) scaled by 1e12, F = hour1TargetBps / 10_000.
    const f = hour1TargetBps;
    let term = f * 100_000_000n; // F × 1e12
    let ln = 0n;
    for (let k = 1n; k <= 8n && term > 0n; k += 1n) {
        ln += term / k;
        term = (term * f) / 10_000n;
    }
    return (ln * 10_000n) / (60n * 1_000_000_000_000n);
}

// ── Slot-time assumption watch ─────────────────────────────────────────────
// All on-chain pacing (MIN_SLICE_SLOTS / DIP_MIN_SLICE_SLOTS / SPOT_SAMPLE_SLOTS)
// derives from NOMINAL_SLOT_MS in dex_buyback.rs at compile time; this is the
// keeper-side mirror (PACE_SLOTS). ACTIVE: 200ms (2026-09-09 — baked the
// floor of SIMD-0525's staged 400→200 plan so the program can be finalized
// immediately; see dex_buyback.rs + MAINNET_CHECKLIST.md 2026-09-08 pass).
// While chains run slower than 200ms, pacing runs SLOWER than design
// (400ms-real → 120s/slice), the conservative direction; devnet's ~167ms
// today → ~50s/slice, slightly hot but bounded. This log prints the chain's
// MEASURED slot time (getRecentPerformanceSamples) against the active
// assumption every ~5 min so the transition is visible as it lands.
const NOMINAL_SLOT_MS = 200; // mirrors dex_buyback.rs — 2026-09-09 decision
const PACE_SLOTS = 60_000 / NOMINAL_SLOT_MS; // 300 slots ≈ 60s @ 200ms — mirrors MIN_SLICE_SLOTS
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
                `${skip("slot time")}~${msPerSlot.toFixed(0)}ms/slot measured vs ${NOMINAL_SLOT_MS}ms ` +
                    `assumed for pacing constants (MIN_SLICE = ${PACE_SLOTS} slots ≈ 60s)`
            );
        }
    } catch {
        // informational only — perf samples unavailable on this RPC
    }
}

main();