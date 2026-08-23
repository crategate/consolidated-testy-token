import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import { CrankOracle } from "../target/types/crank_oracle";
import { MockDexPool } from "../target/types/mock_dex_pool";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
    createMint,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

// Ratchet floor decay: after 15 straight trading days with no fills, the
// floor decays toward the live price by 2% of the gap per day (floor -=
// (floor - live) * 2 / 100, floored at 1, capped at the gap).
describe("ratchet floor decay", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const payer = (provider.wallet as anchor.Wallet).payer;

    const amm = anchor.workspace.Amm as Program<Amm>;
    const crank = anchor.workspace.CrankOracle as Program<CrankOracle>;
    const mock = anchor.workspace.MockDexPool as Program<MockDexPool>;

    let afhoMint: PublicKey;
    let marketStatusPda: PublicKey;
    let ammStatePda: PublicKey;
    let acceptedOffersPda: PublicKey;
    let metricsPda: PublicKey;
    let offerListPda: PublicKey;
    let mockPricePda: PublicKey;

    const now = () => Math.floor(Date.now() / 1000);

    async function setMarket(state: number, day: number, ts: number) {
        await crank.methods
            .testSetState(state, new anchor.BN(day), new anchor.BN(ts))
            .accounts({ marketStatus: marketStatusPda })
            .rpc();
    }

    async function createAtaOffCurve(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) {
        const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
        const tx = new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint, tokenProgram),
        );
        await provider.sendAndConfirm(tx);
        return ata;
    }

    async function setPrice(price: number) {
        await mock.methods
            .setPrice(new anchor.BN(price))
            .accounts({ payer: payer.publicKey, afhoMint, mockPrice: mockPricePda })
            .rpc();
    }

    function loadKnobs(k: {
        basis?: number;
        untaken: number;
        sheet?: { big: [number, number]; med: [number, number]; sml: [number, number] };
    }) {
        const sheet = k.sheet ?? { big: [0, 0], med: [0, 0], sml: [0, 0] };
        return amm.methods
            .loadTestData({
                priceChanges: new Array(20).fill(0),
                sampleHead: 0,
                spotPrices: new Array(32).fill(new anchor.BN(0)),
                spotHead: 0,
                trailingStakeHealth: new Array(5).fill(50),
                totalStaked: new anchor.BN(0),
                totalSupply: new anchor.BN(0),
                bigAccepted: [0, 0, 0, 0, 0],
                medAccepted: [0, 0, 0, 0, 0],
                smlAccepted: [0, 0, 0, 0, 0],
                buybackBasis: new anchor.BN(k.basis ?? 0),
                untakenDays: k.untaken,
                bigOffered: sheet.big[0], bigRemaining: sheet.big[1],
                medOffered: sheet.med[0], medRemaining: sheet.med[1],
                smlOffered: sheet.sml[0], smlRemaining: sheet.sml[1],
                bigLotTier: 0, bigDiscountBps: 0, bigVestingDays: 0,
                medLotTier: 0, medDiscountBps: 0, medVestingDays: 0,
                smlLotTier: 0, smlDiscountBps: 0, smlVestingDays: 0,
            })
            .accounts({
                authority: payer.publicKey,
                ammState: ammStatePda,
                metrics: metricsPda,
                acceptedOffers: acceptedOffersPda,
                offerList: offerListPda,
            })
            .rpc();
    }

    async function calc(day: number) {
        await setMarket(0, day, now());
        await amm.methods
            .calcCompletedOffers()
            .accounts({
                cranker: payer.publicKey,
                ammState: ammStatePda,
                offerList: offerListPda,
                marketStatus: marketStatusPda,
                acceptedOffers: acceptedOffersPda,
                priceOracle: mockPricePda,
            })
            .rpc();
        const st = await amm.account.ammState.fetch(ammStatePda);
        return { floor: st.highestBuybackBasis.toNumber(), untaken: st.untakenDays };
    }

    before(async () => {
        afhoMint = await createMint(provider.connection, payer, payer.publicKey, null, 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        const usdcMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

        [marketStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], crank.programId);
        if (!(await provider.connection.getAccountInfo(marketStatusPda))) {
            await crank.methods.initializeState().accounts({ marketStatus: marketStatusPda, payer: payer.publicKey }).rpc();
        }

        [ammStatePda] = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), afhoMint.toBuffer()], amm.programId);
        [acceptedOffersPda] = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), afhoMint.toBuffer()], amm.programId);
        [metricsPda] = PublicKey.findProgramAddressSync([Buffer.from("metrics"), afhoMint.toBuffer()], amm.programId);
        [offerListPda] = PublicKey.findProgramAddressSync([Buffer.from("offer_list"), afhoMint.toBuffer()], amm.programId);
        [mockPricePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), afhoMint.toBuffer()], mock.programId);
        // SOL/USD oracle + SOL rewards holding PDA (SOL leg unused in this suite)
        const [solOraclePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), usdcMint.toBuffer()], mock.programId);
        const [solRewardsPda] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_rewards"), afhoMint.toBuffer()], amm.programId);
        const [solDipPda] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_dip"), afhoMint.toBuffer()], amm.programId);
        const [solVault] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_vault"), afhoMint.toBuffer()], amm.programId);

        const afhoVault = await createAtaOffCurve(afhoMint, ammStatePda, TOKEN_2022_PROGRAM_ID);
        const usdcVault = await createAtaOffCurve(usdcMint, ammStatePda, TOKEN_PROGRAM_ID);
        // dip/rewards USDC vaults are PDA token accounts created by initialize_amm
        const [usdcDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), afhoMint.toBuffer()], amm.programId);
        const [usdcRewards] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), afhoMint.toBuffer()], amm.programId);

        await amm.methods
            .initializeAmm(mockPricePda, PublicKey.default, solOraclePda)
            .accounts({
                authority: payer.publicKey,
                afhoMint,
                usdcMint,
                ammState: ammStatePda,
                afhoVault,
                usdcVault,
                usdcDip,
                usdcRewards,
                solRewards: solRewardsPda,
                solDip: solDipPda,
                solVault,
                offerList: offerListPda,
                acceptedOffers: acceptedOffersPda,
                metrics: metricsPda,
                marketStatusPda,
                crankProgram: crank.programId,
                priceOracle: marketStatusPda,
                dexProgram: mock.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        await setPrice(500);
    });

    it("grace period: no decay through the 15th locked day", async () => {
        await loadKnobs({ basis: 1000, untaken: 14 });
        const st = await calc(1);
        // no sheet, live 500 < floor 1000 -> counter 14 -> 15, still grace
        assert.equal(st.untaken, 15);
        assert.equal(st.floor, 1000, "no decay at day 15");
    });

    it("first decay day cuts exactly 2% of the gap", async () => {
        const st = await calc(2);
        // untaken 15 -> 16 > 15: cut = (1000 - 500) * 2 / 100 = 10
        assert.equal(st.untaken, 16);
        assert.equal(st.floor, 990);
    });

    it("converges exponentially over multiple locked days", async () => {
        const d3 = await calc(3); // gap 490 -> cut 9
        assert.equal(d3.floor, 981);
        const d4 = await calc(4); // gap 481 -> cut 9
        assert.equal(d4.floor, 972);
        const d5 = await calc(5); // gap 472 -> cut 9
        assert.equal(d5.floor, 963);
    });

    it("any fill resets the counter and stops decay", async () => {
        // sheet posted, sml 7 of 10 taken
        await loadKnobs({ untaken: 25, sheet: { big: [0, 0], med: [0, 0], sml: [10, 7] } });
        const st = await calc(6);
        assert.equal(st.untaken, 0, "fill resets counter");
        assert.equal(st.floor, 963, "no decay on a fill day");
    });

    it("no-sheet day with price >= floor leaves the counter unchanged", async () => {
        await setPrice(2000); // above floor 963
        await loadKnobs({ untaken: 20 }); // clears the sheet (all zeros)
        const st = await calc(7);
        assert.equal(st.untaken, 20, "nothing wrong — counter holds");
        assert.equal(st.floor, 963, "no decay above floor");
    });

    it("sheet-made-but-untaken counts toward the lock", async () => {
        await loadKnobs({ untaken: 20, sheet: { big: [0, 0], med: [0, 0], sml: [10, 10] } });
        const st = await calc(8);
        assert.equal(st.untaken, 21, "ignored sheet counts");
        assert.equal(st.floor, 963, "still no decay above floor");
    });

    it("decay lands exactly on live price and stops", async () => {
        await setPrice(99);
        await loadKnobs({ basis: 100, untaken: 20 }); // floor 100, sheet cleared
        const d9 = await calc(9);
        // gap 1 -> 2% = 0 -> max(1) -> floor 99 == live
        assert.equal(d9.floor, 99);
        const d10 = await calc(10);
        assert.equal(d10.floor, 99, "never crosses below live");
        assert.equal(d10.untaken, 21, "no increment once floor == live");
    });
});