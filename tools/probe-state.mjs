// Check market status, fill rings, rewards vault, wallet token balances.
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import idl from "../target/idl/amm.json" with { type: "json" };
import crankIdl from "../target/idl/crank_oracle.json" with { type: "json" };
import fs from "fs";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const deployment = JSON.parse(fs.readFileSync("app/public/deployment.json", "utf-8"));
const MINT = new PublicKey(deployment.mint);
const AMM = new PublicKey(deployment.ammProgram);
const CRANK = new PublicKey(deployment.crankProgram);
const USDC = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT");

const [market] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], CRANK);
const mi = await conn.getAccountInfo(market, "confirmed");
console.log("market state byte:", mi?.data[8], "day:", mi?.data.readBigUInt64LE(17).toString());

const coder = new BorshAccountsCoder(idl);
const [accepted] = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), MINT.toBuffer()], AMM);
const ai = await conn.getAccountInfo(accepted, "confirmed");
if (ai) {
    const a = coder.decode("AcceptedOffers", ai.data);
    const f = (x) => (Array.isArray(x) ? x : x ? [x] : []);
    console.log("accepted_offers day:", String(a.dayIndex ?? a.day_index ?? "?"));
    for (const k of ["smlOffersAccepted", "medOffersAccepted", "bigOffersAccepted"]) {
        const snake = k.replace(/([A-Z])/g, (c) => "_" + c.toLowerCase());
        const v = f(a[k] ?? a[snake]).map(String);
        console.log("  ", k, JSON.stringify(v));
    }
} else console.log("accepted_offers missing");

const [rewards] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), MINT.toBuffer()], AMM);
const [dip] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), MINT.toBuffer()], AMM);
for (const [n, k] of [["usdc_rewards", rewards], ["usdc_dip", dip]]) {
    const a = await conn.getAccountInfo(k, "confirmed");
    const amt = a ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
    console.log(n, k.toBase58(), amt === null ? "MISSING" : String(amt));
}

// wallet balances
import { Keypair } from "@solana/web3.js";
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8"))));
console.log("wallet:", kp.publicKey.toBase58());
console.log("  lamports:", String(await conn.getBalance(kp.publicKey)));
for (const [n, m, prog] of [["USDC", USDC, TOKEN_PROGRAM_ID], ["AFHO", MINT, TOKEN_2022_PROGRAM_ID]]) {
    const ata = getAssociatedTokenAddressSync(m, kp.publicKey, false, prog);
    const a = await conn.getAccountInfo(ata, "confirmed");
    console.log(`  ${n}:`, a ? String(new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true)) : "none");
}
