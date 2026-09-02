// Loads a bullish test scenario into the AMM's metric accounts so make_offers
// can be exercised on devnet without waiting for real history:
//   - price_changes ring: slight daily increases (0.3% -> 2.2% over 20 days)
//   - accepted offers: increasing buy-up trend across all tiers
//   - stake health: steady ~40% participation (trailing + live ratio)
//   - a plausible offer sheet (big/med/sml) so the offer-desk UI has data
//
// DEVNET ONLY. Run after amm-init. Note: load_test_data does NOT set
// offer_list.day_index, so the seeded sheet is only claimable while the
// market-status day matches the sheet's existing day_index — the desk UI
// shows a "sheet hasn't posted" state otherwise.
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
        // ratchet-decay knobs: leave floor/counter untouched
        buybackBasis: new anchor.BN(0),
        untakenDays: 0,
        // u64::MAX = leave the sheet's day_index alone (only calc_completed_offers
        // cares, and only for yesterday's sheet)
        offerDayIndex: new anchor.BN("18446744073709551615"),
        // Plausible tonight's sheet (lot tiers via lot_sizer: 18 = 500k AFHO,
        // 15 = 50k, 12 = 10k — the vault-scaled ladder for a ~750M-token
        // vault; discount_bps in tenths of a percent):
        //   big 3 offered / 2 remaining, tier 18, 11.5% off, 30-day vest
        //   med 5 / 4, tier 15, 9% off, 20-day vest
        //   sml 10 / 8, tier 12, 7.5% off, 10-day vest
        bigOffered: 3, bigRemaining: 2,
        medOffered: 5, medRemaining: 4,
        smlOffered: 10, smlRemaining: 8,
        bigLotTier: 18, bigDiscountBps: 115, bigVestingDays: 30,
        medLotTier: 15, medDiscountBps: 90, medVestingDays: 20,
        smlLotTier: 12, smlDiscountBps: 75, smlVestingDays: 10,
    };

    // One-time offer_list resize (devnet-big u8→u32 count widening): the
    // zero-copy account grew 80 → 104 bytes, and every typed load fails on a
    // pre-widening account — so resize in place first (idempotent no-op once
    // current).
    await ammProgram.methods
        .migrateOfferList()
        .accountsStrict({
            authority: provider.wallet.publicKey,
            ammState: pda("amm_state"),
            offerList: pda("offer_list"),
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    console.log(" offer_list migrated/resized if needed");

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

    console.log(" Test data loaded:", sig);
    console.log("   price_changes: +0.30% -> +2.20% daily over 20 days");
    console.log("   accepted offers rising (big 10→50, med 20→70, sml 30→75)");
    console.log("   stake health steady at 40%");
    console.log("   offer sheet: big 3/2 @500k 11.5% 30d · med 5/4 @50k 9% 20d · sml 10/8 @10k 7.5% 10d");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});