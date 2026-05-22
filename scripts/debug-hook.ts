// scripts/diagnose-hook.ts
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const connection = provider.connection;

    // 1. Load mint from the saved keypair
    const mintKeyPath = path.join(process.cwd(), "target", "deploy", "nyseh_token-keypair.json");
    const mintKey = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(mintKeyPath, "utf-8"))));
    const mint = mintKey.publicKey;

    // 2. Load coin-mint program ID from workspace (what the mint extension actually points to)
    const coinMintIdl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", "coin_mint.json"), "utf-8"));
    const coinMintProgramId = new PublicKey(coinMintIdl.metadata?.address ?? coinMintIdl.address);

    // 3. Derive extra account meta list PDA (this is what Phantom derives)
    const [extraMetaPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("extra-account-metas"), mint.toBuffer()],
        coinMintProgramId
    );

    // 4. Read the extra account meta list
    const extraMetaInfo = await connection.getAccountInfo(extraMetaPda);
    if (!extraMetaInfo) {
        console.error("❌ Extra account meta list DOES NOT EXIST");
        process.exit(1);
    }

    // 5. Parse the oracle pubkey from the TLV data
    // Layout: discriminator(8) + len(4) + account_metas...
    // For your exact setup, the second meta is the oracle pubkey (fixed address)
    const oraclePubkey = new PublicKey(extraMetaInfo.data.slice(12 + 34, 12 + 34 + 32)); // rough offset for the pubkey meta
    console.log("Extra account meta list:", extraMetaPda.toBase58());
    console.log("Oracle pubkey stored in meta list:", oraclePubkey.toBase58());

    // 6. Check if that oracle account exists and is initialized
    const oracleInfo = await connection.getAccountInfo(oraclePubkey);
    if (!oracleInfo) {
        console.error("❌ ORACLE ACCOUNT DOES NOT EXIST. This is why Phantom transfers fail.");
        console.log("   The extra account meta list tells Phantom to pass this account, but it's not on-chain.");
    } else {
        console.log("✅ Oracle account exists, owner:", oracleInfo.owner.toBase58());
        console.log("   Data length:", oracleInfo.data.length);
    }

    // 7. Check counter PDA
    const [counterPda] = PublicKey.findProgramAddressSync([Buffer.from("counter")], coinMintProgramId);
    const counterInfo = await connection.getAccountInfo(counterPda);
    if (!counterInfo) {
        console.error("❌ Counter PDA does not exist");
    } else {
        console.log("✅ Counter PDA exists");
    }

    // 8. Verify crank oracle keypair vs IDL match
    const crankKeyPath = path.join(process.cwd(), "target", "deploy", "crank_oracle-keypair.json");
    const crankKeyData = JSON.parse(fs.readFileSync(crankKeyPath, "utf-8"));
    const crankKeypair = Keypair.fromSecretKey(new Uint8Array(crankKeyData));
    const crankIdl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", "crank_oracle.json"), "utf-8"));
    const crankIdlAddr = new PublicKey(crankIdl.metadata?.address ?? crankIdl.address);

    console.log("\n--- Address Sanity Check ---");
    console.log("Crank keypair pubkey:", crankKeypair.publicKey.toBase58());
    console.log("Crank IDL address:   ", crankIdlAddr.toBase58());
    if (!crankKeypair.publicKey.equals(crankIdlAddr)) {
        console.error("❌ MISMATCH! The keypair and IDL disagree. Re-run `anchor build && anchor deploy`.");
    }
}
main()
