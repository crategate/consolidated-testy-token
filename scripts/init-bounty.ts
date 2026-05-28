import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);

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

    try {
        const tx = await program.methods
            .initializeBounty(new anchor.BN(5000000)) // 0.005 SOL per crank
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
