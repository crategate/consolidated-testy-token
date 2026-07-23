import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";  // Anchor re-exports BN
import * as sb from "@switchboard-xyz/on-demand";
import { OracleQuote } from '@switchboard-xyz/on-demand';
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
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
    const priceFeedId = deployment.priceFeedId;
    // Order pinned with feed-deploy: [0] = market status, [1] = price change
    const feedIds = priceFeedId ? [statusFeedId, priceFeedId] : [statusFeedId];
    const [quoteAccount] = OracleQuote.getCanonicalPubkey(queue.pubkey, feedIds);
    // Single-feed quote used when the price feed can't resolve yet (devnet / pre-indexing)
    const [statusQuoteAccount] = OracleQuote.getCanonicalPubkey(queue.pubkey, [statusFeedId]);

    console.log("🔍 Keeper started");
    console.log("Program ID:", programId.toBase58());
    console.log("Market Status:", marketStatusPda.toBase58());
    console.log("Bounty Config:", bountyConfigPda.toBase58());
    console.log("Bounty Vault:", bountyVaultPda.toBase58());

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
            // Prefer the combined [status, price] quote; fall back to the status-only one
            let activeQuote = quoteAccount;
            let quoteAccountInfo = await connection.getAccountInfo(quoteAccount);
            if (!quoteAccountInfo && feedIds.length > 1) {
                activeQuote = statusQuoteAccount;
                quoteAccountInfo = await connection.getAccountInfo(statusQuoteAccount);
            }

            if (!quoteAccountInfo) {
                console.log("Quote account not found, sleeping...");
                await sleep(sleepMs);
                continue;
            }

            // Switchboard quote layout: discriminator(8) + queue(32) + slot(8) ...
            const quoteSlot = new BN(quoteAccountInfo.data.readBigUInt64LE(40).toString());

            if (quoteSlot.gt(bountyConfig.lastCrankSlot)) {
                console.log(`🚀 Stale crank! Oracle slot ${quoteSlot} > last ${bountyConfig.lastCrankSlot}`);

                const overrides = {
                    MASSIVE_API_KEY: process.env.MASSIVE_API_KEY!,
                    EARNINGSAPI_KEY: process.env.EARNINGSAPI_KEY!,
                    JUP_API_KEY: process.env.JUP_API_KEY!,
                };
                let ixs;
                let crankQuote = activeQuote;
                try {
                    ixs = await queue.fetchManagedUpdateIxs(crossbar, feedIds, {
                        variableOverrides: overrides,
                        payer: keypair.publicKey,
                    });
                    crankQuote = quoteAccount;
                } catch (e) {
                    // Price feed won't resolve until Jupiter indexes the mint (always on devnet).
                    // Fall back to status-only so the market status crank never stalls.
                    if (feedIds.length < 2) throw e;
                    console.warn("⚠️ Combined update failed, falling back to status-only:", (e as Error).message);
                    ixs = await queue.fetchManagedUpdateIxs(crossbar, [statusFeedId], {
                        variableOverrides: overrides,
                        payer: keypair.publicKey,
                    });
                    crankQuote = statusQuoteAccount;
                }

                const crankIx = await program.methods.permissionlessCrank().accountsStrict({
                    cranker: keypair.publicKey,
                    bountyConfig: bountyConfigPda,
                    bountyVault: bountyVaultPda,
                    quoteAccount: crankQuote,
                    clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
                    marketStatus: marketStatusPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                }).instruction();

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

                const sig = await connection.sendTransaction(tx);
                await connection.confirmTransaction(sig, "confirmed");
                console.log(`✅ Cranked! ${sig}`);
            } else {
                console.log("Oracle fresh, nothing to do.");
            }
        } catch (e) {
            console.error("❌ Crank attempt failed:", e);
        }

        await sleep(sleepMs);
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

main();
