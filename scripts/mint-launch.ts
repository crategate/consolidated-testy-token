import * as anchor from "@coral-xyz/anchor";
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
    TOKEN_PROGRAM_ID,
    getMintLen,
    createInitializeMintInstruction,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    getAssociatedTokenAddressSync,
    createBurnInstruction,
    getAccount,
    TYPE_SIZE,
    LENGTH_SIZE,
    createInitializeMetadataPointerInstruction,
    createSetAuthorityInstruction,
    AuthorityType,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata, createUpdateAuthorityInstruction } from "@solana/spl-token-metadata";
import * as fs from "fs";
import * as path from "path";
import { pubkey, writeDeploymentState } from "./deployment-state";
import * as dotenv from "dotenv";
// Devnet USDC (the faucet mint used across the scripts). MAINNET: swap in the
// real USDC mint and uncomment it.
dotenv.config();

const USDC_MINT = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"); // devnet (Raydium devnet faucet)
// const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // MAINNET

const crankKeypairPath = path.join(process.cwd(), "target", "deploy", "crank_oracle-keypair.json");
const crankKeyData = JSON.parse(fs.readFileSync(crankKeypairPath, "utf-8"));
const oracleCrankProgramId = Keypair.fromSecretKey(new Uint8Array(crankKeyData)).publicKey;
async function main() {
    // 1. Setup Provider
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = oracleCrankProgramId;
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    console.log(" Starting Token Deployment...");

    // 2. Load or Generate Mint Keypair
    const mintKeypairPath = path.join(process.cwd(), "target", "deploy", "afho_token-keypair.json");
    let mint: Keypair;

    if (fs.existsSync(mintKeypairPath)) {
        const keyData = JSON.parse(fs.readFileSync(mintKeypairPath, "utf-8"));
        mint = Keypair.fromSecretKey(new Uint8Array(keyData));
        console.log(` Loaded existing Mint: ${mint.publicKey.toBase58()}`);
    } else {
        mint = Keypair.generate();
        fs.writeFileSync(mintKeypairPath, JSON.stringify(Array.from(mint.secretKey)));
        console.log(` Generated new Mint: ${mint.publicKey.toBase58()}`);
    }

    const decimals = 9;

    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        oracleCrankProgramId
    );

    writeDeploymentState({
        cluster: "devnet",
        mint: pubkey(mint.publicKey),
        crankProgram: pubkey(oracleCrankProgramId),
        marketStatus: pubkey(marketStatusPda),
    });

    // 4. Token Metadata Configuration
    const metadata: TokenMetadata = {
        mint: mint.publicKey,
        name: 'AfterHours',
        symbol: 'AFHO93',
        uri: 'https://copper-quick-koi-488.mypinata.cloud/ipfs/bafkreibzpsjq7c2hqogq2ukdz4wbadv75v5rdy2xgzgo56iie6agef5xhe',
        additionalMetadata: [['description', 'a token bound by the hours of Wall Street']],
    };
    const metadataLen = pack(metadata).length + TYPE_SIZE + LENGTH_SIZE;
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);

    const lamports = await connection.getMinimumBalanceForRentExemption(metadataLen + mintLen);

    // ==========================================
    // STEP 1: INITIALIZE MINT & EXTENSIONS
    // ==========================================
    console.log(" Initializing Mint and Extensions...");
    const initMintTx = new Transaction().add(
        SystemProgram.createAccount({
            fromPubkey: wallet.publicKey,
            newAccountPubkey: mint.publicKey,
            space: mintLen,
            lamports: lamports,
            programId: TOKEN_2022_PROGRAM_ID,
        }),
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
        console.log(` Mint initialized! Signature: ${sig1}`);
    } catch (e) {
        console.log("Mint already initialized or failed:   ", e);
    }

    // MINT & POOL CONFIG
    const FULL_MINT_AMOUNT = 1000000000;
    // NOTE: wallet AFHO balance after amm-init's 75% vault sweep is 249,999,978,
    // so the LP leg must stay below that when re-running on an existing mint.
    const AFHO_TO_LP = 250000000;
    const USDC_TO_LP = 1250;
    const AFHO_TO_VAULT = 745000000;  // change in amm-init

    /// MINT TOKENS & TEST TRANSFER
    // ==========================================
    console.log(" Minting tokens and running test transfer...");
    const sourceTokenAccount = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const recipient = Keypair.generate();
    const destinationTokenAccount = getAssociatedTokenAddressSync(mint.publicKey, recipient.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    // !! MAINNET LAUNCH SPLIT — see MAINNET_CHECKLIST.md §5:
    //   25% of total supply → Raydium LP seed (AFHO leg; matching USDC quote
    //   from the raise), 75% → protocol vault. Replace the devnet amounts below
    //   (1.2M to wallet) with the real split at launch.
    const amountToMint = FULL_MINT_AMOUNT * 10 ** decimals; // 1B AFHO — covers pool float (1M) + vault seed
    const amountToTransfer = BigInt(1 * 10 ** decimals);

    const transferTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(wallet.publicKey, sourceTokenAccount, wallet.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(wallet.publicKey, destinationTokenAccount, recipient.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createMintToInstruction(mint.publicKey, sourceTokenAccount, wallet.publicKey, amountToMint, [], TOKEN_2022_PROGRAM_ID)
    );

    try {
        const sig3 = await sendAndConfirmTransaction(connection, transferTx, [wallet.payer], { skipPreflight: true });
        console.log(` Minted ${(amountToMint / 10 ** decimals).toLocaleString()} AFHO to source wallet! Signature: ${sig3}`);

        console.log(` Hook Transfer Successful! Signature: ${sig3}`);

    } catch (e) {
        console.error("!! Transfer Failed:", e);
    }

    // ── Revoke mint authority: supply is permanently capped. ────────────────
    // Freeze authority was already `null` at init, so nothing can be frozen.
    try {
        const revokeTx = new Transaction().add(
            createSetAuthorityInstruction(
                mint.publicKey,
                wallet.publicKey,          // current mint authority
                AuthorityType.MintTokens,
                null,                       // revoke — no new mint authority
                [],
                TOKEN_2022_PROGRAM_ID
            )
        );
        const revokeSig = await sendAndConfirmTransaction(connection, revokeTx, [wallet.payer], { skipPreflight: true });
        console.log(` Mint authority revoked: ${revokeSig}`);
    } catch (e) {
        console.error("!! Mint authority revoke failed:", e);
    }

    // ── Revoke metadata update authority: name/symbol/URI become immutable. ─
    // The Token-2022 metadata is stored in the mint account itself; clearing
    // update_authority makes it un-editable.
    try {
        const mdRevokeTx = new Transaction().add(
            createUpdateAuthorityInstruction({
                programId: TOKEN_2022_PROGRAM_ID,
                metadata: mint.publicKey,
                oldAuthority: wallet.publicKey,
                newAuthority: null,        // revoke — immutable metadata
            })
        );
        const mdSig = await sendAndConfirmTransaction(connection, mdRevokeTx, [wallet.payer], { skipPreflight: true });
        console.log(` Metadata update authority revoked: ${mdSig}`);
    } catch (e) {
        console.error(" Metadata update authority revoke failed:", e);
    }

    // ── Raydium CPMM liquidity pool (devnet) ────────────────────────────────
    // Seeds an AFHO/USDC pool so the DEX adapter + on-chain pricing can be
    // exercised on devnet. Requires `yarn add @raydium-io/raydium-sdk-v2` and a
    // funded devnet USDC ATA. On MAINNET: set USDC_MINT to EPjFWdd5... above and
    // run once at launch.
    try {
        const { Raydium, TxVersion, DEVNET_PROGRAM_ID } = await import("@raydium-io/raydium-sdk-v2");
        const raydium = await Raydium.load({ connection, owner: wallet.payer, cluster: "devnet" });
        const feeConfigs = await raydium.api.getCpmmConfigs();
        const feeConfig = feeConfigs.find((c) => c.tradeFeeRate === 2500);
        if (!feeConfig) throw new Error("No 0.25% CPMM fee config on devnet");

        // The Raydium token API is mainnet-oriented — on devnet it may not know
        // these mints, so fall back to reading the mint accounts from the RPC.
        const getToken = async (mintKey: PublicKey, programId: string) => {
            try {
                const t = await raydium.token.getTokenInfo(mintKey.toBase58());
                return { address: t.address, decimals: t.decimals, programId: t.programId };
            } catch {
                const parsed = await connection.getParsedAccountInfo(mintKey);
                const info = (parsed.value!.data as { parsed: { info: { decimals: number } } }).parsed.info;
                return { address: mintKey.toBase58(), decimals: info.decimals, programId };
            }
        };
        const afhoInfo = await getToken(mint.publicKey, TOKEN_2022_PROGRAM_ID.toBase58());
        const usdcInfo = await getToken(USDC_MINT, TOKEN_PROGRAM_ID.toBase58());

        // Small devnet seed amounts — tune as needed. MAINNET: these become
        // the 25% LP leg (AFHO side) + the matching USDC quote side.
        // Multiply inside BN — the raw amounts (2.49e17) exceed the JS
        // safe-integer range and bn.js asserts on numbers >= 2^53
        // (bare "Assertion failed").
        const seedAfho = new anchor.BN(AFHO_TO_LP).mul(new anchor.BN(10).pow(new anchor.BN(decimals)));
        const seedUsdc = new anchor.BN(USDC_TO_LP).mul(new anchor.BN(1_000_000)); // USDC raw (6 dec)

        const { execute, extInfo } = await raydium.cpmm.createPool({
            programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
            poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
            mintA: afhoInfo,
            mintB: usdcInfo,
            mintAAmount: seedAfho,
            mintBAmount: seedUsdc,
            startTime: new anchor.BN(0),
            feeConfig,
            associatedOnly: false,
            ownerInfo: { useSOLBalance: true },
            txVersion: TxVersion.V0,
        });
        const { txId } = await execute({ sendAndConfirm: true });
        const poolId = extInfo.address.poolId;
        const configId = extInfo.address.configId;
        console.log(` Raydium CPMM pool created: ${poolId.toBase58()} (tx ${txId})`);
        writeDeploymentState({
            raydiumPool: poolId.toBase58(),
            raydiumAmmConfig: configId.toBase58(),
            raydiumProgram: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM.toBase58(),
        });

        // ── Burn a sliver of LP (devnet smoke test) ────────────────────────
        // MAINNET: decide burn-all vs Raydium `cpmm.lockLiquidity` (§5 custody).
        try {
            const lpMint = extInfo.address.lpMint;
            const lpAta = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
            const lpBal = await getAccount(connection, lpAta, "confirmed", TOKEN_PROGRAM_ID);
            if (lpBal.amount > BigInt(0)) {
                const burnRaw = BigInt(1); // 1 raw LP unit — just proves the flow
                const burnTx = new Transaction().add(
                    createBurnInstruction(lpAta, lpMint, wallet.publicKey, burnRaw, [], TOKEN_PROGRAM_ID)
                );
                const { blockhash } = await connection.getLatestBlockhash("confirmed");
                burnTx.recentBlockhash = blockhash;
                burnTx.feePayer = wallet.publicKey;
                const burnSig = await sendAndConfirmTransaction(connection, burnTx, [wallet.payer], { skipPreflight: true });
                console.log(` LP burn smoke test (1 raw LP): ${burnSig}`);
            }
        } catch (e) {
            console.warn("!! LP burn skipped:", e instanceof Error ? e.message : e);
        }
    } catch (e) {
        console.warn(
            "!! Raydium pool creation skipped (install @raydium-io/raydium-sdk-v2 and fund devnet USDC):",
            e instanceof Error ? e.message : e
        );
    }

    console.log(" Deployment Complete!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
