import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import { CrankOracle } from "../target/types/crank_oracle";
import { MockDexPool } from "../target/types/mock_dex_pool";
import { Staking } from "../target/types/staking";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
    createMint,
    mintTo,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

// Repro: keeper close sequence (update_tradeday_stats -> make_offers) after
// load_test_data with the amm-test-data.ts bullish scenario. Dumps the
// make_offers msg! log and the resulting offer sheet.
describe("repro: make_offers after load_test_data", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const payer = (provider.wallet as anchor.Wallet).payer;

    const amm = anchor.workspace.Amm as Program<Amm>;
    const crank = anchor.workspace.CrankOracle as Program<CrankOracle>;
    const mock = anchor.workspace.MockDexPool as Program<MockDexPool>;
    const staking = anchor.workspace.Staking as Program<Staking>;

    const AFHO_UNIT = 10 ** 9;
    const now = () => Math.floor(Date.now() / 1000);

    let afhoMint: PublicKey;
    let usdcMint: PublicKey;
    let marketStatusPda: PublicKey;
    let ammStatePda: PublicKey;
    let offerListPda: PublicKey;
    let acceptedOffersPda: PublicKey;
    let metricsPda: PublicKey;
    let mockPricePda: PublicKey;
    let solOraclePda: PublicKey;
    let afhoVault: PublicKey;
    let usdcVault: PublicKey;
    let poolPda: PublicKey;
    let poolState: PublicKey;

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

    before(async () => {
        afhoMint = await createMint(provider.connection, payer, payer.publicKey, null, 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        usdcMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

        [marketStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], crank.programId);
        if (!(await provider.connection.getAccountInfo(marketStatusPda))) {
            await crank.methods.initializeState().accounts({ marketStatus: marketStatusPda, payer: payer.publicKey }).rpc();
        }

        [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool"), afhoMint.toBuffer()], staking.programId);
        const [stakingVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), poolPda.toBuffer()], staking.programId);
        const [rewardVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("rewards"), poolPda.toBuffer()], staking.programId);
        const [penaltyVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("penalties"), poolPda.toBuffer()], staking.programId);
        const [posrVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("posr"), poolPda.toBuffer()], staking.programId);
        await staking.methods
            .initializePool(crank.programId, 30000, 500, 400, 800, 1800, amm.programId)
            .accounts({
                authority: payer.publicKey,
                mint: afhoMint,
                pool: poolPda,
                vault: stakingVaultPda,
                rewardVault: rewardVaultPda,
                penaltyVault: penaltyVaultPda,
                posrVault: posrVaultPda,
                marketStatusPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        [ammStatePda] = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), afhoMint.toBuffer()], amm.programId);
        [offerListPda] = PublicKey.findProgramAddressSync([Buffer.from("offer_list"), afhoMint.toBuffer()], amm.programId);
        [acceptedOffersPda] = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), afhoMint.toBuffer()], amm.programId);
        [metricsPda] = PublicKey.findProgramAddressSync([Buffer.from("metrics"), afhoMint.toBuffer()], amm.programId);
        [mockPricePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), afhoMint.toBuffer()], mock.programId);
        [solOraclePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), usdcMint.toBuffer()], mock.programId);
        const [solVault] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_vault"), afhoMint.toBuffer()], amm.programId);
        const [solDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_dip"), afhoMint.toBuffer()], amm.programId);
        const [solRewardsPda] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_rewards"), afhoMint.toBuffer()], amm.programId);
        const [usdcDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), afhoMint.toBuffer()], amm.programId);
        const [usdcRewards] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), afhoMint.toBuffer()], amm.programId);

        afhoVault = await createAtaOffCurve(afhoMint, ammStatePda, TOKEN_2022_PROGRAM_ID);
        usdcVault = await createAtaOffCurve(usdcMint, ammStatePda, TOKEN_PROGRAM_ID);

        await amm.methods
            .initializeAmm(mockPricePda, poolPda, solOraclePda)
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
                priceOracle: mockPricePda,
                dexProgram: mock.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        [poolState] = PublicKey.findProgramAddressSync([Buffer.from("mock_pool"), afhoMint.toBuffer()], mock.programId);
        const poolAfho = getAssociatedTokenAddressSync(afhoMint, poolState, true, TOKEN_2022_PROGRAM_ID);
        const poolUsdc = getAssociatedTokenAddressSync(usdcMint, poolState, true, TOKEN_PROGRAM_ID);
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

        await mock.methods
            .setPrice(new anchor.BN(10))
            .accounts({ payer: payer.publicKey, afhoMint, mockPrice: mockPricePda })
            .rpc();

        // stock the offer desk vault
        await mintTo(provider.connection, payer, afhoMint, afhoVault, payer.publicKey, 1_000_000 * AFHO_UNIT, undefined, undefined, TOKEN_2022_PROGRAM_ID);

        const info = await provider.connection.getAccountInfo(afhoVault);
        console.log("afhoVault:", afhoVault.toBase58(), "owner:", info?.owner.toBase58(), "len:", info?.data.length);
        if (info && info.data.length >= 72) {
            console.log("amount@64:", Buffer.from(info.data.slice(64, 72)).readBigUInt64LE().toString());
        }
    });

    it("keeper close sequence -> sheet", async () => {
        // the amm-test-data.ts bullish scenario
        await amm.methods
            .loadTestData({
                priceChanges: Array.from({ length: 20 }, (_, i) => 30 + i * 10),
                sampleHead: 0,
                trailingStakeHealth: [40, 40, 41, 40, 41],
                totalStaked: new anchor.BN(400_000).mul(new anchor.BN(10).pow(new anchor.BN(9))),
                totalSupply: new anchor.BN(1_000_000).mul(new anchor.BN(10).pow(new anchor.BN(9))),
                bigAccepted: [10, 20, 30, 40, 50],
                medAccepted: [20, 35, 50, 60, 70],
                smlAccepted: [30, 45, 55, 65, 75],
                buybackBasis: new anchor.BN(0),
                untakenDays: 0,
                offerDayIndex: new anchor.BN("18446744073709551615"),
                spotPrices: new Array(32).fill(new anchor.BN(0)),
                spotHead: 0,
                bigOffered: 3, bigRemaining: 2,
                medOffered: 5, medRemaining: 4,
                smlOffered: 10, smlRemaining: 8,
                bigLotTier: 15, bigDiscountBps: 115, bigVestingDays: 30,
                medLotTier: 10, medDiscountBps: 90, medVestingDays: 20,
                smlLotTier: 5, smlDiscountBps: 75, smlVestingDays: 10,
            })
            .accounts({ authority: payer.publicKey, ammState: ammStatePda, metrics: metricsPda, acceptedOffers: acceptedOffersPda, offerList: offerListPda })
            .rpc();

        // market closes, day 10
        await crank.methods
            .testSetState(2, new anchor.BN(10), new anchor.BN(now()))
            .accounts({ marketStatus: marketStatusPda })
            .rpc();

        // keeper step 1: update_tradeday_stats
        try {
            const sig = await amm.methods
                .updateTradedayStats()
                .accounts({
                    cranker: payer.publicKey,
                    ammState: ammStatePda,
                    marketMetrics: metricsPda,
                    marketStatus: marketStatusPda,
                    spotOracle: mockPricePda,
                    cpmmPoolState: poolState,
                    cpmmObservation: poolState,
                    cpmmInputVault: poolState,
                    cpmmOutputVault: poolState,
                    stakingPool: poolPda,
                    afhoMint,
                } as any)
                .rpc();
            console.log("update_tradeday_stats ok:", sig);
        } catch (e: any) {
            console.log("update_tradeday_stats FAILED:", e.message);
        }

        // keeper step 2: make_offers — simulate first to capture the msg! log
        const makeOffersAccounts: any = {
            cranker: payer.publicKey,
            ammState: ammStatePda,
            offerList: offerListPda,
            marketStatus: marketStatusPda,
            metrics: metricsPda,
            acceptedOffers: acceptedOffersPda,
            afhoMint,
            afhoVault,
            priceOracle: mockPricePda,
        };
        try {
            const tx = await amm.methods.makeOffers().accounts(makeOffersAccounts).transaction();
            tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
            tx.feePayer = payer.publicKey;
            const sim = await provider.connection.simulateTransaction(tx);
            console.log("--- make_offers sim logs ---");
            console.log("err:", JSON.stringify(sim.value.err));
            for (const l of sim.value.logs ?? []) console.log(l);
        } catch (e: any) {
            console.log("make_offers SIMULATION FAILED:", e.message);
            if (e.simulationResponse?.logs) for (const l of e.simulationResponse.logs) console.log(l);
            return;
        }

        const sig = await amm.methods.makeOffers().accounts(makeOffersAccounts).rpc();
        console.log("make_offers ok:", sig);

        const sheet = await amm.account.offerList.fetch(offerListPda);
        console.log("day_index:", sheet.dayIndex.toString());
        console.log("big:", JSON.stringify(sheet.bigOffer));
        console.log("med:", JSON.stringify(sheet.medOffer));
        console.log("sml:", JSON.stringify(sheet.smlOffer));

        const metrics = await amm.account.marketMetrics.fetch(metricsPda);
        console.log("metrics.price_changes:", metrics.priceChanges);
        console.log("metrics.sample_head:", metrics.sampleHead);
        console.log("metrics.total_supply:", metrics.totalSupply.toString());
        console.log("metrics.total_staked:", metrics.totalStaked.toString());
    });
});
