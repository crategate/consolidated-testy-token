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
import { PublicKey, Keypair } from "@solana/web3.js";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

async function main() {    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const ammIdl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8")
    );
    const ammProgram = new anchor.Program(ammIdl as anchor.Idl, provider);

    // Mock-dex-pool program (devnet stub) — needed to re-seed the raw-u64
    // mock_price PDAs that the unpinned-pool price fallbacks read.
    const dexKeypairPath = path.join(process.cwd(), "target", "deploy", "mock_dex_pool-keypair.json");
    if (!fs.existsSync(dexKeypairPath)) {
        throw new Error("mock_dex_pool-keypair.json not found. Run 'anchor build' first.");
    }
    const mockDexProgramId = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(dexKeypairPath, "utf-8")))
    ).publicKey;
    const mockDexIdl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "mock_dex_pool.json"), "utf-8")
    );
    const mockDexProgram = new anchor.Program(mockDexIdl as anchor.Idl, provider);

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
        // Plausible tonight's sheet (lot tiers via lot_sizer: 19 = 1M AFHO,
        // 16 = 100k, 13 = 15k — the vault-scaled ladder for a ~750M-token
        // vault; discount_bps in tenths of a percent):
        //   big 3 offered / 2 remaining, tier 19, 11.5% off, 30-day vest
        //   med 5 / 4, tier 16, 9% off, 20-day vest
        //   sml 10 / 8, tier 13, 7.5% off, 10-day vest
        bigOffered: 3, bigRemaining: 2,
        medOffered: 5, medRemaining: 4,
        smlOffered: 10, smlRemaining: 8,
        bigLotTier: 19, bigDiscountBps: 115, bigVestingDays: 30,
        medLotTier: 16, medDiscountBps: 90, medVestingDays: 20,
        smlLotTier: 13, smlDiscountBps: 75, smlVestingDays: 10,
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
    console.log("   offer sheet: big 3/2 @1M 11.5% 30d · med 5/4 @100k 9% 20d · sml 10/8 @15k 7.5% 10d");

    // ── Mock price re-seed (devnet fallback oracles, e9 floor units) ─────
    // The unpinned-pool price fallbacks read these raw-u64 PDAs as
    // price-per-unit × 1e9 (nano-USD). The wSOL mock was last seeded at
    // 200_000 (the pre-e9 milli-USD scale for 200 USDC/SOL), which made the
    // SOL price read 1000× small and the offer-desk SOL quote 1e6× large
    // (10.39 USDC → "52,000 SOL"). Re-seed at the e9 scale every run so a
    // re-initialized stack heals without manual poking. The AFHO mock spot
    // is left alone here — the keeper refreshes it against the live pool.
    const mockSolPrice = process.env.MOCK_SOL_PRICE || "200000000000"; // 200 USDC/SOL
    const [solMockPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mock_price"), WSOL_MINT.toBuffer()],
        mockDexProgramId
    );
    await mockDexProgram.methods
        .setPrice(new anchor.BN(mockSolPrice))
        .accounts({ payer: provider.wallet.publicKey, afhoMint: WSOL_MINT, mockPrice: solMockPda })
        .rpc();
    console.log(`   mock SOL price re-seeded: ${mockSolPrice} floor units (${Number(mockSolPrice) / 1e9} USDC/SOL)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});