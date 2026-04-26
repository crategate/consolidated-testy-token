import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CoinMint } from "../target/types/coin_mint";
import {
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
    Keypair,
    SendTransactionError,
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
    TransferFeeConfig,
    TYPE_SIZE,
    LENGTH_SIZE,
    createTransferCheckedWithTransferHookInstruction,
    createInitializeMetadataPointerInstruction,
    getExtraAccountMetaAddress,
    createInitializeTransferFeeConfigInstruction
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";

describe("transfer-hook", () => {
    // Configure the client to use the local cluster.
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.TTHook as Program<CoinMint>;
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    // Generate keypair to use as address for the transfer-hook enabled mint
    const mint = new Keypair();
    const decimals = 9;

    // Sender token account address
    const sourceTokenAccount = getAssociatedTokenAddressSync(
        mint.publicKey,
        wallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Recipient token account address
    const recipient = Keypair.generate();
    const destinationTokenAccount = getAssociatedTokenAddressSync(
        mint.publicKey,
        recipient.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // ExtraAccountMetaList address
    // Store extra accounts required by the custom transfer hook instruction
    const [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
        program.programId
    );

    const [counterPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("counter")],
        program.programId
    );

    // token metadata
    const metadata: TokenMetadata = {
        mint: mint.publicKey,
        name: 'RUDI Fee',
        symbol: 'FEEME',
        uri: 'https://copper-quick-koi-488.mypinata.cloud/ipfs/bafkreiblskodz5bwtelz4id437rnhsndtq3rfh7jjsgaj72wb55cgnbbea',
        additionalMetadata: [['description', 'combining concepts and learning the basics']],
    };
    const metadataLen = pack(metadata).length + TYPE_SIZE + LENGTH_SIZE;
    const mintLen = getMintLen([ExtensionType.TransferHook, ExtensionType.MetadataPointer]);




    it("Create Mint Account with Transfer Hook Extension & MetaData", async () => {
        const extensions = [ExtensionType.TransferHook, ExtensionType.TransferFeeConfig];
        //	const mintLen = getMintLen(extensions);
        const lamports =
            await provider.connection.getMinimumBalanceForRentExemption(metadataLen + mintLen);

        const [feeAuthorityPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("fee_authority")],
            new PublicKey("3rTiktUXLdYgnsPfPv3YLduUYdLTQANnzC8muZprYYHR")
        );
        const lottoVault = new PublicKey("J6J9SuxEfe9aiMLha7ERX3uQhHXaD4Y7bFkJYQGP4guR");
        const initialFee = 0;

        const transaction = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: mint.publicKey,
                space: mintLen, //+ metadataLen,
                lamports: lamports,
                programId: TOKEN_2022_PROGRAM_ID,
            }),
            createInitializeTransferHookInstruction(
                mint.publicKey,
                wallet.publicKey,
                program.programId, // Transfer Hook Program ID
                TOKEN_2022_PROGRAM_ID
            ),
            createInitializeTransferFeeConfigInstruction(
                mint.publicKey,
                feeAuthorityPda,
                lottoVault,
                initialFee,
                BigInt(900),
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
                name: "RUDI Fee",
                symbol: "FEEME",
                uri: "https://copper-quick-koi-488.mypinata.cloud/ipfs/bafkreiblskodz5bwtelz4id437rnhsndtq3rfh7jjsgaj72wb55cgnbbea",
                updateAuthority: wallet.publicKey
            })
        );

        const txSig = await sendAndConfirmTransaction(
            provider.connection,
            transaction,
            [wallet.payer, mint],
            { skipPreflight: true, commitment: "finalized" }
        );
        const txDetails = await program.provider.connection.getTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        console.log(txDetails.meta.logMessages);

        console.log(`Transaction Signature: ${txSig}`);
    });

    // Create the two token accounts for the transfer-hook enabled mint
    // Fund the sender token account with 100 tokens
    it("Create Token Accounts and Mint Tokens", async () => {
        // 100 tokens
        const amount = 722 * 10 ** decimals;

        const transaction = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                sourceTokenAccount,
                wallet.publicKey,
                mint.publicKey,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            ),
            createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                destinationTokenAccount,
                recipient.publicKey,
                mint.publicKey,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            ),
            createMintToInstruction(
                mint.publicKey,
                sourceTokenAccount,
                wallet.publicKey,
                amount,
                [],
                TOKEN_2022_PROGRAM_ID
            )
        );

        const txSig = await sendAndConfirmTransaction(
            connection,
            transaction,
            [wallet.payer],
            { skipPreflight: true }
        );

        console.log(`Transaction Signature: ${txSig}`);
    });

    // Account to store extra accounts required by the transfer hook instruction
    it("Create ExtraAccountMetaList Account", async () => {
        const initializeExtraAccountMetaListInstruction = await program.methods
            .initializeExtraAccountMetaList()
            .accountsPartial({
                mint: mint.publicKey,
                extraAccountMetaList: extraAccountMetaListPDA,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                counterAccount: counterPDA,
            })
            .instruction();

        const transaction = new Transaction().add(
            initializeExtraAccountMetaListInstruction
        );

        const txSig = await sendAndConfirmTransaction(
            provider.connection,
            transaction,
            [wallet.payer],
            { skipPreflight: true, commitment: "confirmed" }
        );
        console.log("Transaction Signature:", txSig);
    });

    it("Transfer Hook with Extra Account Meta", async () => {
        // 1 tokens
        const amount = 1 * 10 ** decimals;
        const amountBigInt = BigInt(amount);

        let transferInstructionWithHelper = await createTransferCheckedWithTransferHookInstruction(
            connection,
            sourceTokenAccount,
            mint.publicKey,
            destinationTokenAccount,
            wallet.publicKey,
            amountBigInt,
            decimals,
            [],
            "confirmed",
            TOKEN_2022_PROGRAM_ID,
        );

        console.log("Extra accounts meta: " + extraAccountMetaListPDA);
        console.log("Counter PDa: " + counterPDA);
        console.log("Transfer Instruction: " + JSON.stringify(transferInstructionWithHelper));

        const transaction = new Transaction().add(
            transferInstructionWithHelper
        );

        const txSig = await sendAndConfirmTransaction(
            connection,
            transaction,
            [wallet.payer],
            { skipPreflight: true }
        );
        console.log("Transfer Signature:", txSig);
    });
});
