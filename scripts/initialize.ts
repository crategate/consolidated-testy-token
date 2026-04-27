import * as anchor from "@coral-xyz/anchor";
import * as myIdl from "../target/idl/crank_oracle.json";
import { Keypair, PublicKey } from "@solana/web3.js";
import { myAnchorProgram } from "./utils"; // Reusing the repo's util file
import * as fs from "fs";
import * as path from "path";
async function main() {
    // 1. Load the program using the repo's existing utility
    const connection = new anchor.web3.Connection("https://api.devnet.solana.com");

    const keypairPath = require('os').homedir() + '/.config/solana/id.json';
    const secretKey = Buffer.from(JSON.parse(require('fs').readFileSync(keypairPath, 'utf-8')));
    const wallet = new anchor.Wallet(anchor.web3.Keypair.fromSecretKey(secretKey));

    const crankKeyPath = path.join(process.cwd(), "target", "deploy", "crank_oracle-keypair.json");
    let CRANK_ID: PublicKey;

    if (fs.existsSync(crankKeyPath)) {
        const keyData = JSON.parse(fs.readFileSync(crankKeyPath, "utf-8"));
        const crankKeyPair = Keypair.fromSecretKey(new Uint8Array(keyData));
        CRANK_ID = crankKeyPair.publicKey;
        console.log(`....... loaded crank program ID:::: ${CRANK_ID.toBase58()}`);
    } else {
        throw new Error(" crank keypair file not found, run anchor build first....");
    }

    const provider = new anchor.AnchorProvider(connection, wallet, {});
    anchor.setProvider(provider);
    // const program = await myAnchorProgram(provider, "./target/deploy/basic_oracle_example-keypair.json");
    const program = new anchor.Program(myIdl as anchor.Idl, provider);

    console.log("Program ID:", program.programId.toBase58());


    // 3. Derive your Market Status PDA
    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        program.programId
    );
    console.log("Market Status PDA:", marketStatusPda.toBase58());

    // 4. Build and send the initialization transaction
    try {
        const tx = await program.methods
            .initializeState()
            .accounts({
                marketStatus: marketStatusPda, // Anchor converts your rust snake_case to camelCase
                payer: provider.wallet.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();

        console.log(`Success! State initialized. Tx: ${tx}`);
    } catch (e) {
        console.error("Initialization failed (It might already be initialized):", e);
    }
}

main().catch(console.error);

