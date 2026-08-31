// Posts a realistic, claimable three-tier offer sheet into the offer desk so
// the web UI and offer_claim can be exercised on devnet without waiting for a
// real end-of-day make_offers run.
//
// Unlike amm-test-data (load_test_data), this stamps offer_list.day_index with
// the CURRENT market-status trading day, so the sheet is claimable tonight —
// exactly like a sheet produced by make_offers. The ratchet floor is anchored
// to the LIVE devnet pool price (CPMM when pinned, mock spot oracle otherwise)
// at 80% of live, so every seeded discount executes in full.
//
// DEVNET ONLY. Run after amm-init + set-cpmm-pool (pool pinning is optional;
// the instruction falls back to the mock spot oracle when unpinned).
//
// Usage: npx ts-node ./scripts/amm-offers.ts   (or: anchor run amm-offers)

import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair } from "@solana/web3.js";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const ammIdl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8")
    );
    const ammProgram = new anchor.Program(ammIdl as anchor.Idl, provider);

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const mint = new PublicKey(deployment.mint);
    // MAINNET: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
    const usdcMint = new PublicKey(
        process.env.DEVNET_USDC_MINT || "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"
    );

    const pda = (seed: string) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from(seed), mint.toBuffer()],
            ammProgram.programId
        )[0];

    // Spot oracle = the mock-dex-pool's raw-u64 `mock_price` PDA (fallback
    // price source when the CPMM pool isn't pinned).
    const dexKeypairPath = path.join(process.cwd(), "target", "deploy", "mock_dex_pool-keypair.json");
    if (!fs.existsSync(dexKeypairPath)) {
        throw new Error("mock_dex_pool-keypair.json not found. Run 'anchor build' first.");
    }
    const mockDexProgram = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(dexKeypairPath, "utf-8")))
    ).publicKey;
    const [spotOracle] = PublicKey.findProgramAddressSync(
        [Buffer.from("mock_price"), mint.toBuffer()],
        mockDexProgram
    );

    const ammStatePda = new PublicKey(deployment.ammState);
    const marketStatus = new PublicKey(deployment.marketStatus);

    // Is the AFHO/USDC CPMM pool pinned? If so, pass its four pricing PDAs so
    // load_offers reads the LIVE pool price (TWAP with vault-ratio fallback).
    const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
    const pinned = !ammState.cpmmPoolState.equals(PublicKey.default);

    const accounts: Record<string, PublicKey> = {
        authority: provider.wallet.publicKey,
        ammState: ammStatePda,
        offerList: pda("offer_list"),
        marketStatus,
        spotOracle,
    };

    if (pinned) {
        const cpmmProgram = new PublicKey(deployment.raydiumProgram);
        const poolState = new PublicKey(deployment.raydiumPool);
        accounts.cpmmPoolState = poolState;
        accounts.cpmmObservation = PublicKey.findProgramAddressSync(
            [Buffer.from("observation"), poolState.toBuffer()],
            cpmmProgram
        )[0];
        // Quote leg (USDC) = "input"; base leg (AFHO) = "output".
        accounts.cpmmInputVault = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), poolState.toBuffer(), usdcMint.toBuffer()],
            cpmmProgram
        )[0];
        accounts.cpmmOutputVault = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), poolState.toBuffer(), mint.toBuffer()],
            cpmmProgram
        )[0];
        console.log("   pinned CPMM pool:", poolState.toBase58(), "(live price source)");
    } else {
        console.log("   pool not pinned — using mock spot oracle as the price source");
    }

    const sig = await ammProgram.methods.loadOffers().accounts(accounts).rpc();

    console.log(" Offer sheet loaded:", sig);
    console.log("   big 3 lots @ tier 6 (500 AFHO) · 9.0% off · 18-day vest");
    console.log("   med 5 lots @ tier 4 (100 AFHO) · 7.5% off ·  9-day vest");
    console.log("   sml 10 lots @ tier 2 ( 25 AFHO) · 6.0% off ·  5-day vest");
    console.log("   day_index stamped to today → claimable tonight via offer_claim");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
