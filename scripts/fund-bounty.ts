import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idl = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), "target", "idl", "crank_oracle.json"), "utf-8"));
    const program = new anchor.Program(idl, provider);

    const [bountyConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")], program.programId);
    const [bountyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_vault")], program.programId);

    // 0.5 SOL = ~100 cranks at 0.005 SOL each
    const amount = new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL);

    const tx = await program.methods
        .fundBounty(amount)
        .accounts({
            payer: provider.wallet.publicKey,
            bountyConfig: bountyConfigPda,
            bountyVault: bountyVaultPda,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    console.log("✅ Bounty vault funded:", tx);
}

main();
