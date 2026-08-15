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

    let nysehMint: PublicKey;
    let usdcMint: PublicKey;
    let marketStatusPda: PublicKey;
    let ammStatePda: PublicKey;
    let acceptedOffersPda: PublicKey;
    let metricsPda: PublicKey;
    let nysehVault: PublicKey;
    let usdcVault: PublicKey;
    let solVault: PublicKey;
    let poolState: PublicKey;
    let poolNyseh: PublicKey;
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
                nysehVault,
                solVault,
                nysehMint,
                poolState,
                poolNyseh,
                poolUsdc,
                poolSol: poolState,
                dexProgram: mock.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();
    }

    const usdcBalance = async () =>
        Number((await provider.connection.getTokenAccountBalance(usdcVault)).value.amount);
    const nysehBalance = async () =>
        Number((await provider.connection.getTokenAccountBalance(nysehVault)).value.amount);

    before(async () => {
        nysehMint = await createMint(provider.connection, payer, payer.publicKey, null, 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        usdcMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

        [marketStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], crank.programId);
        if (!(await provider.connection.getAccountInfo(marketStatusPda))) {
            await crank.methods.initializeState().accounts({ marketStatus: marketStatusPda, payer: payer.publicKey }).rpc();
        }

        [ammStatePda] = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), nysehMint.toBuffer()], amm.programId);
        [acceptedOffersPda] = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), nysehMint.toBuffer()], amm.programId);
        [metricsPda] = PublicKey.findProgramAddressSync([Buffer.from("metrics"), nysehMint.toBuffer()], amm.programId);
        [offerListPda] = PublicKey.findProgramAddressSync([Buffer.from("offer_list"), nysehMint.toBuffer()], amm.programId);
        const [solDipPda] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_dip"), nysehMint.toBuffer()], amm.programId);
        [solVault] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_vault"), nysehMint.toBuffer()], amm.programId);

        nysehVault = await createAtaOffCurve(nysehMint, ammStatePda, TOKEN_2022_PROGRAM_ID);
        usdcVault = await createAtaOffCurve(usdcMint, ammStatePda, TOKEN_PROGRAM_ID);
        const usdcDip = await createAtaOffCurve(usdcMint, ammStatePda, TOKEN_PROGRAM_ID);

        await amm.methods
            .initializeAmm()
            .accounts({
                authority: payer.publicKey,
                nysehMint,
                usdcMint,
                ammState: ammStatePda,
                nysehVault,
                usdcVault,
                usdcDip,
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
        [poolState] = PublicKey.findProgramAddressSync([Buffer.from("mock_pool"), nysehMint.toBuffer()], mock.programId);
        poolNyseh = getAssociatedTokenAddressSync(nysehMint, poolState, true, TOKEN_2022_PROGRAM_ID);
        poolUsdc = getAssociatedTokenAddressSync(usdcMint, poolState, true, TOKEN_PROGRAM_ID);
        await mock.methods
            .initPool()
            .accounts({
                payer: payer.publicKey,
                nysehMint,
                usdcMint,
                poolState,
                poolNyseh,
                poolUsdc,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        // fund: USDC in the amm vault (mock "proceeds"), NYSEH liquidity in the pool
        await mintTo(provider.connection, payer, usdcMint, usdcVault, payer.publicKey, USDC_FUND);
        await mintTo(provider.connection, payer, nysehMint, poolNyseh, payer.publicKey, 1_000_000_000_000_000, undefined, undefined, TOKEN_2022_PROGRAM_ID);
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
                trailingStakeHealth: new Array(5).fill(50),
                totalStaked: new anchor.BN(0),
                totalSupply: new anchor.BN(0),
                bigAccepted: [0, 0, 0, 0, 70],
                medAccepted: [0, 0, 0, 0, 60],
                smlAccepted: [0, 0, 0, 0, 50],
                buybackBasis: new anchor.BN(0),
                untakenDays: 0,
                bigOffered: 0, bigRemaining: 0,
                medOffered: 0, medRemaining: 0,
                smlOffered: 0, smlRemaining: 0,
            })
            .accounts({ authority: payer.publicKey, ammState: ammStatePda, metrics: metricsPda, acceptedOffers: acceptedOffersPda, offerList: offerListPda })
            .rpc();

        const usdcBefore = await usdcBalance();
        const nysehBefore = await nysehBalance();
        await buybackTx();

        const usdcAfter = await usdcBalance();
        const nysehAfter = await nysehBalance();
        const slice = usdcBefore - usdcAfter;
        assert.isAbove(slice, 0, "slice executed");
        // first-hour weight 15% x factor 0.5-1.5 -> 7.5%..22.5% of budget
        assert.isAtLeast(slice, USDC_FUND * 0.05, "slice >= 5% of budget");
        assert.isAtMost(slice, USDC_FUND * 0.25, "slice <= 25% of budget");
        assert.equal(nysehAfter - nysehBefore, slice * 100_000, "mock rate out-leg");

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
