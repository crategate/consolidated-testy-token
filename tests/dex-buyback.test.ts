import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import { CrankOracle } from "../target/types/crank_oracle";
import { MockDexPool } from "../target/types/mock_dex_pool";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
    createMint,
    mintTo,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("dex_buyback", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const payer = (provider.wallet as anchor.Wallet).payer;

    const amm = anchor.workspace.Amm as Program<Amm>;
    const crank = anchor.workspace.CrankOracle as Program<CrankOracle>;
    const mock = anchor.workspace.MockDexPool as Program<MockDexPool>;

    let afhoMint: PublicKey;
    let usdcMint: PublicKey;
    let marketStatusPda: PublicKey;
    let ammStatePda: PublicKey;
    let acceptedOffersPda: PublicKey;
    let metricsPda: PublicKey;
    let afhoVault: PublicKey;
    let usdcVault: PublicKey;
    let solVault: PublicKey;
    let solOraclePda: PublicKey;
    let mockPricePda: PublicKey;
    let poolState: PublicKey;
    let poolAfho: PublicKey;
    let poolUsdc: PublicKey;
    let offerListPda: PublicKey;

    const USDC_FUND = 10_000_000_000; // 10k USDC raw (6 dec)
    // mock rate: out = in * 100_000 -> exec price = 1e6/1e5 = 10 exactly
    const MOCK_EXEC_PRICE = 10;

    const now = () => Math.floor(Date.now() / 1000);

    async function setMarket(state: number, day: number, ts: number) {
        await crank.methods
            .testSetState(state, new anchor.BN(day), new anchor.BN(ts))
            .accounts({ marketStatus: marketStatusPda })
            .rpc();
    }

    async function setPrice(price: number) {
        await mock.methods
            .setPrice(new anchor.BN(price))
            .accounts({ payer: payer.publicKey, afhoMint, mockPrice: mockPricePda })
            .rpc();
    }

    // Same pattern as scripts/amm-init.ts: idempotent ATA creation works for
    // off-curve (PDA) owners; anchor's associated_token constraints check the
    // derivation and the account's mint/authority fields.
    async function createAtaOffCurve(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) {
        const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
        const tx = new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint, tokenProgram),
        );
        const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = payer.publicKey;
        await provider.sendAndConfirm(tx);
        return ata;
    }

    async function expectFail(p: Promise<any>, code: string) {
        try {
            await p;
        } catch (e: any) {
            const msg = e.message ?? "";
            const errCode = e.error?.errorCode?.code ?? "";
            assert.ok(msg.includes(code) || errCode === code, `expected ${code}, got: ${msg}`);
            return;
        }
        assert.fail(`expected failure ${code}`);
    }

    function buybackTx() {
        return amm.methods
            .dexBuyback()
            .accounts({
                cranker: payer.publicKey,
                ammState: ammStatePda,
                marketStatus: marketStatusPda,
                acceptedOffers: acceptedOffersPda,
                usdcVault,
                afhoVault,
                solVault,
                solOracle: solOraclePda,
                spotOracle: mockPricePda,
                afhoMint,
                usdcMint,
                poolState,
                poolAfho,
                poolUsdc,
                poolSol: poolState,
                dexProgram: mock.programId,
                cpmmPoolState: poolState,
                cpmmAmmConfig: poolState,
                cpmmInputVault: poolState,
                cpmmOutputVault: poolState,
                cpmmObservation: poolState,
                cpmmAuthority: poolState,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();
    }

    const usdcBalance = async () =>
        Number((await provider.connection.getTokenAccountBalance(usdcVault)).value.amount);
    const afhoBalance = async () =>
        Number((await provider.connection.getTokenAccountBalance(afhoVault)).value.amount);

    before(async () => {
        afhoMint = await createMint(provider.connection, payer, payer.publicKey, null, 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        usdcMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

        [marketStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], crank.programId);
        if (!(await provider.connection.getAccountInfo(marketStatusPda))) {
            await crank.methods.initializeState().accounts({ marketStatus: marketStatusPda, payer: payer.publicKey }).rpc();
        }

        [ammStatePda] = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), afhoMint.toBuffer()], amm.programId);
        [acceptedOffersPda] = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), afhoMint.toBuffer()], amm.programId);
        [metricsPda] = PublicKey.findProgramAddressSync([Buffer.from("metrics"), afhoMint.toBuffer()], amm.programId);
        [offerListPda] = PublicKey.findProgramAddressSync([Buffer.from("offer_list"), afhoMint.toBuffer()], amm.programId);
        const [solDipPda] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_dip"), afhoMint.toBuffer()], amm.programId);
        [solVault] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_vault"), afhoMint.toBuffer()], amm.programId);

        afhoVault = await createAtaOffCurve(afhoMint, ammStatePda, TOKEN_2022_PROGRAM_ID);
        usdcVault = await createAtaOffCurve(usdcMint, ammStatePda, TOKEN_PROGRAM_ID);
        // dip/rewards USDC vaults are PDA token accounts created by initialize_amm
        const [usdcDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), afhoMint.toBuffer()], amm.programId);
        const [usdcRewards] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), afhoMint.toBuffer()], amm.programId);
        [mockPricePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), afhoMint.toBuffer()], mock.programId);
        // SOL/USD oracle (same mock pattern, seeded with a stand-in mint —
        // the SOL leg never fires in this suite, so it stays unset)
        [solOraclePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), usdcMint.toBuffer()], mock.programId);
        const [solRewardsPda] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_rewards"), afhoMint.toBuffer()], amm.programId);

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

        // mock pool (pool token accounts are ATAs of the pool PDA)
        [poolState] = PublicKey.findProgramAddressSync([Buffer.from("mock_pool"), afhoMint.toBuffer()], mock.programId);
        poolAfho = getAssociatedTokenAddressSync(afhoMint, poolState, true, TOKEN_2022_PROGRAM_ID);
        poolUsdc = getAssociatedTokenAddressSync(usdcMint, poolState, true, TOKEN_PROGRAM_ID);
        await mock.methods
            .initPool()
            .accounts({
                payer: payer.publicKey,
                afhoMint,
                usdcMint,
                poolState,
                poolAfho,
                poolUsdc,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        // fund: USDC in the amm vault (mock "proceeds"), AFHO liquidity in the pool
        await mintTo(provider.connection, payer, usdcMint, usdcVault, payer.publicKey, USDC_FUND);
        await mintTo(provider.connection, payer, afhoMint, poolAfho, payer.publicKey, 1_000_000_000_000_000, undefined, undefined, TOKEN_2022_PROGRAM_ID);

        // M3 spot band: exec price 10 must sit within 5% of the spot oracle.
        await setPrice(10);
    });

    it("rejects buybacks while the market is closed", async () => {
        await setMarket(2, 0, now());
        await expectFail(buybackTx(), "InvalidMarketState");
    });

    it("rejects buybacks when no offers were filled", async () => {
        await setMarket(0, 1, now());
        await expectFail(buybackTx(), "NoFillsToBuyBack");
    });

    it("executes a first-hour slice and ratchets the basis", async () => {
        await amm.methods
            .loadTestData({
                priceChanges: new Array(20).fill(0),
                sampleHead: 0,
                spotPrices: new Array(32).fill(new anchor.BN(0)),
                spotHead: 0,
                trailingStakeHealth: new Array(5).fill(50),
                totalStaked: new anchor.BN(0),
                totalSupply: new anchor.BN(0),
                bigAccepted: [0, 0, 0, 0, 70],
                medAccepted: [0, 0, 0, 0, 60],
                smlAccepted: [0, 0, 0, 0, 50],
                buybackBasis: new anchor.BN(0),
                untakenDays: 0,
                offerDayIndex: new anchor.BN("18446744073709551615"), // u64::MAX = leave sheet day alone
                bigOffered: 0, bigRemaining: 0,
                medOffered: 0, medRemaining: 0,
                smlOffered: 0, smlRemaining: 0,
                bigLotTier: 0, bigDiscountBps: 0, bigVestingDays: 0,
                medLotTier: 0, medDiscountBps: 0, medVestingDays: 0,
                smlLotTier: 0, smlDiscountBps: 0, smlVestingDays: 0,
            })
            .accounts({ authority: payer.publicKey, ammState: ammStatePda, metrics: metricsPda, acceptedOffers: acceptedOffersPda, offerList: offerListPda })
            .rpc();

        const usdcBefore = await usdcBalance();
        const afhoBefore = await afhoBalance();
        await buybackTx();

        const usdcAfter = await usdcBalance();
        const afhoAfter = await afhoBalance();
        const slice = usdcBefore - usdcAfter;
        assert.isAbove(slice, 0, "slice executed");
        // first-hour weight 1.9% x factor 0.5-1.5 -> 0.95%..2.85% of budget
        assert.isAtLeast(slice, USDC_FUND * 0.005, "slice >= 0.5% of budget");
        assert.isAtMost(slice, USDC_FUND * 0.03, "slice <= 3% of budget");
        assert.equal(afhoAfter - afhoBefore, slice * 100_000, "mock rate out-leg");

        const state = await amm.account.ammState.fetch(ammStatePda);
        assert.equal(state.highestBuybackBasis.toNumber(), MOCK_EXEC_PRICE, "ratchet");
        assert.equal(state.bbDayIndex.toNumber(), 1);
        assert.equal(state.bbSliceCount, 1);
    });

    it("paces slices (immediate re-fire is a no-op)", async () => {
        const before = await usdcBalance();
        await buybackTx();
        assert.equal(await usdcBalance(), before, "no second slice within MIN_SLICE_SLOTS");
    });

    it("rolls over unspent budget when the market closes", async () => {
        await setMarket(2, 1, now());
        const closedBalance = await usdcBalance();
        await expectFail(buybackTx(), "InvalidMarketState");
        assert.equal(await usdcBalance(), closedBalance, "no forced sell at close");

        // next trading day: new budget == remaining vault (rollover, no bookkeeping)
        await setMarket(0, 2, now());
        const before = await usdcBalance();
        await buybackTx();
        const after = await usdcBalance();
        const state = await amm.account.ammState.fetch(ammStatePda);
        assert.equal(state.bbDayIndex.toNumber(), 2);
        assert.equal(state.bbBudgetUsdc.toNumber(), before, "day-2 budget = leftover vault");
        assert.isAbove(before - after, 0, "day-2 slice executed");
    });

    it("uses the smaller tail weight after the first hour", async () => {
        await setMarket(0, 3, now() - 7200); // opened 2h ago
        const before = await usdcBalance();
        await buybackTx();
        const slice = before - (await usdcBalance());
        // tail weight 5% x factor 0.5-1.5 -> at most 7.5% of remaining
        assert.isAbove(slice, 0);
        assert.isAtMost(slice, before * 0.08, "tail slice <= 8% of remaining");
    });

    it("keeps the ratchet at the fixed mock execution price", async () => {
        const state = await amm.account.ammState.fetch(ammStatePda);
        assert.equal(state.highestBuybackBasis.toNumber(), MOCK_EXEC_PRICE);
    });
});