[1mdiff --git a/scripts/oracle/mev-keeper.ts b/scripts/oracle/mev-keeper.ts[m
[1mindex 655dc49..c59c5ee 100644[m
[1m--- a/scripts/oracle/mev-keeper.ts[m
[1m+++ b/scripts/oracle/mev-keeper.ts[m
[36m@@ -157,6 +157,54 @@[m [masync function main() {[m
     console.log("Bounty Config:", bountyConfigPda.toBase58());[m
     console.log("Bounty Vault:", bountyVaultPda.toBase58());[m
 [m
[32m+[m[32m    // ── TEST-STATE MODE (devnet/localnet only) ─────────────────────────────[m
[32m+[m[32m    // `--test-state` drives the market-status PDA through a scripted state[m
[32m+[m[32m    // cycle via crank test_set_state INSTEAD of cranking the real Switchboard[m
[32m+[m[32m    // feed, then runs the exact same transition sequences (end-of-day stats +[m
[32m+[m[32m    // make_offers, start-of-day calc_completed_offers, dex_buyback slices,[m
[32m+[m[32m    // buy_the_dip, bounty_top_up) as the real keeper loop. For exercising the[m
[32m+[m[32m    // offer desk without waiting for NYSE hours.[m
[32m+[m[32m    //   --test-day <n>          start trading-day index (default: on-chain)[m
[32m+[m[32m    //   --test-interval-ms <n>  ms per scripted state (default: 15000)[m
[32m+[m[32m    //   TEST_STATE_SEQUENCE     env override, e.g. "0,1,2,0" (default cycle)[m
[32m+[m[32m    // DEVNET/TEST ONLY — remove before mainnet together with crank[m
[32m+[m[32m    // test_set_state and scripts/oracle/set-oracle-state.ts.[m
[32m+[m[32m    const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";[m
[32m+[m[32m    const TEST_STATE = process.argv.includes("--test-state");[m
[32m+[m[32m    const testDayArg = process.argv.indexOf("--test-day");[m
[32m+[m[32m    const TEST_DAY = testDayArg !== -1 ? parseInt(process.argv[testDayArg + 1], 10) : null;[m
[32m+[m[32m    const testIntervalArg = process.argv.indexOf("--test-interval-ms");[m
[32m+[m[32m    const TEST_INTERVAL_MS =[m
[32m+[m[32m        testIntervalArg !== -1 ? parseInt(process.argv[testIntervalArg + 1], 10) : 15_000;[m
[32m+[m[32m    const TEST_SEQUENCE = (process.env.TEST_STATE_SEQUENCE ?? "0,1,2,0")[m
[32m+[m[32m        .split(",")[m
[32m+[m[32m        .map((s) => parseInt(s.trim(), 10));[m
[32m+[m[32m    let testCursor = 0;[m
[32m+[m[32m    let testDay: number | null = TEST_DAY;[m
[32m+[m
[32m+[m[32m    if (TEST_STATE) {[m
[32m+[m[32m        const endpoint = connection.rpcEndpoint;[m
[32m+[m[32m        const genesisHash = await connection.getGenesisHash();[m
[32m+[m[32m        const host = (() => {[m
[32m+[m[32m            try {[m
[32m+[m[32m                return new URL(endpoint).hostname;[m
[32m+[m[32m            } catch {[m
[32m+[m[32m                return "";[m
[32m+[m[32m            }[m
[32m+[m[32m        })();[m
[32m+[m[32m        const isLocalnet = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);[m
[32m+[m[32m        if (!isLocalnet && genesisHash !== DEVNET_GENESIS_HASH) {[m
[32m+[m[32m            throw new Error([m
[32m+[m[32m                `REFUSING: --test-state is a DEVNET/LOCALNET test mode ` +[m
[32m+[m[32m                    `(endpoint ${endpoint}, genesis ${genesisHash.slice(0, 8)}…). ` +[m
[32m+[m[32m                    `Run the real keeper without --test-state.`[m
[32m+[m[32m            );[m
[32m+[m[32m        }[m
[32m+[m[32m        console.log([m
[32m+[m[32m            ` TEST-STATE MODE: cycle ${TEST_SEQUENCE.join(" → ")} every ${TEST_INTERVAL_MS}ms`[m
[32m+[m[32m        );[m
[32m+[m[32m    }[m
[32m+[m
     function getSleepDuration(): number {[m
         const now = new Date();[m
         const etHour = now.getUTCHours() - (now.getTimezoneOffset() === 240 ? 4 : 5);[m
[36m@@ -174,23 +222,68 @@[m [masync function main() {[m
     }[m
 [m
     while (true) {[m
[31m-        const sleepMs = getSleepDuration();[m
[32m+[m[32m        const sleepMs = TEST_STATE ? TEST_INTERVAL_MS : getSleepDuration();[m
         try {[m
             const marketStatus = await program.account.marketStatus.fetch(marketStatusPda);[m
             const bountyConfig = await program.account.bountyConfig.fetch(bountyConfigPda);[m
[31m-            let quoteAccountInfo = await connection.getAccountInfo(quoteAccount);[m
[32m+[m[32m            let quoteAccountInfo: any = null;[m
[32m+[m[32m            if (!TEST_STATE) {[m
[32m+[m[32m                quoteAccountInfo = await connection.getAccountInfo(quoteAccount);[m
 [m
[31m-            if (!quoteAccountInfo) {[m
[31m-                console.log("Quote account not found, sleeping...");[m
[31m-                await sleep(sleepMs);[m
[31m-                continue;[m
[32m+[m[32m                if (!quoteAccountInfo) {[m
[32m+[m[32m                    console.log("Quote account not found, sleeping...");[m
[32m+[m[32m                    await sleep(sleepMs);[m
[32m+[m[32m                    continue;[m
[32m+[m[32m                }[m
             }[m
 [m
             // Switchboard quote layout: discriminator(8) + queue(32) + slot(8) ...[m
[31m-            const quoteSlot = new BN(quoteAccountInfo.data.readBigUInt64LE(40).toString());[m
[31m-[m
[31m-            if (quoteSlot.gt(bountyConfig.lastCrankSlot)) {[m
[31m-                console.log(` Stale crank! Oracle slot ${quoteSlot} > last ${bountyConfig.lastCrankSlot}`);[m
[32m+[m[32m            const quoteSlot = quoteAccountInfo[m
[32m+[m[32m                ? new BN(quoteAccountInfo.data.readBigUInt64LE(40).toString())[m
[32m+[m[32m                : new BN(0);[m
[32m+[m
[32m+[m[32m            if (TEST_STATE || quoteSlot.gt(bountyConfig.lastCrankSlot)) {[m
[32m+[m[32m                if (TEST_STATE) {[m
[32m+[m[32m                    // Scripted fake crank: advance the test cycle via crank[m
[32m+[m[32m                    // test_set_state (devnet-only) instead of the Switchboard[m
[32m+[m[32m                    // managed update. The transition handlers below (end of[m
[32m+[m[32m                    // day / start of day) run identically to the real path.[m
[32m+[m[32m                    if (testDay === null) testDay = marketStatus.tradingDayIndex.toNumber();[m
[32m+[m[32m                    const state = TEST_SEQUENCE[testCursor % TEST_SEQUENCE.length];[m
[32m+[m[32m                    testCursor++;[m
[32m+[m[32m                    if ([m
[32m+[m[32m                        state === 0 &&[m
[32m+[m[32m                        (marketStatus.currentState === 1 || marketStatus.currentState === 2)[m
[32m+[m[32m                    ) {[m
[32m+[m[32m                        testDay++; // mirror the crank: 1/2 → 0 rolls the day forward[m
[32m+[m[32m                    }[m
[32m+[m[32m                    const ts = Math.floor(Date.now() / 1000);[m
[32m+[m[32m                    const setTx = await sb.asV0Tx({[m
[32m+[m[32m                        connection,[m
[32m+[m[32m                        ixs: [[m
[32m+[m[32m                            await program.methods[m
[32m+[m[32m                                .testSetState(state, new BN(testDay), new BN(ts))[m
[32m+[m[32m                                .accounts({ marketStatus: marketStatusPda })[m
[32m+[m[32m                                .instruction(),[m
[32m+[m[32m                        ],[m
[32m+[m[32m                        signers: [keypair],[m
[32m+[m[32m                        computeUnitPrice: 20_000,[m
[32m+[m[32m                    });[m
[32m+[m[32m                    const setSim = await connection.simulateTransaction(setTx);[m
[32m+[m[32m                    if (setSim.value.err) {[m
[32m+[m[32m                        console.error("test_set_state simulation failed:", setSim.value.err);[m
[32m+[m[32m                        await sleep(sleepMs);[m
[32m+[m[32m                        continue;[m
[32m+[m[32m                    }[m
[32m+[m[32m                    const setSig = await connection.sendTransaction(setTx);[m
[32m+[m[32m                    await connection.confirmTransaction(setSig, "confirmed");[m
[32m+[m[32m                    console.log([m
[32m+[m[32m                        ` TEST crank ${marketStatus.currentState} -> ${state} (day ${testDay}) [${setSig}]`[m
[32m+[m[32m                    );[m
[32m+[m[32m                } else {[m
[32m+[m[32m                    console.log([m
[32m+[m[32m                        ` Stale crank! Oracle slot ${quoteSlot} > last ${bountyConfig.lastCrankSlot}`[m
[32m+[m[32m                    );[m
 [m
                 const overrides = {[m
                     MASSIVE_API_KEY: process.env.MASSIVE_API_KEY!,[m
[36m@@ -252,6 +345,7 @@[m [masync function main() {[m
                 const sig = await connection.sendTransaction(tx);[m
                 await connection.confirmTransaction(sig, "confirmed");[m
                 console.log(` Cranked! ${sig}`);[m
[32m+[m[32m                }[m
 [m
                 // Trading day ends on 0→1 (open→after-hours), 0→2 (open→closed, holiday),[m
                 // or 3→2 (halted→closed). Fire update_tradeday_stats FIRST (it owns all[m
