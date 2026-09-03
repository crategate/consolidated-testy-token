// Posts a realistic, claimable three-tier offer sheet into the offer desk so
// the web UI and offer_claim can be exercised on devnet without waiting for a
// real end-of-day make_offers run.
//
// Unlike amm-test-data (load_test_data), this stamps offer_list.day_index with
// the CURRENT market-status trading day, so the sheet is claimable tonight —
// exactly like a sheet produced by make_offers. The ratchet floor is anchored
// to the LIVE pool price (pinned CPMM TWAP with vault-ratio fallback) at 80%
// of live, so every seeded discount executes in full.
//
// DEVNET ONLY. Run after amm-init + set-cpmm-pool (the pool pin is REQUIRED —
// load_offers prices off the pinned pool; there is no mock oracle).
//
// Usage: npx ts-node ./scripts/amm-offers.ts   (or: anchor run amm-offers)

import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

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

    // Pricing is pool-only: load_offers reads the pinned CPMM pool's price.
    const ammStatePda = new PublicKey(deployment.ammState);
    const marketStatus = new PublicKey(deployment.marketStatus);

    // The AFHO/USDC CPMM pool MUST be pinned — load_offers prices off it
    // (TWAP with vault-ratio fallback); there is no mock oracle anymore.
    const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
    const pinned = !ammState.cpmmPoolState.equals(PublicKey.default);
    if (!pinned) {
        throw new Error(
            "CPMM pool not pinned in AmmState — run 'anchor run set-cpmm-pool' first."
        );
    }

    const accounts: Record<string, PublicKey> = {
        authority: provider.wallet.publicKey,
        ammState: ammStatePda,
        offerList: pda("offer_list"),
        marketStatus,
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
    }

    // One-time offer_list resize (devnet-big u8→u32 count widening): the
    // zero-copy account grew 80 → 104 bytes; resize a pre-widening account in
    // place first (idempotent no-op once current).
    const migrateSig = await ammProgram.methods
        .migrateOfferList()
        .accountsStrict({
            authority: provider.wallet.publicKey,
            ammState: ammStatePda,
            offerList: pda("offer_list"),
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    console.log(" offer_list migrated/resized if needed:", migrateSig);

    const sig = await ammProgram.methods.loadOffers().accounts(accounts).rpc();

    console.log(" Offer sheet loaded:", sig);
    console.log("   big 3 lots @ tier 19 (1M AFHO) · 9.0% off · 18-day vest");
    console.log("   med 5 lots @ tier 16 (100k AFHO) · 7.5% off ·  9-day vest");
    console.log("   sml 10 lots @ tier 13 ( 15k AFHO) · 6.0% off ·  5-day vest");
    console.log("   day_index stamped to today → claimable tonight via offer_claim");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
