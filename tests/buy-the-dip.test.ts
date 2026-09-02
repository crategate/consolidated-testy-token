import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import { CrankOracle } from "../target/types/crank_oracle";
import { MockDexPool } from "../target/types/mock_dex_pool";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
    createMint,
    mintTo,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("buy_the_dip", () => {
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
    let offerListPda: PublicKey;
    let afhoVault: PublicKey;
    let usdcDip: PublicKey;
    let solDip: PublicKey;
    let mockPricePda: PublicKey;
    let solOraclePda: PublicKey;
    let poolState: PublicKey;
    let poolAfho: PublicKey;
    let poolUsdc: PublicKey;

    const REF_PRICE = 1_000_000_000; // spot-ring reference (floor units = price × 1e9)
    const USDC_DIP_FUND = 1_000_000_000; // 1000 USDC raw
    const SOL_DIP_FUND = 500_000_000; // 0.5 SOL above the rent floor
    // mock rate: out = in * 100_000 -> exec price = 1e12/1e5 = 1e7 exactly
    const MOCK_EXEC_PRICE = 10_000_000;

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

    function dipTx(cranker: Keypair = payer) {
        return amm.methods
            .buyTheDip()
            .accounts({
                cranker: cranker.publicKey,
                ammState: ammStatePda,
                marketStatus: marketStatusPda,
                metrics: metricsPda,
                spotOracle: mockPricePda,
                solOracle: solOraclePda,
                usdcDip,
                solDip,
                afhoVault,
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
                systemProgram: SystemProgram.programId,
            })
            .signers(cranker === payer ? [] : [cranker])
            .rpc();
    }

    // priceChanges: oldest -> newest. spotPrices: ring prefilled at `ref`.
    function loadMetrics(priceChanges: number[], ref: number) {
        return amm.methods
            .loadTestData({
                priceChanges,
                sampleHead: 0,
                trailingStakeHealth: new Array(5).fill(50),
                totalStaked: new anchor.BN(0),
                totalSupply: new anchor.BN(0),
                bigAccepted: [0, 0, 0, 0, 0],
                medAccepted: [0, 0, 0, 0, 0],
                smlAccepted: [0, 0, 0, 0, 0],
                buybackBasis: new anchor.BN(0),
                untakenDays: 0,
                offerDayIndex: new anchor.BN("18446744073709551615"), // u64::MAX = leave sheet day alone
                spotPrices: new Array(32).fill(new anchor.BN(ref)),
                spotHead: 0,
                bigOffered: 0, bigRemaining: 0,
                medOffered: 0, medRemaining: 0,
                smlOffered: 0, smlRemaining: 0,
                bigLotTier: 0, bigDiscountBps: 0, bigVestingDays: 0,
                medLotTier: 0, medDiscountBps: 0, medVestingDays: 0,
                smlLotTier: 0, smlDiscountBps: 0, smlVestingDays: 0,
            })
            .accounts({ authority: payer.publicKey, ammState: ammStatePda, metrics: metricsPda, acceptedOffers: acceptedOffersPda, offerList: offerListPda })
            .rpc();
    }

    const dipBalance = async () =>
        Number((await provider.connection.getTokenAccountBalance(usdcDip)).value.amount);
    const afhoBalance = async () =>
        Number((await provider.connection.getTokenAccountBalance(afhoVault)).value.amount);
    const solDipBalance = async () => provider.connection.getBalance(solDip);

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
        [mockPricePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), afhoMint.toBuffer()], mock.programId);
        // SOL/USD oracle (same mock pattern, seeded with a stand-in mint)
        [solOraclePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), usdcMint.toBuffer()], mock.programId);
        [solDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_dip"), afhoMint.toBuffer()], amm.programId);
        const [solVault] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_vault"), afhoMint.toBuffer()], amm.programId);
        const [solRewardsPda] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_rewards"), afhoMint.toBuffer()], amm.programId);

        afhoVault = await createAtaOffCurve(afhoMint, ammStatePda, TOKEN_2022_PROGRAM_ID);
        const usdcVault = await createAtaOffCurve(usdcMint, ammStatePda, TOKEN_PROGRAM_ID);
        // dip/rewards USDC vaults are PDA token accounts created by initialize_amm
        [usdcDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), afhoMint.toBuffer()], amm.programId);
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
                solDip,
                solVault,
                offerList: offerListPda,
                acceptedOffers: acceptedOffersPda,
                metrics: metricsPda,
                marketStatusPda,
                crankProgram: crank.programId,
                priceOracle: marketStatusPda, // unused (no make_offers here)
                dexProgram: mock.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        // mock pool + AFHO liquidity
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
        await mintTo(provider.connection, payer, afhoMint, poolAfho, payer.publicKey, 1_000_000_000_000_000, undefined, undefined, TOKEN_2022_PROGRAM_ID);

        // fund the USDC dip reserve (SOL reserve is funded in the SOL-leg test
        // so earlier tests exercise the USDC leg alone)
        await mintTo(provider.connection, payer, usdcMint, usdcDip, payer.publicKey, USDC_DIP_FUND);

        await setPrice(REF_PRICE);
    });

    it("cold start: no dip buy before the spot ring has enough samples", async () => {
        await setMarket(2, 1, now()); // closed — dip buyer is always on
        const before = await dipBalance();
        await dipTx();
        assert.equal(await dipBalance(), before, "no spend with an empty spot ring");
    });

    it("fires while CLOSED on a 10% dip: 25% of the reserve, ratchets the floor", async () => {
        // flat +1%/day ring -> slope 0 -> trend mult 1.0; spot 10% below ref
        await loadMetrics(new Array(20).fill(100), REF_PRICE);
        await setMarket(2, 2, now());
        await setPrice(900_000_000);

        const dipBefore = await dipBalance();
        const afhoBefore = await afhoBalance();
        await dipTx();
        const dipAfter = await dipBalance();
        const afhoAfter = await afhoBalance();

        const slice = Math.floor(dipBefore * 0.25); // 2500 bps, full depth
        assert.equal(dipBefore - dipAfter, slice, "spent 25% of the USDC dip reserve");
        assert.equal(afhoAfter - afhoBefore, slice * 100_000, "mock pool paid out at the fixed rate");
        const st = await amm.account.ammState.fetch(ammStatePda);
        assert.equal(st.highestBuybackBasis.toNumber(), MOCK_EXEC_PRICE, "ratchet at exec price");
    });

    it("ignores a shallow dip (<3% below the norm)", async () => {
        await setPrice(980_000_000); // 2% below ref 1e9 -> under the 3% trigger
        const before = await dipBalance();
        await dipTx();
        assert.equal(await dipBalance(), before, "no spend on a shallow dip");
        await setPrice(900_000_000); // restore the 10% dip
    });

    it("paces slices (immediate re-fire same day is a no-op)", async () => {
        const before = await dipBalance();
        await dipTx(); // same day as the previous slice, < 150 slots
        assert.equal(await dipBalance(), before, "paced");
    });

    it("knife guard: negative 20-day slope throttles to 6.25%", async () => {
        // new day -> fresh snapshot; ring: 15x +1% then 5x -8% -> slope -900 -> mult 2500
        await loadMetrics([...new Array(15).fill(100), ...new Array(5).fill(-800)], REF_PRICE);
        await setMarket(2, 3, now());
        const before = await dipBalance();
        await dipTx();
        const slice = Math.floor(before * 0.0625); // 625 bps
        assert.equal(before - (await dipBalance()), slice, "throttled to 25% of base");
    });

    it("rejects an unauthorized cranker", async () => {
        const rando = Keypair.generate();
        await provider.connection.requestAirdrop(rando.publicKey, 1_000_000_000);
        await new Promise((r) => setTimeout(r, 1000));
        await setMarket(2, 5, now());
        await expectFail(dipTx(rando), "UnauthorizedCaller");
    });
});
