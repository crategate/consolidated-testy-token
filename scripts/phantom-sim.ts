// scripts/phantom-simulate.ts
import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import {
    getAssociatedTokenAddressSync,
    createTransferCheckedInstruction,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

async function main() {
    const connection = new Connection("https://api.devnet.solana.com");
    const mint = new PublicKey("4qd8TmWQjR6QVQtXCZjxgS3zcmQYzH2xyBPeYfjtCnwD");
    // Load the extra account meta list to see what accounts Phantom should be adding
    const coinMintId = new PublicKey("8kNySBN4Zjd8jnWgrE5LcafLNTT16Lhgwhna1tqyn8we");
    const [extraMetaPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("extra-account-metas"), mint.toBuffer()],
        coinMintId
    );

    // A dummy sender — replace with your actual wallet
    const sender = new PublicKey("E9GJV64nrAKH9e9qacDjss8xfBPAt7nQbMs8rw884x6H");
    const recipient = new PublicKey("BfoXCRozoZob4L4URqnd4PL16afLn931Rr93ZvUZPZKN");

    const senderATA = getAssociatedTokenAddressSync(mint, sender, false, TOKEN_2022_PROGRAM_ID);
    const recipientATA = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);

    // Build the base transfer instruction (this is what Phantom builds)
    const ix = createTransferCheckedInstruction(
        senderATA,
        mint,
        recipientATA,
        sender, // owner
        1_000_000_000, // 1 token
        9,
        [],
        TOKEN_2022_PROGRAM_ID
    );

    const tx = new Transaction().add(ix);
    tx.feePayer = sender;

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    // Simulate WITHOUT the hook accounts — this mimics what Phantom does if its
    // transfer-hook resolution is broken or if the extra account meta list is corrupt
    const sim = await connection.simulateTransaction(tx);
    console.log("=== Simulation (no hook accounts) ===");
    console.log("Error:", JSON.stringify(sim.value.err, null, 2));
    console.log("Logs:\n", sim.value.logs?.join("\n"));
}
main()
