import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import * as fs from "fs";
import { OracleQuote } from '@switchboard-xyz/on-demand';
import * as dotenv from "dotenv";
dotenv.config();

const SLEEP_MS = 60_000; // 1 minute during market hours

async function main() {
    const { connection, keypair, queue, crossbar } = await sb.AnchorUtils.loadEnv();
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {});
    const program = new anchor.Program(
        JSON.parse(fs.readFileSync("./target/idl/nyseh_crank.json", "utf-8")),
        provider
    );

    const [marketStatusPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")], program.programId
    );
    const [bountyConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")], program.programId
    );
    const [quoteAccount] = OracleQuote.getCanonicalPubkey(queue.pubkey, [process.env.FEED_ID!]);

    console.log("🔍 Keeper started. Watching for stale oracle...");
    function getSleepDuration(): number {
        const now = new Date();
        const etHour = now.getUTCHours() - (now.getTimezoneOffset() === 240 ? 4 : 5); // Rough ET

        // Simplified: use actual ET conversion in production
        if ((etHour >= 9 && etHour < 10) || (etHour >= 15 && etHour < 16)) {
            return 60_000; // 1 min around open/close
        }
        if (etHour >= 10 && etHour < 15) {
            return 300_000; // 5 min during regular hours
        }
        if (etHour >= 4 && etHour < 20) {
            return 900_000; // 15 min pre/after market
        }
        return 3_600_000; // 1 hour overnight
    }

    while (true) {
        const sleepMs = getSleepDuration();
        try {
            // 1. Read on-chain state
            const marketStatus = await program.account.marketStatus.fetch(marketStatusPda);
            const bountyConfig = await program.account.bountyConfig.fetch(bountyConfigPda);
            const quoteAccountInfo = await connection.getAccountInfo(quoteAccount);

            // 2. Deserialize quote slot from account data (Switchboard layout)
            // Discriminator (8) + queue (32) + slot (8) ...
            const quoteSlot = quoteAccountInfo?.data.readBigUInt64LE(40);

            if (!quoteSlot) {
                console.log("Quote account not found, sleeping...");
                await sleep(SLEEP_MS);
                continue;
            }

            // 3. If oracle is fresher than our last crank, fire
            if (Number(quoteSlot) > bountyConfig.lastCrankSlot) {
                console.log(`🚀 Stale crank detected! Oracle slot ${quoteSlot} > last ${bountyConfig.lastCrankSlot}`);

                const ixs = await queue.fetchManagedUpdateIxs(crossbar, [process.env.FEED_ID!], {
                    payer: keypair.publicKey,
                });

                const crankIx = await program.methods.permissionlessCrank().accounts({
                    cranker: keypair.publicKey,
                    bountyConfig: bountyConfigPda,
                    bountyVault: /* PDA */,
                    quoteAccount: quoteAccount,
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

                const sig = await connection.sendTransaction(tx);
                console.log(`✅ Cranked! ${sig}`);
            } else {
                console.log("Oracle fresh, nothing to do.");
            }
        } catch (e) {
            console.error("❌ Crank attempt failed:", e);
        }

        await sleep(SLEEP_MS);
        await sleep(sleepMs);
    }
    await sleep(SLEEP_MS);
}


function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

main();
