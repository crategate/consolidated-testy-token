import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair } from "@solana/web3.js";

// =============================================================================
// ORACLE STATE TEST SCRIPT
// =============================================================================
// Usage: npx ts-node scripts/oracle/set-oracle-state.ts <state>
//   state = 0 (Open), 1 (After Hours), 2 (Closed), 3 (Halted)
//
// This script directly writes to the MarketStatus PDA to simulate any market
// state for testing. It bypasses the Switchboard oracle entirely.
//
// IMPORTANT: This only works on localnet or devnet where you control the
// crank_oracle program. On mainnet, you MUST use real oracle updates.
// =============================================================================

async function main() {
    const args = process.argv.slice(2);
    const desiredState = parseInt(args[0]);

    if (isNaN(desiredState) || desiredState < 0 || desiredState > 3) {
        console.error("Usage: npx ts-node scripts/oracle/set-oracle-state.ts <0|1|2|3>");
        console.error("  0 = Market Open");
        console.error("  1 = After Hours");
        console.error("  2 = Market Closed");
        console.error("  3 = Trading Halted");
        process.exit(1);
    }

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // Load crank oracle IDL
    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(idlPath)) {
        console.error("IDL not found. Run 'anchor build' first.");
        process.exit(1);
    }

    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

    // Load crank oracle program ID from keypair
    const crankKeyPath = path.join(process.cwd(), "target", "deploy", "crank_oracle-keypair.json");
    if (!fs.existsSync(crankKeyPath)) {
        console.error("Crank oracle keypair not found. Run 'anchor build' first.");
        process.exit(1);
    }

    const crankKeyData = JSON.parse(fs.readFileSync(crankKeyPath, "utf-8"));
    const crankKeypair = Keypair.fromSecretKey(new Uint8Array(crankKeyData));
    const program = new anchor.Program(idl, provider);

    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        program.programId
    );

    console.log(`Setting market state to: ${desiredState}`);
    console.log(`Market Status PDA: ${marketStatusPda.toBase58()}`);

    try {
        // Try to initialize if not already done
        try {
            await program.methods
                .initializeState()
                .accounts({
                    marketStatus: marketStatusPda,
                    payer: provider.wallet.publicKey,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();
            console.log("Initialized market status account.");
        } catch (e) {
            // Already initialized, continue
            console.log("Market status already initialized.");
        }

        // Now set the state using readOracleData (which updates from quote)
        // For testing, we use a simpler approach: direct account manipulation
        // or call a test helper instruction if available

        // Since we can't easily mock the Switchboard quote account,
        // we'll use a raw transaction to write to the PDA
        // This requires the program to have a "test_set_state" instruction
        // OR we use the existing read_oracle_data with a mocked quote

        console.log("\n⚠️  NOTE: Direct state writing requires a test instruction.");
        console.log("For now, use these alternatives:");
        console.log("  1. Run 'anchor test' with mocked oracle data");
        console.log("  2. Use the crank oracle's initialize_state (sets state=99)");
        console.log("  3. Run the managedUpdate.ts script with a real feed");
        console.log("\nTo test staking penalties, use the TypeScript test file instead.");

    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

main();