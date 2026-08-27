import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

// Devnet USDC. MAINNET: swap in the real USDC mint.
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
// $0.50 per crank, +5% per calendar year after the base year.
const BOUNTY_USD_RAW = 500_000n; // 0.50 USDC (6 dp)
const BASE_YEAR = 2026;
const ANNUAL_INFLATION_BPS = 500; // 5%

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );

    const [bountyConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")],
        program.programId
    );
    const [bountyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_vault")],
        program.programId
    );

    console.log("Initializing bounty config...");
    console.log("Config:", bountyConfigPda.toBase58());
    console.log("Vault:", bountyVaultPda.toBase58());

    const solUsdcPool = new PublicKey(deployment.raydiumSolUsdcPool);
    const cpmmProgram = new PublicKey(deployment.raydiumProgram);

    try {
        const tx = await program.methods
            .initializeBounty(
                new anchor.BN(5_000_000), // fallback lamports (0.005 SOL)
                new anchor.BN(BOUNTY_USD_RAW.toString()),
                BASE_YEAR,
                ANNUAL_INFLATION_BPS,
                solUsdcPool,
                cpmmProgram,
                USDC_MINT
            )
            .accounts({
                payer: provider.wallet.publicKey,
                bountyConfig: bountyConfigPda,
                bountyVault: bountyVaultPda,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();
        console.log("✅ Bounty initialized:", tx);
    } catch (e) {
        console.error("Failed (maybe already initialized?):", e);
    }
}

main();
