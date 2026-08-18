// Loads a bullish test scenario into the AMM's metric accounts so make_offers
// can be exercised on devnet without waiting for real history:
//   - price_changes ring: slight daily increases (0.3% -> 2.2% over 20 days)
//   - accepted offers: increasing buy-up trend across all tiers
//   - stake health: steady ~40% participation (trailing + live ratio)
//
// DEVNET ONLY. Run after amm-init. Then call make_offers (or let the keeper
// fire it at day end) and inspect the constructed offer sheet.
//
// Usage: npx ts-node ./scripts/amm-test-data.ts   (or: anchor run amm-test-data)

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

    const pda = (seed: string) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from(seed), mint.toBuffer()],
            ammProgram.programId
        )[0];

    // Bullish scenario: gently rising prices, warming offer demand, steady staking
    const scenario = {
        // oldest -> newest, centi-percent: 0.30% rising to 2.20%
        priceChanges: Array.from({ length: 20 }, (_, i) => 30 + i * 10),
        sampleHead: 0, // full ring; next write overwrites the oldest entry
        trailingStakeHealth: [40, 40, 41, 40, 41],
        // 40% of supply staked — matches the steady trailing values
        totalStaked: new anchor.BN(400_000).mul(new anchor.BN(10).pow(new anchor.BN(9))),
        totalSupply: new anchor.BN(1_000_000).mul(new anchor.BN(10).pow(new anchor.BN(9))),
        // increasing buy-up aggression, oldest -> newest
        bigAccepted: [10, 20, 30, 40, 50],
        medAccepted: [20, 35, 50, 60, 70],
        smlAccepted: [30, 45, 55, 65, 75],
        // ratchet-decay knobs: leave floor/counter/offer sheet untouched
        buybackBasis: new anchor.BN(0),
        untakenDays: 0,
        bigOffered: 0, bigRemaining: 0,
        medOffered: 0, medRemaining: 0,
        smlOffered: 0, smlRemaining: 0,
        // offer terms — zeroed alongside the sheet (no claimable offers)
        bigLotTier: 0, bigDiscountBps: 0, bigVestingDays: 0,
        medLotTier: 0, medDiscountBps: 0, medVestingDays: 0,
        smlLotTier: 0, smlDiscountBps: 0, smlVestingDays: 0,
    };

    const sig = await ammProgram.methods
        .loadTestData(scenario)
        .accountsStrict({
            authority: provider.wallet.publicKey,
            ammState: pda("amm_state"),
            metrics: pda("metrics"),
            acceptedOffers: pda("accepted_offers"),
            offerList: pda("offer_list"),
        })
        .rpc();

    console.log("✅ Test data loaded:", sig);
    console.log("   price_changes: +0.30% -> +2.20% daily over 20 days");
    console.log("   accepted offers rising (big 10→50, med 20→70, sml 30→75)");
    console.log("   stake health steady at 40%");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});