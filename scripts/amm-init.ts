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

// Run this AFTER minting NYSEH tokens. It:
//   1. Reads the NYSEH mint from the saved keypair
//   2. Creates all AMM accounts (state, offer list, vaults)
//   3. Transfers a configured % of NYSEH supply from authority → AMM vault
//
// Usage: npx ts-node scripts/init-amm.ts [PERCENTAGE_TO_TRANSFER]
//   Default percentage: 10% (0.10)

// MAINNET NOTE: change dis to mainnet 
const USDC_MINT = new PublicKey(
    process.env.DEVNET_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // ── 1. Load NYSEH mint (must exist after mint-launch.ts) ──
    const mintKeyPath = path.join(
        process.cwd(), "target", "deploy", "nyseh_token-keypair.json"
    );
    if (!fs.existsSync(mintKeyPath)) {
        throw new Error(
            "nyseh_token-keypair.json not found. Run 'anchor run mint' first."
        );
    }
    const mintKeyData = JSON.parse(fs.readFileSync(mintKeyPath, "utf-8"));
    const NYSEH_MINT = Keypair.fromSecretKey(
        new Uint8Array(mintKeyData)
    ).publicKey;
    console.log("📍 NYSEH mint:", NYSEH_MINT.toBase58());

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
    console.log("📍 AMM program:", AMM_PROGRAM_ID.toBase58());

    // ── 3. Load crank oracle program ID ──
    const crankKeyPath = path.join(
        process.cwd(), "target", "deploy", "crank_oracle-keypair.json"
    );
    const crankKeyData = JSON.parse(fs.readFileSync(crankKeyPath, "utf-8"));
    const CRANK_PROGRAM_ID = Keypair.fromSecretKey(
        new Uint8Array(crankKeyData)
    ).publicKey;
    console.log("📍 Crank oracle:", CRANK_PROGRAM_ID.toBase58());

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
    console.log("📍 DEX program (stub):", DEX_PROGRAM_ID.toBase58());

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
    console.log("📍 Staking program:", STAKING_PROGRAM_ID.toBase58());

    // ── 4. Derive all AMM PDAs ──
    const [ammStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_state"), NYSEH_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    const [offerListPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("offer_list"), NYSEH_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    const [solVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_sol_vault"), NYSEH_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    const usdcVaultAta = getAssociatedTokenAddressSync(
        USDC_MINT,
        ammStatePda,
        true,
        TOKEN_PROGRAM_ID
    );
    const nysehVaultAta = getAssociatedTokenAddressSync(
        NYSEH_MINT,
        ammStatePda,
        true,
        TOKEN_2022_PROGRAM_ID
    );
    const usdcDipAta = getAssociatedTokenAddressSync(
        USDC_MINT,
        ammStatePda,       // The authority/owner of the vault
        true,              // allowOwnerOffCurve = true (Required because ammStatePda is a PDA)
        TOKEN_PROGRAM_ID   // Standard Token Program ID
    );
    // Holding vault for the stakers' 10% USDC share (converted to NYSEH and
    // deposited into staking once per trading day by distributeStakerRewards)
    const usdcRewardsAta = getAssociatedTokenAddressSync(
        USDC_MINT,
        ammStatePda,
        true,
        TOKEN_PROGRAM_ID
    );
    // Absolute spot price (devnet stub: mock-dex-pool's mock_price PDA;
    // MAINNET: real absolute-price source in highest_buyback_basis units)
    const [spotOraclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mock_price"), NYSEH_MINT.toBuffer()],
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
        [Buffer.from("amm_sol_rewards"), NYSEH_MINT.toBuffer()],
        AMM_PROGRAM_ID
    );
    // Staking pool PDA (seeds [b"pool", mint] under the staking program)
    const [stakingPoolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), NYSEH_MINT.toBuffer()],
        STAKING_PROGRAM_ID
    );

    const [solDipPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("amm_sol_dip"),
            NYSEH_MINT.toBuffer()
        ],
        AMM_PROGRAM_ID
    );

    const [acceptedOffersPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("accepted_offers"),
            NYSEH_MINT.toBuffer()
        ],
        AMM_PROGRAM_ID
    );

    const [metricsPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metrics"),
            NYSEH_MINT.toBuffer()
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

    console.log("\n📋 Derived AMM accounts:");
    console.log("  AMM State:     ", ammStatePda.toBase58());
    console.log("  Offer List:    ", offerListPda.toBase58());
    console.log("  SOL Vault:     ", solVaultPda.toBase58());
    console.log("  USDC Vault:    ", usdcVaultAta.toBase58());
    console.log("  NYSEH Vault:   ", nysehVaultAta.toBase58());
    console.log("  Market Status: ", marketStatusPda.toBase58());

    console.log("\n📦 Checking vault accounts...");
    const preIxs = [];

    const nysehInfo = await provider.connection.getAccountInfo(nysehVaultAta);
    if (!nysehInfo) {
        console.log("  Creating NYSEH vault (Token-2022)...");
        preIxs.push(createAssociatedTokenAccountIdempotentInstruction(
            provider.wallet.publicKey, nysehVaultAta, ammStatePda,
            NYSEH_MINT, TOKEN_2022_PROGRAM_ID
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
    const usdcDipInfo = await provider.connection.getAccountInfo(usdcDipAta);
    if (!usdcDipInfo) {
        console.log("  Creating USDC dip vault (standard Token)...");
        preIxs.push(createAssociatedTokenAccountIdempotentInstruction(
            provider.wallet.publicKey, usdcDipAta, ammStatePda,
            USDC_MINT, TOKEN_PROGRAM_ID
        ));
    }
    const usdcRewardsInfo = await provider.connection.getAccountInfo(usdcRewardsAta);
    if (!usdcRewardsInfo) {
        console.log("  Creating USDC rewards holding vault (standard Token)...");
        preIxs.push(createAssociatedTokenAccountInstruction(
            provider.wallet.publicKey, usdcRewardsAta, ammStatePda,
            USDC_MINT, TOKEN_PROGRAM_ID
        ));
    }
    if (preIxs.length > 0) {
        const tx = new Transaction().add(...preIxs);
        const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = provider.wallet.publicKey;
        const sig = await provider.sendAndConfirm(tx);
        console.log("  ✅ Vaults created:", sig);
    }
    //   ── 5. Initialize AMM ──
    console.log("\n🚀 Initializing AMM accounts...");
    try {
        const tx = await ammProgram.methods
            .initializeAmm(spotOraclePda, stakingPoolPda, solOraclePda)
            .accounts({
                authority: provider.wallet.publicKey,
                nysehMint: NYSEH_MINT,
                usdcMint: USDC_MINT,
                solVault: solVaultPda,
                usdcVault: usdcVaultAta,
                nysehVault: nysehVaultAta,
                usdcDip: usdcDipAta,
                usdcRewards: usdcRewardsAta,
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

    // ── 5b. Mock DEX pool: state, prices, NYSEH float (DEVNET STUB) ──
    // MAINNET: delete this section — the real DEX pool replaces it and
    // spot/sol oracles become real feeds.
    console.log("\n🧪 Setting up mock DEX pool (devnet stub)...");
    const mockIdl = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), "target", "idl", "mock_dex_pool.json"), "utf-8"
    ));
    const mockProgram = new anchor.Program(mockIdl, provider);
    const [poolStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mock_pool"), NYSEH_MINT.toBuffer()],
        DEX_PROGRAM_ID
    );
    const poolNysehAta = getAssociatedTokenAddressSync(
        NYSEH_MINT, poolStatePda, true, TOKEN_2022_PROGRAM_ID
    );
    const poolUsdcAta = getAssociatedTokenAddressSync(
        USDC_MINT, poolStatePda, true, TOKEN_PROGRAM_ID
    );
    try {
        const tx = await mockProgram.methods
            .initPool()
            .accounts({
                payer: provider.wallet.publicKey,
                nysehMint: NYSEH_MINT,
                usdcMint: USDC_MINT,
                poolState: poolStatePda,
                poolNyseh: poolNysehAta,
                poolUsdc: poolUsdcAta,
                associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();
        console.log("  ✅ Mock pool initialized:", tx);
    } catch (e: any) {
        if (e.message?.includes("already in use")) {
            console.log("  ⚠️  Mock pool already initialized.");
        } else {
            throw e;
        }
    }

    // Mock prices, units (usdc_raw × 1e6) / nyseh_raw:
    //   NYSEH spot 10 = 0.01 USDC/NYSEH at 9/6 decimals (matches mock exec rate)
    //   SOL         200_000 = $200/SOL (200e6 usdc-raw × 1e6 / 1e9 lamports)
    const MOCK_NYSEH_PRICE = new anchor.BN(process.env.MOCK_NYSEH_PRICE || "10");
    const MOCK_SOL_PRICE = new anchor.BN(process.env.MOCK_SOL_PRICE || "200000");
    await mockProgram.methods
        .setPrice(MOCK_NYSEH_PRICE)
        .accounts({
            payer: provider.wallet.publicKey,
            nysehMint: NYSEH_MINT,
            mockPrice: spotOraclePda,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    console.log(`  ✅ NYSEH spot price set to ${MOCK_NYSEH_PRICE}`);
    await mockProgram.methods
        .setPrice(MOCK_SOL_PRICE)
        .accounts({
            payer: provider.wallet.publicKey,
            nysehMint: NATIVE_MINT, // wSOL mint seeds the SOL/USD price PDA
            mockPrice: solOraclePda,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    console.log(`  ✅ SOL price set to ${MOCK_SOL_PRICE}`);

    // Fund the pool's NYSEH float so buys can be filled (top up only if empty)
    const poolFloatInfo = await provider.connection.getAccountInfo(poolNysehAta);
    if (poolFloatInfo) {
        const poolBal = await getAccount(
            provider.connection, poolNysehAta, "confirmed", TOKEN_2022_PROGRAM_ID
        );
        if (poolBal.amount === BigInt(0)) {
            const floatWhole = new anchor.BN(process.env.MOCK_POOL_FLOAT_NYSEH || "1000000");
            const floatRaw = floatWhole.mul(new anchor.BN(1_000_000_000)); // 9 decimals
            const authorityNysehAta = getAssociatedTokenAddressSync(
                NYSEH_MINT, provider.wallet.publicKey, false, TOKEN_2022_PROGRAM_ID
            );
            const fundTx = new Transaction().add(createTransferCheckedInstruction(
                authorityNysehAta, NYSEH_MINT, poolNysehAta,
                provider.wallet.publicKey, BigInt(floatRaw.toString()), 9, [],
                TOKEN_2022_PROGRAM_ID
            ));
            const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
            fundTx.recentBlockhash = blockhash;
            fundTx.feePayer = provider.wallet.publicKey;
            const sig = await provider.sendAndConfirm(fundTx);
            console.log(`  ✅ Pool float funded with ${floatWhole} NYSEH:`, sig);
        } else {
            console.log("  ⚠️  Pool float already funded, skipping.");
        }
    }

    // ── 6. Transfer NYSEH from authority → AMM vault ──
    const transferPct = parseFloat(process.argv[2] || "0.10"); // default 10%
    if (transferPct > 0) {
        console.log(`\n💸 Transferring ${(transferPct * 100).toFixed(0)}% of supply to AMM vault...`);

        const authorityNysehAta = getAssociatedTokenAddressSync(
            NYSEH_MINT,
            provider.wallet.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID
        );

        // Check authority balance
        const authorityAccount = await getAccount(
            provider.connection,
            authorityNysehAta,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
        );
        const authorityBalance = Number(authorityAccount.amount);
        console.log(`   Authority balance: ${(authorityBalance / 1e9).toFixed(4)} NYSEH`);

        const transferAmount = Math.floor(authorityBalance * transferPct);
        console.log(`   Transfer amount:   ${(transferAmount / 1e9).toFixed(4)} NYSEH`);

        if (transferAmount > 0) {
            const transferIx = createTransferCheckedInstruction(
                authorityNysehAta,          // from
                NYSEH_MINT,                  // mint
                nysehVaultAta,               // to
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
            console.log(`✅ Transferred! Tx: ${sig}`);
        } else {
            console.log("⚠️  Nothing to transfer (balance is zero).");
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
        ammNysehVault: pubkey(nysehVaultAta),
    });

    console.log("\n🎉 AMM setup complete!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});