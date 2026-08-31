import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import { CrankOracle } from "../target/types/crank_oracle";
import { MockDexPool } from "../target/types/mock_dex_pool";
import { Staking } from "../target/types/staking";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
    createMint,
    mintTo,
    createAssociatedTokenAccount,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// End-to-end offer_claim: buyer pays USDC for a discounted vesting lot,
// payment splits 80/10/10, AFHO lands directly in a locked StakePosition;
// then the keeper swaps the stakers' 10% to AFHO and deposits it into the
// staking reward vault.
describe("offer_claim + distribute_staker_rewards", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const payer = (provider.wallet as anchor.Wallet).payer;

    const amm = anchor.workspace.Amm as Program<Amm>;
    const crank = anchor.workspace.CrankOracle as Program<CrankOracle>;
    const mock = anchor.workspace.MockDexPool as Program<MockDexPool>;
    const staking = anchor.workspace.Staking as Program<Staking>;

    let afhoMint: PublicKey;
    let usdcMint: PublicKey;
    let marketStatusPda: PublicKey;
    let ammStatePda: PublicKey;
    let offerListPda: PublicKey;
    let acceptedOffersPda: PublicKey;
    let metricsPda: PublicKey;
    let mockPricePda: PublicKey;
    let afhoVault: PublicKey;
    let usdcVault: PublicKey;
    let usdcDip: PublicKey;
    let usdcRewards: PublicKey;
    let solVault: PublicKey;
    let solDip: PublicKey;
    let solRewardsPda: PublicKey;
    let solOraclePda: PublicKey;
    let poolPda: PublicKey;
    let stakingVaultPda: PublicKey;
    let rewardVaultPda: PublicKey;
    let poolState: PublicKey;
    let poolAfho: PublicKey;
    let poolUsdc: PublicKey;

    const buyer = Keypair.generate();
    let buyerUsdc: PublicKey;

    const now = () => Math.floor(Date.now() / 1000);
    const AFHO_UNIT = 10 ** 9; // 9 decimals

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

    // SOL/USD mock price — same raw-u64 PDA pattern, seeded with usdcMint as
    // a stand-in for the wSOL mint (which doesn't exist on localnet).
    async function setSolPrice(price: number) {
        await mock.methods
            .setPrice(new anchor.BN(price))
            .accounts({ payer: payer.publicKey, afhoMint: usdcMint, mockPrice: solOraclePda })
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

    function claimTx(tier: number, units: number, index: number, spotOracle: PublicKey = mockPricePda) {
        const [userIndexPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_index"), buyer.publicKey.toBuffer()], staking.programId
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("position"),
                poolPda.toBuffer(),
                buyer.publicKey.toBuffer(),
                new anchor.BN(index).toArrayLike(Buffer, "le", 8),
            ],
            staking.programId
        );
        return amm.methods
            .offerClaim(tier, units, new anchor.BN(index))
            .accounts({
                buyer: buyer.publicKey,
                ammState: ammStatePda,
                offerList: offerListPda,
                afhoMint,
                usdcMint,
                spotOracle,
                marketStatus: marketStatusPda,
                buyerUsdc,
                ammUsdcVault: usdcVault,
                usdcDip,
                usdcRewards,
                stakingProgram: staking.programId,
                stakingPool: poolPda,
                userIndex: userIndexPda,
                stakePosition: positionPda,
                ammAfhoVault: afhoVault,
                stakingVault: stakingVaultPda,
                cpmmPoolState: amm.programId,
                cpmmObservation: amm.programId,
                cpmmInputVault: amm.programId,
                cpmmOutputVault: amm.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([buyer])
            .rpc();
    }

    function claimSolTx(tier: number, units: number, index: number) {
        const [userIndexPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_index"), buyer.publicKey.toBuffer()], staking.programId
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("position"),
                poolPda.toBuffer(),
                buyer.publicKey.toBuffer(),
                new anchor.BN(index).toArrayLike(Buffer, "le", 8),
            ],
            staking.programId
        );
        return amm.methods
            .offerClaimSol(tier, units, new anchor.BN(index))
            .accounts({
                buyer: buyer.publicKey,
                ammState: ammStatePda,
                offerList: offerListPda,
                afhoMint,
                usdcMint,
                spotOracle: mockPricePda,
                solOracle: solOraclePda,
                cpmmPoolState: amm.programId,
                cpmmObservation: amm.programId,
                cpmmInputVault: amm.programId,
                cpmmOutputVault: amm.programId,
                marketStatus: marketStatusPda,
                usdcVault,
                usdcDip,
                usdcRewards,
                wsolVault: getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true, TOKEN_PROGRAM_ID),
                wrappedSolMint: WSOL_MINT,
                // NOTE: offer_claim_sol unconditionally CPIs the wSOL→USDC swap,
                // so these SOL/USDC CPMM accounts must be the real pinned pool
                // (set via set_sol_usdc_pool). Leave uninvoked until §7 lands.
                solUsdcPoolState: PublicKey.default,
                solUsdcAmmConfig: PublicKey.default,
                solUsdcInputVault: PublicKey.default,
                solUsdcOutputVault: PublicKey.default,
                solUsdcObservation: PublicKey.default,
                solUsdcAuthority: PublicKey.default,
                stakingProgram: staking.programId,
                stakingPool: poolPda,
                userIndex: userIndexPda,
                stakePosition: positionPda,
                ammAfhoVault: afhoVault,
                stakingVault: stakingVaultPda,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();
    }

    before(async () => {
        await provider.connection.requestAirdrop(buyer.publicKey, 2_000_000_000);
        afhoMint = await createMint(provider.connection, payer, payer.publicKey, null, 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        usdcMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

        [marketStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], crank.programId);
        if (!(await provider.connection.getAccountInfo(marketStatusPda))) {
            await crank.methods.initializeState().accounts({ marketStatus: marketStatusPda, payer: payer.publicKey }).rpc();
        }

        // staking pool
        [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool"), afhoMint.toBuffer()], staking.programId);
        [stakingVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), poolPda.toBuffer()], staking.programId);
        [rewardVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("rewards"), poolPda.toBuffer()], staking.programId);
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

        // amm
        [ammStatePda] = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), afhoMint.toBuffer()], amm.programId);
        [offerListPda] = PublicKey.findProgramAddressSync([Buffer.from("offer_list"), afhoMint.toBuffer()], amm.programId);
        [acceptedOffersPda] = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), afhoMint.toBuffer()], amm.programId);
        [metricsPda] = PublicKey.findProgramAddressSync([Buffer.from("metrics"), afhoMint.toBuffer()], amm.programId);
        [mockPricePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), afhoMint.toBuffer()], mock.programId);
        [solVault] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_vault"), afhoMint.toBuffer()], amm.programId);
        [solDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_dip"), afhoMint.toBuffer()], amm.programId);
        [solRewardsPda] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_rewards"), afhoMint.toBuffer()], amm.programId);
        [solOraclePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), usdcMint.toBuffer()], mock.programId);

        afhoVault = await createAtaOffCurve(afhoMint, ammStatePda, TOKEN_2022_PROGRAM_ID);
        usdcVault = await createAtaOffCurve(usdcMint, ammStatePda, TOKEN_PROGRAM_ID);
        // dip/rewards USDC vaults are PDA token accounts created by initialize_amm
        // (NOT ATAs — the (usdcMint, ammState) ATA is usdcVault itself)
        [usdcDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), afhoMint.toBuffer()], amm.programId);
        [usdcRewards] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), afhoMint.toBuffer()], amm.programId);

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
                priceOracle: marketStatusPda, // unused in this test (no make_offers)
                dexProgram: mock.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        // mock pool + liquidity for the rewards swap
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

        // stock the offer desk vault + fund the buyer
        await mintTo(provider.connection, payer, afhoMint, afhoVault, payer.publicKey, 1_000_000 * AFHO_UNIT, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        buyerUsdc = await createAssociatedTokenAccount(provider.connection, payer, usdcMint, buyer.publicKey);
        await mintTo(provider.connection, payer, usdcMint, buyerUsdc, payer.publicKey, 1_000_000_000); // 1000 USDC

        await setPrice(10); // same units as the mock exec price (1e6/1e5)
    });

    it("loads a sheet and claims: 80/10/10 split + vesting position created", async () => {
        // sml tier: lot tier 1 = 10 AFHO, 10% discount (stored tenths), 5-day vest, 10 lots
        await amm.methods
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
                buybackBasis: new anchor.BN(0),
                untakenDays: 0,
                offerDayIndex: new anchor.BN(0), // claims require the sheet to be today's
                bigOffered: 0, bigRemaining: 0,
                medOffered: 0, medRemaining: 0,
                smlOffered: 10, smlRemaining: 10,
                bigLotTier: 0, bigDiscountBps: 0, bigVestingDays: 0,
                medLotTier: 0, medDiscountBps: 0, medVestingDays: 0,
                smlLotTier: 1, smlDiscountBps: 100, smlVestingDays: 5,
            })
            .accounts({ authority: payer.publicKey, ammState: ammStatePda, metrics: metricsPda, acceptedOffers: acceptedOffersPda, offerList: offerListPda })
            .rpc();

        await setMarket(1, 0, now()); // after-hours, day 0 (sheet day_index = 0 from init)

        // 2 lots = 20 AFHO; price 10, discount 10% -> effective 9
        // cost = 20e9 raw * 9 / 1e6 = 180_000 raw USDC
        const expectedCost = 180_000;
        const vaultBefore = await provider.connection.getTokenAccountBalance(usdcVault);
        const dipBefore = await provider.connection.getTokenAccountBalance(usdcDip);
        const rewBefore = await provider.connection.getTokenAccountBalance(usdcRewards);
        const buyerBefore = await provider.connection.getTokenAccountBalance(buyerUsdc);

        await claimTx(0, 2, 0);

        const vaultAfter = await provider.connection.getTokenAccountBalance(usdcVault);
        const dipAfter = await provider.connection.getTokenAccountBalance(usdcDip);
        const rewAfter = await provider.connection.getTokenAccountBalance(usdcRewards);
        const buyerAfter = await provider.connection.getTokenAccountBalance(buyerUsdc);

        assert.equal(Number(vaultAfter.value.amount) - Number(vaultBefore.value.amount), expectedCost * 0.8, "80% to buyback vault");
        assert.equal(Number(dipAfter.value.amount) - Number(dipBefore.value.amount), expectedCost * 0.1, "10% to dip vault");
        assert.equal(Number(rewAfter.value.amount) - Number(rewBefore.value.amount), expectedCost * 0.1, "10% to rewards vault");
        assert.equal(Number(buyerBefore.value.amount) - Number(buyerAfter.value.amount), expectedCost, "buyer charged exact total");

        // position created: 20 AFHO vesting 5 days, buyer never holds the tokens
        const [positionPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("position"), poolPda.toBuffer(), buyer.publicKey.toBuffer(), new anchor.BN(0).toArrayLike(Buffer, "le", 8)],
            staking.programId
        );
        const pos = await staking.account.stakePosition.fetch(positionPda);
        assert.equal(pos.amount.toNumber(), 20 * AFHO_UNIT);
        assert.equal(pos.daysToUnlock, 5);
        assert.equal(pos.owner.toBase58(), buyer.publicKey.toBase58());

        const pool = await staking.account.stakePool.fetch(poolPda);
        assert.equal(pool.totalStaked.toNumber(), 20 * AFHO_UNIT);

        const sheet = await amm.account.offerList.fetch(offerListPda);
        assert.equal(sheet.smlOffer.remaining, 8);
        assert.equal(sheet.totalComplete, 20);
    });


    it("rejects claims while the market is open", async () => {
        await setMarket(0, 1, now());
        await expectFail(claimTx(0, 1, 1), "DeskClosed");
        await setMarket(1, 1, now()); // back to after-hours for the next test
    });

    it("rejects a fake price oracle", async () => {
        // an attacker-controlled 8-byte "price" account
        const fake = Keypair.generate();
        await expectFail(claimTx(0, 1, 1, fake.publicKey), "address");
    });

    it("distribute_staker_rewards converts the 10% to AFHO and bumps the index", async () => {
        await setMarket(0, 2, now()); // market open, new day
        const rewBefore = await provider.connection.getTokenAccountBalance(usdcRewards);
        assert.isAbove(Number(rewBefore.value.amount), 0);

        await amm.methods
            .distributeStakerRewards()
            .accounts({
                cranker: payer.publicKey,
                ammState: ammStatePda,
                marketStatus: marketStatusPda,
                usdcRewards,
                solRewards: solRewardsPda,
                solOracle: solOraclePda,
                spotOracle: mockPricePda,
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
                stakingProgram: staking.programId,
                stakingPool: poolPda,
                stakingRewardVault: rewardVaultPda,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        const rewAfter = await provider.connection.getTokenAccountBalance(usdcRewards);
        assert.equal(Number(rewAfter.value.amount), 0, "USDC holding vault drained");

        // USDC-only distribution: 18_000 × 100_000 → 1.8e9 AFHO raw. (The SOL
        // leg is retired — rewards are USDC-denominated now.)
        const rewardVault = await provider.connection.getTokenAccountBalance(rewardVaultPda);
        assert.equal(Number(rewardVault.value.amount), 1_800_000_000, "AFHO deposited to reward vault");

        const pool = await staking.account.stakePool.fetch(poolPda);
        assert.isAbove(pool.accruedRewardPerShare.toNumber(), 0, "MasterChef index bumped");

        // once per day
        await expectFail(
            amm.methods
                .distributeStakerRewards()
                .accounts({
                    cranker: payer.publicKey,
                    ammState: ammStatePda,
                    marketStatus: marketStatusPda,
                    usdcRewards,
                    solRewards: solRewardsPda,
                    solOracle: solOraclePda,
                    spotOracle: mockPricePda,
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
                    stakingProgram: staking.programId,
                    stakingPool: poolPda,
                    stakingRewardVault: rewardVaultPda,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    token2022Program: TOKEN_2022_PROGRAM_ID,
                })
                .rpc(),
            "AlreadyDistributed"
        );
    });
});