import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    NATIVE_MINT,
    createTransferCheckedInstruction,
    createAssociatedTokenAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
    getAccount,
} from "@solana/spl-token";
import { pubkey, writeDeploymentState } from "./deployment-state";

// Run this AFTER minting AFHO tokens. It:
//   1. Reads the AFHO mint from the saved keypair
//   2. Creates all AMM accounts (state, offer list, vaults)
//   3. Transfers a configured % of AFHO supply from authority → AMM vault
//
// Usage: npx ts-node scripts/init-amm.ts [PERCENTAGE_TO_TRANSFER]
//   Default percentage: 10% (0.10)

// Devnet USDC faucet mint. MAINNET: use EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
// const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // MAINNET
const USDC_MINT = new PublicKey(
    process.env.DEVNET_USDC_MINT || "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"
);

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // ── 1. Load AFHO mint (must exist after mint-launch.ts) ──
    const mintKeyPath = path.join(
        process.cwd(), "target", "deploy", "afho_token-keypair.json"
    );
    if (!fs.existsSync(mintKeyPath)) {
        throw new Error(
            "afho_token-keypair.json not found. Run 'anchor run mint' first."
        );
    }
    const mintKeyData = JSON.parse(fs.readFileSync(mintKeyPath, "utf-8"));
    const AFHO_MINT = Keypair.fromSecretKey(
        new Uint8Array(mintKeyData)
    ).publicKey;
    console.log(" AFHO mint:", AFHO_MINT.toBase58());

    // ── 2. Load AMM program ──
    const ammIdlPath = path.join(process.cwd(), "target", "idl", "amm.json");
    if (!fs.existsSync(ammIdlPath)) {
        throw new Error("amm.json IDL not found. Run 'anchor build' first.");
    }
    const ammIdl = JSON.parse(fs.readFileSync(ammIdlPath, "utf-8"));

    const ammKeyPath = path.join(
        process.cwd(), "target", "deploy", "amm-keypair.json"
    );
    const ammKeyData = JSON.parse(fs.readFileSync(ammKeyPath, "utf-8"));
    const AMM_PROGRAM_ID = Keypair.fromSecretKey(
        new Uint8Array(ammKeyData)
    ).publicKey;
    const ammProgram = new anchor.Program(ammIdl, provider);
    console.log(" AMM program:", AMM_PROGRAM_ID.toBase58());

    // ── 3. Load crank oracle program ID ──
    const crankKeyPath = path.join(
        process.cwd(), "target", "deploy", "crank_oracle-keypair.json"
    );
    const crankKeyData = JSON.parse(fs.readFileSync(crankKeyPath, "utf-8"));
    const CRANK_PROGRAM_ID = Keypair.fromSecretKey(
        new Uint8Array(crankKeyData)
    ).publicKey;
    console.log(" Crank oracle:", CRANK_PROGRAM_ID.toBase58());

    // ── 3b. DEX swap target (mock-dex-pool stub for devnet; real DEX at launch) ──
    const mockPoolKeyPath = path.join(
        process.cwd(), "target", "deploy", "mock_dex_pool-keypair.json"
    );
    if (!fs.existsSync(mockPoolKeyPath)) {
        throw new Error("mock_dex_pool-keypair.json not found. Run 'anchor build' first.");
    }
    const DEX_PROGRAM_ID = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(mockPoolKeyPath, "utf-8")))
    ).publicKey;
    console.log(" DEX program (stub):", DEX_PROGRAM_ID.toBase58());

    // ── 3c. Staking program + pool (offer_claim CPIs into it; run pool-init first) ──
    const stakingKeyPath = path.join(
        process.cwd(), "target", "deploy", "staking-keypair.json"
    );
    if (!fs.existsSync(stakingKeyPath)) {
        throw new Error("staking-keypair.json not found. Run 'anchor build' first.");
    }
    const STAKING_PROGRAM_ID = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(stakingKeyPath, "utf-8")))
    ).publicKey;
    console.log(" Staking program:", STAKING_PROGRAM_ID.toBase58());

    // ── 4. Derive all AMM PDAs ──
    const [ammStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_state"), AFHO_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    const [offerListPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("offer_list"), AFHO_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    const [solVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_sol_vault"), AFHO_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    const usdcVaultAta = getAssociatedTokenAddressSync(
        USDC_MINT,
        ammStatePda,
        true,
        TOKEN_PROGRAM_ID
    );
    const afhoVaultAta = getAssociatedTokenAddressSync(
        AFHO_MINT,
        ammStatePda,
        true,
        TOKEN_2022_PROGRAM_ID
    );
    // 10% dip reserve + 10% staker-rewards holding vault: PDA token accounts
    // created by initialize_amm itself (NOT ATAs — the (USDC, ammState) ATA is
    // the buyback vault, so ATA-based dip/rewards vaults would alias it).
    const [usdcDipPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_usdc_dip"), AFHO_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    const [usdcRewardsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_usdc_rewards"), AFHO_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    // Absolute spot price (devnet stub: mock-dex-pool's mock_price PDA;
    // MAINNET: real absolute-price source in highest_buyback_basis units)
    const [spotOraclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mock_price"), AFHO_MINT.toBuffer()],
        DEX_PROGRAM_ID
    );
    // SOL/USD price — same raw-u64 mock pattern, seeded with the wSOL mint.
    // MAINNET: real SOL/USD feed.
    const [solOraclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mock_price"), NATIVE_MINT.toBuffer()],
        DEX_PROGRAM_ID
    );
    // Holding PDA for the stakers' 10% share of SOL claim proceeds
    const [solRewardsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_sol_rewards"), AFHO_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    // Staking pool PDA (seeds [b"pool", mint] under the staking program)
    const [stakingPoolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), AFHO_MINT.toBuffer()],
        STAKING_PROGRAM_ID
    );

    // ── Initialize the staking pool (offer_claim / distribute CPI into it) ──
    // Was a separate `anchor run pool`; folded here so amm-init sets up the
    // whole mint-keyed stack in one pass. Idempotent-ish: skips if present.
    {
        const stakingIdl = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), "target", "idl", "staking.json"), "utf-8")
        );
        const stakingProgram = new anchor.Program(stakingIdl as anchor.Idl, provider);
        const [stakingMarketStatusPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("market_status")], CRANK_PROGRAM_ID
        );
        const [stakingVaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), stakingPoolPda.toBuffer()], STAKING_PROGRAM_ID
        );
        const [stakingRewardPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("rewards"), stakingPoolPda.toBuffer()], STAKING_PROGRAM_ID
        );
        const [stakingPenaltyPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("penalties"), stakingPoolPda.toBuffer()], STAKING_PROGRAM_ID
        );
        const [stakingPosrPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("posr"), stakingPoolPda.toBuffer()], STAKING_PROGRAM_ID
        );
        try {
            await stakingProgram.methods
                .initializePool(CRANK_PROGRAM_ID, 30000, 500, 300, 600, 1800, AMM_PROGRAM_ID)
                .accounts({
                    authority: provider.wallet.publicKey,
                    mint: AFHO_MINT,
                    pool: stakingPoolPda,
                    vault: stakingVaultPda,
                    rewardVault: stakingRewardPda,
                    penaltyVault: stakingPenaltyPda,
                    posrVault: stakingPosrPda,
                    marketStatusPda: stakingMarketStatusPda,
                    tokenProgram: TOKEN_2022_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();
            console.log("   Staking pool initialized:", stakingPoolPda.toBase58());
        } catch (e) {
            console.log("  !! Staking pool already initialized (or failed):", (e as Error).message);
        }
        writeDeploymentState({
            pool: stakingPoolPda.toBase58(),
            vault: stakingVaultPda.toBase58(),
            rewardVault: stakingRewardPda.toBase58(),
            penaltyVault: stakingPenaltyPda.toBase58(),
            posrVault: stakingPosrPda.toBase58(),
        });
    }

    const [solDipPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("amm_sol_dip"),
            AFHO_MINT.toBuffer()
        ],
        AMM_PROGRAM_ID
    );

    const [acceptedOffersPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("accepted_offers"),
            AFHO_MINT.toBuffer()
        ],
        AMM_PROGRAM_ID
    );

    const [metricsPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metrics"),
            AFHO_MINT.toBuffer()
        ],
        AMM_PROGRAM_ID
    ); const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        CRANK_PROGRAM_ID
    );

    // Canonical Switchboard quote account ([market_status, price] feeds) — run feed-deploy first
    const deploymentPath = path.join(process.cwd(), "app", "public", "deployment.json");
    const deployment = fs.existsSync(deploymentPath)
        ? JSON.parse(fs.readFileSync(deploymentPath, "utf-8"))
        : {};
    if (!deployment.oracleQuoteAccount) {
        throw new Error("oracleQuoteAccount missing from deployment.json. Run 'anchor run feed-deploy' first.");
    }
    const priceOracle = new PublicKey(deployment.oracleQuoteAccount);

    console.log("\n Derived AMM accounts:");
    console.log("  AMM State:     ", ammStatePda.toBase58());
    console.log("  Offer List:    ", offerListPda.toBase58());
    console.log("  SOL Vault:     ", solVaultPda.toBase58());
    console.log("  USDC Vault:    ", usdcVaultAta.toBase58());
    console.log("  AFHO Vault:   ", afhoVaultAta.toBase58());
    console.log("  Market Status: ", marketStatusPda.toBase58());

    console.log("\n Checking vault accounts...");
    const preIxs = [];

    const afhoInfo = await provider.connection.getAccountInfo(afhoVaultAta);
    if (!afhoInfo) {
        console.log("  Creating AFHO vault (Token-2022)...");
        preIxs.push(createAssociatedTokenAccountIdempotentInstruction(
            provider.wallet.publicKey, afhoVaultAta, ammStatePda,
            AFHO_MINT, TOKEN_2022_PROGRAM_ID
        ));
    }

    const usdcInfo = await provider.connection.getAccountInfo(usdcVaultAta);
    if (!usdcInfo) {
        console.log("  Creating USDC vault (standard Token)...");
        preIxs.push(createAssociatedTokenAccountIdempotentInstruction(
            provider.wallet.publicKey, usdcVaultAta, ammStatePda,
            USDC_MINT, TOKEN_PROGRAM_ID  // <-- Standard Token
        ));
    }
    // USDC dip/rewards vaults are created by initialize_amm (PDA token accounts) —
    // no pre-creation here.
    if (preIxs.length > 0) {
        const tx = new Transaction().add(...preIxs);
        const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = provider.wallet.publicKey;
        const sig = await provider.sendAndConfirm(tx);
        console.log("   Vaults created:", sig);
    }
    //   ── 5. Initialize AMM ──
    console.log("\n Initializing AMM accounts...");
    try {
        const tx = await ammProgram.methods
            .initializeAmm(spotOraclePda, stakingPoolPda, solOraclePda)
            .accounts({
                authority: provider.wallet.publicKey,
                afhoMint: AFHO_MINT,
                usdcMint: USDC_MINT,
                solVault: solVaultPda,
                usdcVault: usdcVaultAta,
                afhoVault: afhoVaultAta,
                usdcDip: usdcDipPda,
                usdcRewards: usdcRewardsPda,
                solRewards: solRewardsPda,
                solDip: solDipPda,
                ammState: ammStatePda,
                offerList: offerListPda,
                acceptedOffers: acceptedOffersPda,
                metrics: metricsPda,
                marketStatusPda: marketStatusPda,
                crankProgram: CRANK_PROGRAM_ID,
                priceOracle: priceOracle,
                dexProgram: DEX_PROGRAM_ID,
                associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();

        console.log(" AMM initialized! Tx:", tx);
    } catch (e: any) {
        if (e.message?.includes("already in use")) {
            console.log("  AMM already initialized.");
        } else {
            console.error("XXXX AMM init failed:", e);
            process.exit(1);
        }
    }

    // ── 6. Transfer AFHO from authority → AMM vault ──
    const transferPct = parseFloat(process.argv[2] || "0.99"); // mainnet 1.0 for 100 percent
    if (transferPct > 0) {
        console.log(`\n Transferring ${(transferPct * 100).toFixed(0)}% of supply to AMM vault...`);

        const authorityAfhoAta = getAssociatedTokenAddressSync(
            AFHO_MINT,
            provider.wallet.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID
        );

        // Check authority balance
        const authorityAccount = await getAccount(
            provider.connection,
            authorityAfhoAta,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
        );
        const authorityBalance = Number(authorityAccount.amount);
        console.log(`   Authority balance: ${(authorityBalance / 1e9).toFixed(4)} AFHO`);

        const transferAmount = Math.floor(authorityBalance * transferPct);
        console.log(`   Transfer amount:   ${(transferAmount / 1e9).toFixed(4)} AFHO`);

        if (transferAmount > 0) {
            const transferIx = createTransferCheckedInstruction(
                authorityAfhoAta,          // from
                AFHO_MINT,                  // mint
                afhoVaultAta,               // to
                provider.wallet.publicKey,   // authority (signer)
                BigInt(transferAmount),      // amount
                9,        // decimals
                undefined,
                TOKEN_2022_PROGRAM_ID
            );

            const tx = new Transaction().add(transferIx);
            const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
            tx.recentBlockhash = blockhash;
            tx.feePayer = provider.wallet.publicKey;

            const sig = await provider.sendAndConfirm(tx);
            console.log(` Transferred! Tx: ${sig}`);
        } else {
            console.log("!! Nothing to transfer (balance is zero).");
        }
    }

    // ── 7. Write deployment state ──
    writeDeploymentState({
        cluster: "devnet",
        ammProgram: pubkey(AMM_PROGRAM_ID),
        ammState: pubkey(ammStatePda),
        ammOfferList: pubkey(offerListPda),
        ammSolVault: pubkey(solVaultPda),
        ammUsdcVault: pubkey(usdcVaultAta),
        ammAfhoVault: pubkey(afhoVaultAta),
    });

    console.log("\n AMM setup complete!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
