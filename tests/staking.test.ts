import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Staking } from "../target/types/staking";
import { CrankOracle } from "../target/types/crank_oracle";
import { Amm } from "../target/types/amm";
import { expect } from "chai";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
    createMint,
    mintTo,
    createAssociatedTokenAccount,
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

describe("AFHO Staking", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const stakingProgram = anchor.workspace.Staking as Program<Staking>;
    const crankProgram = anchor.workspace.CrankOracle as Program<CrankOracle>;
    const ammProgram = anchor.workspace.Amm as Program<Amm>;

    let mint: PublicKey;
    let adminToken: PublicKey;
    let userToken: PublicKey;
    let userKeypair: Keypair;
    let poolPda: PublicKey;
    let marketStatusPda: PublicKey;
    let vaultPda: PublicKey;
    let rewardVaultPda: PublicKey;
    let penaltyVaultPda: PublicKey;
    let posrVaultPda: PublicKey;
    let bondVaultPda: PublicKey;

    const MAX_MULT = 30000;
    const POSR_TAX = 500;
    const AH_PENALTY = 300;
    const CLOSED_PENALTY = 600;
    const HALTED_PENALTY = 3000;

    // Helper: set market state via the crank oracle's test instruction
    async function setMarketState(state: number) {
        await crankProgram.methods
            .testSetState(state, new anchor.BN(0), new anchor.BN(0))
            .accounts({ marketStatus: marketStatusPda })
            .rpc();
        const status = await crankProgram.account.marketStatus.fetch(marketStatusPda);
        console.log(`Market state set to: ${status.currentState} (day #${status.tradingDayIndex})`);
    }

    // Helper: derive a position PDA for the user
    function getPositionPda(owner: PublicKey, index: number): PublicKey {
        return PublicKey.findProgramAddressSync([
            Buffer.from("position"),
            poolPda.toBuffer(),
            owner.toBuffer(),
            new anchor.BN(index).toArrayLike(Buffer, "le", 8),
        ], stakingProgram.programId)[0];
    }

    before(async () => {
        mint = await createMint(
            provider.connection,
            (provider.wallet as anchor.Wallet).payer,
            provider.wallet.publicKey,
            null,
            9,
            undefined,
            undefined,
            TOKEN_2022_PROGRAM_ID
        );

        adminToken = await createAssociatedTokenAccount(
            provider.connection,
            (provider.wallet as anchor.Wallet).payer,
            mint,
            provider.wallet.publicKey,
            undefined,
            TOKEN_2022_PROGRAM_ID
        );

        userKeypair = Keypair.generate();
        await provider.connection.requestAirdrop(userKeypair.publicKey, 1_000_000_000);

        userToken = await createAssociatedTokenAccount(
            provider.connection,
            (provider.wallet as anchor.Wallet).payer,
            mint,
            userKeypair.publicKey,
            undefined,
            TOKEN_2022_PROGRAM_ID
        );

        await mintTo(
            provider.connection,
            (provider.wallet as anchor.Wallet).payer,
            mint,
            userToken,
            provider.wallet.publicKey,
            1_000_000 * 10 ** 9,
            undefined,
            undefined,
            TOKEN_2022_PROGRAM_ID
        );

        [poolPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool"), mint.toBuffer()],
            stakingProgram.programId
        );
        [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolPda.toBuffer()],
            stakingProgram.programId
        );
        [rewardVaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("rewards"), poolPda.toBuffer()],
            stakingProgram.programId
        );
        [penaltyVaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("penalties"), poolPda.toBuffer()],
            stakingProgram.programId
        );
        [posrVaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("posr"), poolPda.toBuffer()],
            stakingProgram.programId
        );
        // AMM bond vault — the AFHO ATA of the amm_state PDA. Claim/unstake
        // penalty legs (5%) must land here. Created off-curve like amm-init.
        const [ammStatePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("amm_state"), mint.toBuffer()],
            ammProgram.programId
        );
        bondVaultPda = getAssociatedTokenAddressSync(mint, ammStatePda, true, TOKEN_2022_PROGRAM_ID);
        const bondAtaTx = new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(
                provider.wallet.publicKey,
                bondVaultPda,
                ammStatePda,
                mint,
                TOKEN_2022_PROGRAM_ID
            )
        );
        bondAtaTx.recentBlockhash = (await provider.connection.getLatestBlockhash("confirmed")).blockhash;
        bondAtaTx.feePayer = provider.wallet.publicKey;
        await provider.sendAndConfirm(bondAtaTx);
        [marketStatusPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("market_status")],
            crankProgram.programId
        );
    });

    it("Initializes the crank oracle market status", async () => {
        try {
            await crankProgram.methods
                .initializeState()
                .accounts({
                    marketStatus: marketStatusPda,
                    payer: provider.wallet.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
        } catch (e) {
            // may already exist
        }
        const status = await crankProgram.account.marketStatus.fetch(marketStatusPda);
        console.log("Initial state:", status.currentState);
    });

    it("Initializes the staking pool", async () => {
        await stakingProgram.methods
            .initializePool(
                crankProgram.programId,
                MAX_MULT,
                POSR_TAX,
                AH_PENALTY,
                CLOSED_PENALTY,
                HALTED_PENALTY,
                ammProgram.programId,
            )
            .accounts({
                authority: provider.wallet.publicKey,
                mint,
                pool: poolPda,
                vault: vaultPda,
                rewardVault: rewardVaultPda,
                penaltyVault: penaltyVaultPda,
                posrVault: posrVaultPda,
                marketStatusPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        const pool = await stakingProgram.account.stakePool.fetch(poolPda);
        expect(pool.maxMultiplierBps).equal(MAX_MULT);
        expect(pool.totalStaked.toNumber()).equal(0);
    });

    it("User stakes tokens during market open", async () => {
        await setMarketState(0); // ensure open

        const [userIndexPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_index"), userKeypair.publicKey.toBuffer()],
            stakingProgram.programId
        );
        const positionPda = getPositionPda(userKeypair.publicKey, 0);

        await stakingProgram.methods
            .stake(new anchor.BN(10_000 * 10 ** 9), new anchor.BN(0), 0)
            .accounts({
                owner: userKeypair.publicKey,
                mint,
                pool: poolPda,
                userIndex: userIndexPda,
                position: positionPda,
                ownerToken: userToken,
                vault: vaultPda,
                marketStatus: marketStatusPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([userKeypair])
            .rpc();

        const pool = await stakingProgram.account.stakePool.fetch(poolPda);
        expect(pool.totalStaked.toNumber()).to.be.greaterThan(0);

        const pos = await stakingProgram.account.stakePosition.fetch(positionPda);
        expect(pos.amount.toNumber()).equal(10_000 * 10 ** 9);
        expect(pos.index.toNumber()).equal(0);
    });

    it("Claims rewards during market open with no penalty", async () => {
        await setMarketState(0);

        // Seed penalty vault so realize_penalties can bootstrap the reward index
        await mintTo(
            provider.connection,
            (provider.wallet as anchor.Wallet).payer,
            mint,
            penaltyVaultPda,
            provider.wallet.publicKey,
            5_000 * 10 ** 9,
            undefined,
            undefined,
            TOKEN_2022_PROGRAM_ID
        );

        // Move penalties into reward vault and update MasterChef index
        await stakingProgram.methods
            .realizePenalties()
            .accounts({
                pool: poolPda,
                mint,
                penaltyVault: penaltyVaultPda,
                rewardVault: rewardVaultPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        const poolAfterRealize = await stakingProgram.account.stakePool.fetch(poolPda);
        expect(poolAfterRealize.accruedRewardPerShare.toNumber()).to.be.greaterThan(0);

        const positionPda = getPositionPda(userKeypair.publicKey, 0);
        const userTokenBefore = await provider.connection.getTokenAccountBalance(userToken);

        await stakingProgram.methods
            .claim()
            .accounts({
                owner: userKeypair.publicKey,
                mint,
                pool: poolPda,
                position: positionPda,
                rewardVault: rewardVaultPda,
                bondVault: bondVaultPda,
                ownerToken: userToken,
                marketStatus: marketStatusPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            })
            .signers([userKeypair])
            .rpc();

        const pos = await stakingProgram.account.stakePosition.fetch(positionPda);
        expect(pos.lastClaimTimestamp.toNumber()).to.be.greaterThan(0);

        const userTokenAfter = await provider.connection.getTokenAccountBalance(userToken);
        expect(Number(userTokenAfter.value.amount)).to.be.greaterThan(Number(userTokenBefore.value.amount));
    });

    it("Rejects claims outside market-open state", async () => {
        await setMarketState(1); // after hours

        // Add more rewards to the pool index first
        await mintTo(provider.connection, (provider.wallet as anchor.Wallet).payer, mint, penaltyVaultPda, provider.wallet.publicKey, 1_000 * 10 ** 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        await stakingProgram.methods.realizePenalties().accounts({ pool: poolPda, mint, penaltyVault: penaltyVaultPda, rewardVault: rewardVaultPda, tokenProgram: TOKEN_2022_PROGRAM_ID }).rpc();

        const positionPda = getPositionPda(userKeypair.publicKey, 0);
        try {
            await stakingProgram.methods
                .claim()
                .accounts({
                    owner: userKeypair.publicKey,
                    mint,
                    pool: poolPda,
                    position: positionPda,
                    rewardVault: rewardVaultPda,
                    bondVault: bondVaultPda,
                    ownerToken: userToken,
                    marketStatus: marketStatusPda,
                    tokenProgram: TOKEN_2022_PROGRAM_ID,
                })
                .signers([userKeypair])
                .rpc();
            throw new Error("Expected claim to fail");
        } catch (e: any) {
            expect(e.toString()).to.contain("Claims are only available");
        }
    });

    it("Unstakes with penalty during closed market and closes position", async () => {
        await setMarketState(2); // closed

        const poolBefore = await stakingProgram.account.stakePool.fetch(poolPda);
        const totalStakedBefore = poolBefore.totalStaked.toNumber();
        const bondBefore = await provider.connection.getTokenAccountBalance(bondVaultPda);

        const positionPda = getPositionPda(userKeypair.publicKey, 0);
        const userTokenBefore = await provider.connection.getTokenAccountBalance(userToken);

        await stakingProgram.methods
            .unstake()
            .accounts({
                owner: userKeypair.publicKey,
                mint,
                pool: poolPda,
                position: positionPda,
                vault: vaultPda,
                rewardVault: rewardVaultPda,
                penaltyVault: penaltyVaultPda,
                bondVault: bondVaultPda,
                ownerToken: userToken,
                marketStatus: marketStatusPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            })
            .signers([userKeypair])
            .rpc();

        const poolAfter = await stakingProgram.account.stakePool.fetch(poolPda);
        expect(poolAfter.totalStaked.toNumber()).to.be.lessThan(totalStakedBefore);
        // 5% POSR legs (reward tax + 5% of the closed-market principal
        // penalty, plus the last-staker 95% fallback) must refill the AMM
        // bond vault.
        const bondAfter = await provider.connection.getTokenAccountBalance(bondVaultPda);
        expect(Number(bondAfter.value.amount)).to.be.greaterThan(Number(bondBefore.value.amount));

        // Position account should have been closed (rent refunded)
        try {
            await stakingProgram.account.stakePosition.fetch(positionPda);
            throw new Error("Expected position to be closed");
        } catch (e: any) {
            expect(e.toString()).to.contain("Account does not exist");
        }

        const userTokenAfter = await provider.connection.getTokenAccountBalance(userToken);
        // User got principal back + net rewards - penalties
        expect(Number(userTokenAfter.value.amount)).to.be.greaterThan(Number(userTokenBefore.value.amount));
    });

    it("L2: rejects a stake with an out-of-sequence position index", async () => {
        await setMarketState(0);

        const [userIndexPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_index"), userKeypair.publicKey.toBuffer()],
            stakingProgram.programId
        );
        // user_index.next_index is 1 after the first stake — index 5 must fail
        const positionPda = getPositionPda(userKeypair.publicKey, 5);
        try {
            await stakingProgram.methods
                .stake(new anchor.BN(1_000 * 10 ** 9), new anchor.BN(5), 0)
                .accounts({
                    owner: userKeypair.publicKey,
                    mint,
                    pool: poolPda,
                    userIndex: userIndexPda,
                    position: positionPda,
                    ownerToken: userToken,
                    vault: vaultPda,
                    marketStatus: marketStatusPda,
                    tokenProgram: TOKEN_2022_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([userKeypair])
                .rpc();
            throw new Error("Expected stake with bad index to fail");
        } catch (e: any) {
            expect(e.toString()).to.contain("next free index");
        }
    });

    it("L3: rejects a pool init with penalty bps above 10_000", async () => {
        const mint2 = await createMint(
            provider.connection,
            (provider.wallet as anchor.Wallet).payer,
            provider.wallet.publicKey,
            null,
            9,
            undefined,
            undefined,
            TOKEN_2022_PROGRAM_ID
        );
        const [pool2] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool"), mint2.toBuffer()],
            stakingProgram.programId
        );
        const [vault2] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), pool2.toBuffer()],
            stakingProgram.programId
        );
        const [reward2] = PublicKey.findProgramAddressSync(
            [Buffer.from("rewards"), pool2.toBuffer()],
            stakingProgram.programId
        );
        const [penalty2] = PublicKey.findProgramAddressSync(
            [Buffer.from("penalties"), pool2.toBuffer()],
            stakingProgram.programId
        );
        const [posr2] = PublicKey.findProgramAddressSync(
            [Buffer.from("posr"), pool2.toBuffer()],
            stakingProgram.programId
        );
        try {
            await stakingProgram.methods
                .initializePool(
                    crankProgram.programId,
                    MAX_MULT,
                    POSR_TAX,
                    15_000, // > 10_000 bps: the L3 guard must reject this
                    CLOSED_PENALTY,
                    HALTED_PENALTY,
                    ammProgram.programId,
                )
                .accounts({
                    authority: provider.wallet.publicKey,
                    mint: mint2,
                    pool: pool2,
                    vault: vault2,
                    rewardVault: reward2,
                    penaltyVault: penalty2,
                    posrVault: posr2,
                    marketStatusPda,
                    tokenProgram: TOKEN_2022_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            throw new Error("Expected pool init with bad bps to fail");
        } catch (e: any) {
            expect(e.toString()).to.contain("exceeds 10_000");
        }
    });
});
