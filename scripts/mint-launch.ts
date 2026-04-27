import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CoinMint } from "../target/types/coin_mint";
import {
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
    Keypair,
} from "@solana/web3.js";
import {
    ExtensionType,
    TOKEN_2022_PROGRAM_ID,
    getMintLen,
    createInitializeMintInstruction,
    createInitializeTransferHookInstruction,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    getAssociatedTokenAddressSync,
    TYPE_SIZE,
    LENGTH_SIZE,
    createTransferCheckedWithTransferHookInstruction,
    createInitializeMetadataPointerInstruction,
    createInitializeTransferFeeConfigInstruction
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import * as fs from "fs";

async function main() {
    // 1. Setup Provider
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.CoinMint as Program<CoinMint>;
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    console.log("🚀 Starting Token Deployment...");

    // 2. Load or Generate Mint Keypair
    const mintKeypairPath = "./target/deploy/nyseh_mint-keypair.json";
    let mint: Keypair;

    if (fs.existsSync(mintKeypairPath)) {
        const keyData = JSON.parse(fs.readFileSync(mintKeypairPath, "utf-8"));
        mint = Keypair.fromSecretKey(new Uint8Array(keyData));
        console.log(`✅ Loaded existing Mint: ${mint.publicKey.toBase58()}`);
    } else {
        mint = Keypair.generate();
        fs.writeFileSync(mintKeypairPath, JSON.stringify(Array.from(mint.secretKey)));
        console.log(`✨ Generated new Mint: ${mint.publicKey.toBase58()}`);
    }

    const decimals = 9;

    // 3. Setup PDAs & Addresses
    const [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
        program.programId
    );

    const [counterPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("counter")],
        program.programId
    );

    // Hardcoded addresses from your test
    const oracleCrankProgramId = new PublicKey("3rTiktUXLdYgnsPfPv3YLduUYdLTQANnzC8muZprYYHR");
    const [feeAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_authority")],
        oracleCrankProgramId
    );
    const lottoVault = new PublicKey("J6J9SuxEfe9aiMLha7ERX3uQhHXaD4Y7bFkJYQGP4guR");

    // 4. Token Metadata Configuration
    const metadata: TokenMetadata = {
        mint: mint.publicKey,
        name: 'scrip launch -----',
        symbol: '000000',
        uri: 'https://copper-quick-koi-488.mypinata.cloud/ipfs/bafkreiblskodz5bwtelz4id437rnhsndtq3rfh7jjsgaj72wb55cgnbbea',
        additionalMetadata: [['description', 'combining concepts and learning the basics']],
    };
    const metadataLen = pack(metadata).length + TYPE_SIZE + LENGTH_SIZE;
    const mintLen = getMintLen([ExtensionType.TransferHook, ExtensionType.MetadataPointer, ExtensionType.TransferFeeConfig]);

    const lamports = await connection.getMinimumBalanceForRentExemption(metadataLen + mintLen);

    // ==========================================
    // STEP 1: INITIALIZE MINT & EXTENSIONS
    // ==========================================
    console.log("📝 Initializing Mint and Extensions...");
    const initMintTx = new Transaction().add(
        SystemProgram.createAccount({
            fromPubkey: wallet.publicKey,
            newAccountPubkey: mint.publicKey,
            space: mintLen,
            lamports: lamports,
            programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(
            mint.publicKey,
            wallet.publicKey,
            program.programId,
            TOKEN_2022_PROGRAM_ID
        ),
        createInitializeTransferFeeConfigInstruction(
            mint.publicKey,
            feeAuthorityPda,
            lottoVault,
            0, // Initial fee
            BigInt(900), // Max fee
            TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMetadataPointerInstruction(
            mint.publicKey,
            wallet.publicKey,
            mint.publicKey,
            TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMintInstruction(
            mint.publicKey,
            decimals,
            wallet.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
        ),
        createInitializeInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            mint: mint.publicKey,
            metadata: mint.publicKey,
            mintAuthority: wallet.publicKey,
            name: metadata.name,
            symbol: metadata.symbol,
            uri: metadata.uri,
            updateAuthority: wallet.publicKey
        })
    );

    try {
        const sig1 = await sendAndConfirmTransaction(connection, initMintTx, [wallet.payer, mint], { skipPreflight: true, commitment: "confirmed" });
        console.log(`✅ Mint initialized! Signature: ${sig1}`);
    } catch (e) {
        console.log("Mint already initialized or failed:", e);
    }

    // ==========================================
    // STEP 2: INITIALIZE EXTRA ACCOUNT META LIST
    // ==========================================
    console.log("📝 Initializing Extra Account Meta List...");
    const initMetaListIx = await program.methods
        .initializeExtraAccountMetaList()
        .accountsPartial({
            mint: mint.publicKey,
            extraAccountMetaList: extraAccountMetaListPDA,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            counterAccount: counterPDA,
        })
        .instruction();

    const initMetaTx = new Transaction().add(initMetaListIx);

    try {
        const sig2 = await sendAndConfirmTransaction(connection, initMetaTx, [wallet.payer], { skipPreflight: true, commitment: "confirmed" });
        console.log(`✅ Meta List initialized! Signature: ${sig2}`);
    } catch (e) {
        console.log("Meta list already initialized or failed:", e);
    }

    // ==========================================
    // STEP 3: MINT TOKENS & TEST TRANSFER
    // ==========================================
    console.log("📝 Minting tokens and running test transfer...");
    const sourceTokenAccount = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const recipient = Keypair.generate();
    const destinationTokenAccount = getAssociatedTokenAddressSync(mint.publicKey, recipient.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const amountToMint = 722 * 10 ** decimals;
    const amountToTransfer = BigInt(1 * 10 ** decimals);

    const transferTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(wallet.publicKey, sourceTokenAccount, wallet.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(wallet.publicKey, destinationTokenAccount, recipient.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createMintToInstruction(mint.publicKey, sourceTokenAccount, wallet.publicKey, amountToMint, [], TOKEN_2022_PROGRAM_ID)
    );

    try {
        const sig3 = await sendAndConfirmTransaction(connection, transferTx, [wallet.payer], { skipPreflight: true });
        console.log(`✅ Minted ${722} tokens to source wallet! Signature: ${sig3}`);

        const transferIx = await createTransferCheckedWithTransferHookInstruction(
            connection, sourceTokenAccount, mint.publicKey, destinationTokenAccount, wallet.publicKey, amountToTransfer, decimals, [], "confirmed", TOKEN_2022_PROGRAM_ID
        );

        const sig4 = await sendAndConfirmTransaction(connection, new Transaction().add(transferIx), [wallet.payer], { skipPreflight: true });
        console.log(`✅ Hook Transfer Successful! Signature: ${sig4}`);

    } catch (e) {
        console.error("❌ Transfer Failed:", e);
    }

    console.log("🎉 Deployment Complete!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
