import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
    addExtraAccountMetasForExecute,
    createTransferCheckedInstruction,
    getExtraAccountMetaAddress,
    getExtraAccountMetas,
    getMint,
    getTransferHook,
    resolveExtraAccountMeta,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const RPC_URL = "https://api.devnet.solana.com";

function isBase64(value: string): boolean {
    return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length > 64;
}

async function inspectMint(connection: Connection, mint: PublicKey) {
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const hook = getTransferHook(mintInfo);

    console.log("mint:", mint.toBase58());
    console.log("transfer hook program:", hook?.programId.toBase58() ?? "(none)");

    if (!hook) return;

    const extraMetaAddress = getExtraAccountMetaAddress(mint, hook.programId);
    const extraMetaAccount = await connection.getAccountInfo(extraMetaAddress, "confirmed");

    console.log("extra-account-metas:", extraMetaAddress.toBase58());
    console.log("extra-account-metas exists:", Boolean(extraMetaAccount));
    console.log("extra-account-metas owner:", extraMetaAccount?.owner.toBase58() ?? "(missing)");
    console.log("extra-account-metas data length:", extraMetaAccount?.data.length ?? 0);

    if (!extraMetaAccount) return;

    const metas = getExtraAccountMetas(extraMetaAccount);
    console.log("decoded extra metas:");
    metas.forEach((meta, index) => {
        console.log(index, {
            discriminator: meta.discriminator,
            addressConfig: Buffer.from(meta.addressConfig).toString("hex"),
            isSigner: meta.isSigner,
            isWritable: meta.isWritable,
        });
    });

    const dummySource = PublicKey.unique();
    const dummyDestination = PublicKey.unique();
    const dummyOwner = PublicKey.unique();
    const dummyInstruction = createTransferCheckedInstruction(
        dummySource,
        mint,
        dummyDestination,
        dummyOwner,
        BigInt(1),
        mintInfo.decimals,
        [],
        TOKEN_2022_PROGRAM_ID,
    );
    const executeInstruction = createTransferCheckedInstruction(
        dummySource,
        mint,
        dummyDestination,
        dummyOwner,
        BigInt(1),
        mintInfo.decimals,
        [],
        TOKEN_2022_PROGRAM_ID,
    );

    await addExtraAccountMetasForExecute(
        connection,
        executeInstruction,
        hook.programId,
        dummySource,
        mint,
        dummyDestination,
        dummyOwner,
        BigInt(1),
        "confirmed",
    );

    console.log("hook-aware TransferChecked accounts:");
    executeInstruction.keys.forEach((key, index) => {
        console.log(index, {
            pubkey: key.pubkey.toBase58(),
            isSigner: key.isSigner,
            isWritable: key.isWritable,
        });
    });

    console.log("resolved extra meta accounts:");
    for (const [index, meta] of metas.entries()) {
        const resolved = await resolveExtraAccountMeta(
            connection,
            meta,
            [
                { pubkey: dummySource, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: dummyDestination, isSigner: false, isWritable: false },
                { pubkey: dummyOwner, isSigner: false, isWritable: false },
                { pubkey: extraMetaAddress, isSigner: false, isWritable: false },
            ],
            Buffer.alloc(8 + 8),
            hook.programId,
        );
        const account = await connection.getAccountInfo(resolved.pubkey, "confirmed");
        console.log(index, {
            pubkey: resolved.pubkey.toBase58(),
            isSigner: resolved.isSigner,
            isWritable: resolved.isWritable,
            exists: Boolean(account),
            owner: account?.owner.toBase58() ?? "(missing)",
            executable: account?.executable ?? false,
            dataLength: account?.data.length ?? 0,
        });
    }

    const hookProgramAccount = await connection.getAccountInfo(hook.programId, "confirmed");
    console.log("hook program account:", {
        exists: Boolean(hookProgramAccount),
        executable: hookProgramAccount?.executable ?? false,
        owner: hookProgramAccount?.owner.toBase58() ?? "(missing)",
    });
}

function inspectTransaction(base64Tx: string) {
    const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, "base64"));
    const keys = tx.message.staticAccountKeys;

    console.log("transaction version:", tx.version);
    console.log("static account keys:");
    keys.forEach((key, index) => console.log(index, key.toBase58()));

    console.log("compiled instructions:");
    tx.message.compiledInstructions.forEach((ix, index) => {
        console.log(index, {
            programIndex: ix.programIdIndex,
            program: keys[ix.programIdIndex]?.toBase58(),
            accountIndexes: Array.from(ix.accountKeyIndexes),
            accounts: Array.from(ix.accountKeyIndexes).map((accountIndex) =>
                keys[accountIndex]?.toBase58()
            ),
            dataHex: Buffer.from(ix.data).toString("hex"),
        });
    });
}

async function main() {
    const value = process.argv[2];
    if (!value) {
        throw new Error("Usage: npx ts-node scripts/inspect-transfer-hook.ts <MINT_OR_BASE64_TX>");
    }

    if (isBase64(value)) {
        inspectTransaction(value);
        return;
    }

    const connection = new Connection(RPC_URL, "confirmed");
    await inspectMint(connection, new PublicKey(value));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
