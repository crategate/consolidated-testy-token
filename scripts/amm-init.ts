import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    NATIVE_MINT,
    createAssociatedTokenAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { pubkey, writeDeploymentState } from "./deployment-state";

// Run this AFTER mint-create (the mint account must exist; supply must NOT —
// the vaults are born empty). It:
//   1. Reads the AFHO mint from the saved keypair
//   2. Initializes the staking pool + all AMM accounts (state, offer list, vaults)
//
// Supply funding moved to scripts/fund-launch.ts (2026-09-09 launch split):
// fund-launch mints 75% straight into afho_vault + 25% into the pool seed ATA
// and revokes mint/metadata authority in one tx, so no supply ever sits in
// the authority wallet (screener concentration flags — MAINNET_CHECKLIST §5).
//
// LAUNCH_AUTHORITY=<pubkey> initializes with a different authority (e.g. a
// Squads vault PDA). authority is a Signer AND the rent payer for all state
// accounts, so a PDA authority cannot sign a plain transaction — the script
// then prints the instruction's account map for Squads instead of sending.
// Note: with a multisig AMM authority, set-pools / set_keeper /
// set-bounty-usd become multisig proposals too; the staking pool keeps the
// wallet authority (its vaults are address-pinned post-audit).

// Devnet USDC faucet mint. MAINNET: use EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
// const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // MAINNET
const USDC_MINT = new PublicKey(
    process.env.DEVNET_USDC_MINT || "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"
);

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // ── 1. Load AFHO mint (must exist after mint-create.ts) ──
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

    // ── 3b. DEX program slot (§4: legacy state field, no longer read) ──
    // AmmState.dex_program used to hold the mock-dex-pool program id; every
    // swap/pricing path now requires the pinned Raydium CPMM pool instead.
    // The field is dead but still written at init — pass the default pubkey
    // until the §4 state-field cleanup removes it.
    const DEX_PROGRAM_ID = PublicKey.default;
    console.log(" DEX program slot: default (legacy field — unused)");

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
    // Legacy oracle slots (§4: dead state fields, no longer read anywhere).
    // initializeAmm still stores them; default pubkeys until the cleanup.
    const spotOraclePda = PublicKey.default;
    const solOraclePda = PublicKey.default;
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

    // ── Authority (multisig launch override) ──
    // Default: the provider wallet is the AMM authority (devnet / simple
    // launches). LAUNCH_AUTHORITY=<pubkey> initializes with a different
    // authority (e.g. a Squads vault PDA) — every authority-gated op
    // (set-pools, set_keeper, set-bounty-usd) then requires a multisig
    // proposal. authority is a Signer AND the rent payer for all state
    // accounts, so a PDA authority cannot sign a plain transaction: the
    // script switches to PRINT MODE and emits the account map for composing
    // the Squads vault transaction instead of sending.
    const AUTHORITY = process.env.LAUNCH_AUTHORITY
        ? new PublicKey(process.env.LAUNCH_AUTHORITY)
        : provider.wallet.publicKey;
    const PRINT_MODE = !AUTHORITY.equals(provider.wallet.publicKey);

    // ── Initialize the staking pool (offer_claim / distribute CPI into it) ──
    // Was a separate `anchor run pool`; folded here so amm-init sets up the
    // whole mint-keyed stack in one pass. Idempotent-ish: skips if present.
    // (Skipped in print mode — the staking pool keeps the wallet authority;
    // run `anchor run pool` separately from the wallet.)
    if (!PRINT_MODE) {
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
                    authority: AUTHORITY,
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

    // Shared accounts for initializeAmm (normal send + print mode).
    const initializeAmmAccounts = {
        authority: AUTHORITY,
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
    };

    if (PRINT_MODE) {
        console.log("\n LAUNCH_AUTHORITY is set — PRINT MODE (nothing sent).");
        console.log(" authority is a Signer and the rent payer for every account");
        console.log(" below, so a PDA authority (e.g. a Squads vault) must execute");
        console.log(" this inside a multisig vault transaction. Compose in Squads:\n");
        console.log("   program: initialize_amm @ " + AMM_PROGRAM_ID.toBase58());
        console.log("   args:    spot_oracle=Pubkey::default(), staking_pool, sol_oracle=Pubkey::default()");
        console.log("   accounts (signer + rent payer = authority):");
        for (const [name, key] of Object.entries(initializeAmmAccounts)) {
            console.log(`     - ${name.padEnd(24)} ${(key as PublicKey).toBase58()}`);
        }
        console.log("\n   Pre-create both vault ATAs idempotently (payer=authority)");
        console.log("   before initialize_amm: afho_vault (Token-2022), usdc_vault (Token).");
        console.log("\n Staking pool init is NOT part of this tx — it keeps the wallet");
        console.log(" authority; run `anchor run pool` separately from the wallet.");
        return;
    }

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
            .accounts(initializeAmmAccounts)
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

    // ── 6. (removed 2026-09-09) Supply funding moved to scripts/fund-launch.ts ──
    // fund-launch mints straight into afho_vault + the pool-seed ATA and
    // revokes mint/metadata authority in one tx, so no supply ever sits in
    // the authority wallet (screener concentration flags — MAINNET_CHECKLIST §5).

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
