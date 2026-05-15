
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Staking } from "../target/types/staking";
import { CrankOracle } from "../target/types/crank_oracle";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
    createMint,
    mintTo,
    createAssociatedTokenAccount,
    getAssociatedTokenAddressSync,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

// =============================================================================
// STAKING TEST SUITE
// =============================================================================
// Run with: anchor test --skip-build
//
// This test suite covers:
//   - Pool initialization
//   - Staking during market open
//   - Claiming with no penalty (state 0)
//   - Claiming with penalty (states 1, 2, 3)
//   - Unstaking with penalty
//   - Penalty distribution via realize_penalties
// =============================================================================

describe("NYSEH Staking", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const stakingProgram = anchor.workspace.Staking as Program<Staking>;
    const crankProgram = anchor.workspace.CrankOracle as Program<CrankOracle>;

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

    const BASE_APY = 1000;        // 10%
    const MAX_MULT = 30000;       // 3.0x
    const POSR_TAX = 500;         // 5%
    const AH_PENALTY = 500;       // 5%
    const CLOSED_PENALTY = 1500;  // 15%
    const HALTED_PENALTY = 3000;  // 30%

    before(async () => {
        // Create test mint
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

        // Create token accounts
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

        // Mint tokens to user
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

        // Derive PDAs
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
            // May already be initialized
        }
        const status = await crankProgram.account.marketStatus.fetch(marketStatusPda);
        console.log("Initial state:", status.currentState);
    });

    it("Initializes the staking pool", async () => {
        await stakingProgram.methods
            .initializePool(
                crankProgram.programId,
                BASE_APY,
                MAX_MULT,
                POSR_TAX,
                AH_PENALTY,
                CLOSED_PENALTY,
                HALTED_PENALTY,
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
        expect(pool.baseApyBps).toEqual(BASE_APY);
        expect(pool.totalStaked.toNumber()).toEqual(0);
    });

    it("Deposits rewards into the pool", async () => {
        await stakingProgram.methods
            .depositRewards(new anchor.BN(100_000 * 10 ** 9))
            .accounts({
                authority: provider.wallet.publicKey,
                mint,
                pool: poolPda,
                rewardVault: rewardVaultPda,
                authorityToken: adminToken,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        const vault = await provider.connection.getTokenAccountBalance(rewardVaultPda);
        expect(Number(vault.value.amount)).toBeGreaterThan(0);
    });

    it("User stakes tokens during market open", async () => {
        const [userIndexPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_index"), userKeypair.publicKey.toBuffer()],
            stakingProgram.programId
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("position"),
                poolPda.toBuffer(),
                userKeypair.publicKey.toBuffer(),
                new anchor.BN(0).toArrayLike(Buffer, "le", 8),
            ],
            stakingProgram.programId
        );

        await stakingProgram.methods
            .stake(new anchor.BN(10_000 * 10 ** 9), new anchor.BN(0))
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
        expect(pool.totalStaked.toNumber()).toBeGreaterThan(0);
    });

    // TODO: Add tests for claim with penalties, unstake, realize_penalties
    // These require mocking the market status state transitions
});
