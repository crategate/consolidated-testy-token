// E2E verification of the FLOOR_UNITS_PER_Q32 fix:
// 1) tiny wallet swap through the AFHO/USDC CPMM pool (refreshes the TWAP ring)
// 2) immediately fire the keeper-style dexBuyback — pre-fix this failed with
//    Raydium 0x1775 ExceededSlippage on the fresh ring; post-fix it must pass.
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import ammIdl from "../target/idl/amm.json" with { type: "json" };

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8"))));
const wallet = new anchor.Wallet(kp);
const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
anchor.setProvider(provider);

const deployment = JSON.parse(fs.readFileSync("app/public/deployment.json", "utf-8"));
const AMM = new PublicKey(deployment.ammProgram);
const CPMM = new PublicKey(deployment.raydiumProgram);
const MINT = new PublicKey(deployment.mint);
const USDC = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT");
const poolState = new PublicKey(deployment.raydiumPool);
const config = new PublicKey(deployment.raydiumAmmConfig);

const [ammStatePda] = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), MINT.toBuffer()], AMM);
const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], new PublicKey(deployment.crankProgram));
const [acceptedPda] = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), MINT.toBuffer()], AMM);
const [metricsPda] = PublicKey.findProgramAddressSync([Buffer.from("metrics"), MINT.toBuffer()], AMM);
const vaultPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), poolState.toBuffer(), mint.toBuffer()], CPMM)[0];
const [authority] = PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], CPMM);
const [observation] = PublicKey.findProgramAddressSync([Buffer.from("observation"), poolState.toBuffer()], CPMM);
const inputVault = vaultPda(USDC);
const outputVault = vaultPda(MINT);

const ammProgram = new anchor.Program(ammIdl, provider);

const amtOf = async (k) => {
    const a = await conn.getAccountInfo(k, "confirmed");
    return a ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
};
const stateView = async () => {
    const st = await ammProgram.account.ammState.fetch(ammStatePda);
    const obs = await conn.getAccountInfo(observation, "confirmed");
    return {
        usdcVault: String(await amtOf(st.usdcVault)),
        afhoVault: String(await amtOf(st.afhoVault)),
        bbBudget: String(st.bbBudgetUsdc), bbSpent: String(st.bbSpentUsdc), bbDay: String(st.bbDayIndex),
        basis: String(st.highestBuybackBasis),
        obsIdx: obs ? obs.data.readUInt16LE(9) : null,
    };
};

console.log("before:", await stateView());

// ── 1. ring refresh: 0.1 USDC → AFHO through the pinned pool ────────────────
const usdcAta = getAssociatedTokenAddressSync(USDC, kp.publicKey, false, TOKEN_PROGRAM_ID);
const afhoAta = getAssociatedTokenAddressSync(MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID);
const SWAP_DISC = Buffer.from([0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde]);
const amountIn = 100_000n; // 0.1 USDC raw
const swapData = Buffer.concat([
    SWAP_DISC,
    Buffer.from(new BigUint64Array([amountIn]).buffer),
    Buffer.from(new BigUint64Array([0n]).buffer), // min_out 0
]);
const swapIx = {
    programId: CPMM,
    keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: false },
        { pubkey: authority, isSigner: false, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: poolState, isSigner: false, isWritable: true },
        { pubkey: usdcAta, isSigner: false, isWritable: true },
        { pubkey: afhoAta, isSigner: false, isWritable: true },
        { pubkey: inputVault, isSigner: false, isWritable: true },
        { pubkey: outputVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: USDC, isSigner: false, isWritable: false },
        { pubkey: MINT, isSigner: false, isWritable: false },
        { pubkey: observation, isSigner: false, isWritable: true },
    ],
    data: swapData,
};
{
    const bh = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
        payerKey: kp.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
            swapIx,
        ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([kp]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
    console.log("ring refresh swap:", sig);
}

// ── 2. keeper-style dexBuyback, immediately (fresh ring) ────────────────────
const bbIx = await ammProgram.methods.dexBuyback().accountsStrict({
    cranker: kp.publicKey,
    ammState: ammStatePda,
    marketStatus: marketPda,
    acceptedOffers: acceptedPda,
    usdcVault: (await ammProgram.account.ammState.fetch(ammStatePda)).usdcVault,
    afhoVault: (await ammProgram.account.ammState.fetch(ammStatePda)).afhoVault,
    afhoMint: MINT,
    usdcMint: USDC,
    cpmmPoolState: poolState,
    cpmmAmmConfig: config,
    cpmmInputVault: inputVault,
    cpmmOutputVault: outputVault,
    cpmmObservation: observation,
    cpmmAuthority: authority,
    cpmmProgram: CPMM,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
}).instruction();
{
    const bh = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
        payerKey: kp.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
            bbIx,
        ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([kp]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false });
    if (sim.value.err) {
        console.log("dex_buyback SIM FAILED:", JSON.stringify(sim.value.err));
        console.log("  last logs:", (sim.value.logs ?? []).slice(-6));
        process.exit(1);
    }
    const sig = await conn.sendTransaction(tx, { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
    console.log("dex_buyback slice FIRED:", sig);
}
console.log("after:", await stateView());
