// scripts/verify-mint-hook.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID, getExtraAccountMetaAddress } from "@solana/spl-token";

const connection = new Connection("https://api.devnet.solana.com");
const mint = new PublicKey("EHAGDDU9GCWEbN3SYqBmc9Q4w6FcXhNtPFTDFW32oWnf");
const coinMintId = new PublicKey("8kNySBN4Zjd8jnWgrE5LcafLNTT16Lhgwhna1tqyn8we");

(async () => {
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    console.log("Transfer hook program ID:", mintInfo.transferHook?.programId.toBase58());

    const extraMetaAddr = getExtraAccountMetaAddress(mint, coinMintId);
    console.log("Extra account meta list address:", extraMetaAddr.toBase58());

    const acc = await connection.getAccountInfo(extraMetaAddr);
    if (!acc) {
        console.error("❌ Extra account meta list DOES NOT EXIST");
        return;
    }
    console.log("Extra account meta list exists. Owner:", acc.owner.toBase58());
    console.log("Data length:", acc.data.length);
    console.log("Data (hex):", acc.data.toString("hex").slice(0, 200));

    // Check the counter PDA
    const [counterPda] = PublicKey.findProgramAddressSync([Buffer.from("counter")], coinMintId);
    const counterAcc = await connection.getAccountInfo(counterPda);
    if (!counterAcc) {
        console.error("❌ Counter PDA does not exist");
    } else {
        console.log("✅ Counter PDA exists. Owner:", counterAcc.owner.toBase58());
    }

    // Check the oracle PDA that should be in the meta list
    const crankOracleId = new PublicKey("8u3aceQ1FeRZH1tVSxeZX4q3G1q8tAK77MadwRj9yLKt");
    const [oraclePda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], crankOracleId);
    const oracleAcc = await connection.getAccountInfo(oraclePda);
    if (!oracleAcc) {
        console.error("❌ Oracle PDA does not exist:", oraclePda.toBase58());
    } else {
        console.log("✅ Oracle PDA exists. Owner:", oracleAcc.owner.toBase58());
        console.log("Oracle data length:", oracleAcc.data.length);
        if (oracleAcc.data.length >= 9) {
            console.log("Oracle state:", oracleAcc.data[8]);
        }
    }
})();
