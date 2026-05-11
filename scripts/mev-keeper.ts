import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";  // Anchor re-exports BN
import * as sb from "@switchboard-xyz/on-demand";
import { OracleQuote } from '@switchboard-xyz/on-demand';
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import type { CrankOracle } from "../target/types/crank_oracle";

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
    const [quoteAccount] = OracleQuote.getCanonicalPubkey(queue.pubkey, [process.env.FEED_ID!]);

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
            const quoteAccountInfo = await connection.getAccountInfo(quoteAccount);

            if (!quoteAccountInfo) {
                console.log("Quote account not found, sleeping...");
                await sleep(sleepMs);
                continue;
            }

            // Switchboard quote layout: discriminator(8) + queue(32) + slot(8) ...
            const quoteSlot = new BN(quoteAccountInfo.data.readBigUInt64LE(40).toString());

            if (quoteSlot.gt(bountyConfig.lastCrankSlot)) {
                console.log(`🚀 Stale crank! Oracle slot ${quoteSlot} > last ${bountyConfig.lastCrankSlot}`);

                const ixs = await queue.fetchManagedUpdateIxs(crossbar, [process.env.FEED_ID!], {
                    payer: keypair.publicKey,
                });

                const crankIx = await program.methods.permissionlessCrank().accountsStrict({
                    cranker: keypair.publicKey,
                    bountyConfig: bountyConfigPda,
                    bountyVault: bountyVaultPda,
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

                const sim = await connection.simulateTransaction(tx);
                if (sim.value.err) {
                    console.error("Simulation failed:", sim.value.err);
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
