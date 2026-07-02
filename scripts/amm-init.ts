import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createTransferCheckedInstruction,
    createAssociatedTokenAccountInstruction,
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
    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        CRANK_PROGRAM_ID
    );

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
        preIxs.push(createAssociatedTokenAccountInstruction(
            provider.wallet.publicKey, nysehVaultAta, ammStatePda,
            NYSEH_MINT, TOKEN_2022_PROGRAM_ID
        ));
    }

    const usdcInfo = await provider.connection.getAccountInfo(usdcVaultAta);
    if (!usdcInfo) {
        console.log("  Creating USDC vault (standard Token)...");
        preIxs.push(createAssociatedTokenAccountInstruction(
            provider.wallet.publicKey, usdcVaultAta, ammStatePda,
            USDC_MINT, TOKEN_PROGRAM_ID  // <-- Standard Token
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
    // ── 5. Initialize AMM ──
    console.log("\n🚀 Initializing AMM accounts...");
    try {
        const tx = await ammProgram.methods
            .initializeAmm()
            .accounts({
                authority: provider.wallet.publicKey,
                nysehMint: NYSEH_MINT,
                usdcMint: USDC_MINT,
                solVault: solVaultPda,
                usdcVault: usdcVaultAta,
                nysehVault: nysehVaultAta,
                ammState: ammStatePda,
                offerList: offerListPda,
                marketStatusPda: marketStatusPda,
                crankProgram: CRANK_PROGRAM_ID,
                associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
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
