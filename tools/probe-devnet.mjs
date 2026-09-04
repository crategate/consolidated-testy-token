// Probe devnet: AmmState pins + CPMM pool composition/vaults/observations.
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");

const deployment = JSON.parse(
    fs.readFileSync("app/public/deployment.json", "utf-8")
);
console.log("deployment:", {
    mint: deployment.mint,
    ammProgram: deployment.ammProgram,
    ammState: deployment.ammState,
    raydiumPool: deployment.raydiumPool,
    raydiumAmmConfig: deployment.raydiumAmmConfig,
    raydiumSolUsdcPool: deployment.raydiumSolUsdcPool,
});

// --- decode AmmState via the built IDL ---
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import idl from "../target/idl/amm.json" with { type: "json" };
const coder = new BorshAccountsCoder(idl);
const ammState = new PublicKey(deployment.ammState);
const ammInfo = await conn.getAccountInfo(ammState, "confirmed");
if (!ammInfo) throw new Error("ammState not found");
const st = coder.decode("AmmState", ammInfo.data);
const pk = (v) => (v ? new PublicKey(v).toBase58() : null);
console.log("AmmState pins:", {
    afhoMint: pk(st.afhoMint ?? st.afho_mint),
    usdcMint: pk(st.usdcMint ?? st.usdc_mint),
    cpmmProgram: pk(st.cpmmProgram ?? st.cpmm_program),
    cpmmPoolState: pk(st.cpmmPoolState ?? st.cpmm_pool_state),
    cpmmAmmConfig: pk(st.cpmmAmmConfig ?? st.cpmm_amm_config),
    cpmmSolUsdcPool: pk(st.cpmmSolUsdcPool ?? st.cpmm_sol_usdc_pool),
    cpmmSolUsdcConfig: pk(st.cpmmSolUsdcConfig ?? st.cpmm_sol_usdc_config),
    bbBudgetUsdc: String(st.bbBudgetUsdc ?? st.bb_budget_usdc ?? "?"),
    bbSpentUsdc: String(st.bbSpentUsdc ?? st.bb_spent_usdc ?? "?"),
    bbDayIndex: String(st.bbDayIndex ?? st.bb_day_index ?? "?"),
    highestBuybackBasis: String(st.highestBuybackBasis ?? st.highest_buyback_basis ?? "?"),
});

const cpmmProgram = new PublicKey(
    (st.cpmmProgram ?? st.cpmm_program).toString()
);
const usdcMint = new PublicKey((st.usdcMint ?? st.usdc_mint).toString());
const afhoMint = new PublicKey((st.afhoMint ?? st.afho_mint).toString());
const poolState = new PublicKey((st.cpmmPoolState ?? st.cpmm_pool_state).toString());

const vaultPda = (pool, mint) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from("pool_vault"), pool.toBuffer(), mint.toBuffer()],
        cpmmProgram
    )[0];

async function showPool(label, pool, config, mintA, mintB) {
    const p = await conn.getAccountInfo(pool, "confirmed");
    console.log(`\n== ${label} ==`);
    console.log("  pool state exists:", !!p, p ? `owner=${p.owner.toBase58()}` : "");
    if (p) {
        // token_0 at 168, token_1 at 200 per repo notes
        const t0 = new PublicKey(p.data.slice(168, 200));
        const t1 = new PublicKey(p.data.slice(200, 232));
        console.log("  pool token0:", t0.toBase58());
        console.log("  pool token1:", t1.toBase58());
    }
    for (const [name, mint] of [["mintA", mintA], ["mintB", mintB]]) {
        const v = vaultPda(pool, mint);
        const a = await conn.getAccountInfo(v, "confirmed");
        const amount = a ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
        console.log(`  vault ${name} (${mint.toBase58().slice(0,8)}…) = ${v.toBase58()} amount=${amount}${a ? "" : " (MISSING)"}`);
    }
    const [obs] = PublicKey.findProgramAddressSync(
        [Buffer.from("observation"), pool.toBuffer()],
        cpmmProgram
    );
    const o = await conn.getAccountInfo(obs, "confirmed");
    if (o) {
        const init = o.data[8];
        const idx = o.data.readUInt16LE(9);
        const ts = o.data.readBigUInt64LE(51);
        console.log(`  observation: init=${init} idx=${idx} latest_ts=${ts}`);
    } else {
        console.log("  observation: MISSING");
    }
}

await showPool("AFHO/USDC pool", poolState, null, afhoMint, usdcMint);

const solPool = new PublicKey((st.cpmmSolUsdcPool ?? st.cpmm_sol_usdc_pool).toString());
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
await showPool("SOL/USDC pool", solPool, null, WSOL, usdcMint);

// usdc_vault / afho_vault / usdc_rewards / usdc_dip balances
const [ammStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_state"), afhoMint.toBuffer()],
    new PublicKey(deployment.ammProgram)
);
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
const getTok = async (mint, owner) => {
    for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const ata = getAssociatedTokenAddressSync(mint, owner, true, prog);
        const a = await conn.getAccountInfo(ata, "confirmed");
        if (a) {
            const amount = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
            return { ata: ata.toBase58(), amount: String(amount) };
        }
    }
    return null;
};
console.log("\n== AMM vaults ==");
console.log("  usdc_vault:", await getTok(usdcMint, ammStatePda));
console.log("  afho_vault:", await getTok(afhoMint, ammStatePda));
const [usdcRewards] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_usdc_rewards"), ammStatePda.toBuffer()],
    new PublicKey(deployment.ammProgram)
);
const [usdcDip] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_usdc_dip"), ammStatePda.toBuffer()],
    new PublicKey(deployment.ammProgram)
);
for (const [n, k] of [["usdc_rewards", usdcRewards], ["usdc_dip", usdcDip]]) {
    const a = await conn.getAccountInfo(k, "confirmed");
    const amount = a ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
    console.log(`  ${n}: ${k.toBase58()} amount=${amount}`);
}
