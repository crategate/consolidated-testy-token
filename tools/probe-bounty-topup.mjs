// Simulate bounty_top_up against the DEPLOYED devnet program (never sends).
// Prints full simulation logs so we can see exactly which leg fails and why.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const deployment = JSON.parse(fs.readFileSync("app/public/deployment.json", "utf-8"));
const idl = JSON.parse(fs.readFileSync("target/idl/amm.json", "utf-8"));

const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(keypair), {});
const program = new anchor.Program(idl, provider);

const afhoMint = new PublicKey(deployment.mint);
const CRANK = new PublicKey(deployment.crankProgram);
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const ammStatePda = pda([Buffer.from("amm_state"), afhoMint.toBuffer()], program.programId);
const bountyVaultPda = pda([Buffer.from("bounty_vault")], CRANK);

const ammState = await program.account.ammState.fetch(ammStatePda, "confirmed");
const usdcMint = new PublicKey(ammState.usdcMint);
const cpmmProgram = new PublicKey(ammState.cpmmProgram);
const pool = new PublicKey(ammState.cpmmPoolState);
const solPool = new PublicKey(ammState.cpmmSolUsdcPool);

const vaultOf = (p, mint) => pda([Buffer.from("pool_vault"), p.toBuffer(), mint.toBuffer()], cpmmProgram);
const authority = pda([Buffer.from("vault_and_lp_mint_auth_seed")], cpmmProgram);
const wsolVault = getAssociatedTokenAddressSync(WSOL, ammStatePda, true);

// raw SPL token amount (u64 LE @ offset 64)
const amt = async (pk) => {
    const a = await conn.getAccountInfo(pk, "confirmed");
    return a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : null;
};

const bounty = await conn.getBalance(bountyVaultPda, "confirmed");
console.log("bounty vault:", bounty / 1e9, "SOL  (top-up fires below 0.2)");
console.log("AFHO/USDC pool vaults: AFHO=", await amt(vaultOf(pool, afhoMint)), " USDC=", await amt(vaultOf(pool, usdcMint)));
console.log("SOL/USDC  pool vaults: wSOL=", await amt(vaultOf(solPool, WSOL)), " USDC=", await amt(vaultOf(solPool, usdcMint)));

const ix = await program.methods
    .bountyTopUp()
    .accountsStrict({
        cranker: keypair.publicKey,
        ammState: ammStatePda,
        bountyVault: bountyVaultPda,
        afhoVault: ammState.afhoVault,
        usdcVault: ammState.usdcVault,
        afhoMint,
        usdcMint,
        wsolVault,
        wrappedSolMint: WSOL,
        cpmmPoolState: pool,
        cpmmAmmConfig: new PublicKey(ammState.cpmmAmmConfig),
        cpmmInputVault: vaultOf(pool, usdcMint),
        cpmmOutputVault: vaultOf(pool, afhoMint),
        cpmmObservation: pda([Buffer.from("observation"), pool.toBuffer()], cpmmProgram),
        cpmmAuthority: authority,
        cpmmProgram,
        solUsdcPoolState: solPool,
        solUsdcAmmConfig: new PublicKey(ammState.cpmmSolUsdcConfig),
        solUsdcInputVault: vaultOf(solPool, WSOL),
        solUsdcOutputVault: vaultOf(solPool, usdcMint),
        solUsdcObservation: pda([Buffer.from("observation"), solPool.toBuffer()], cpmmProgram),
        solUsdcAuthority: authority,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

const { blockhash } = await conn.getLatestBlockhash("confirmed");
const tx = new VersionedTransaction(
    new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [ix],
    }).compileToV0Message()
);
const sim = await conn.simulateTransaction(tx, { sigVerify: false });
console.log("\nsim err:", JSON.stringify(sim.value.err));
console.log("units consumed:", sim.value.unitsConsumed);
console.log("\n── full logs ──");
for (const l of sim.value.logs ?? []) console.log(l);
