// Read-only diagnostic: why does the dash show highest_buyback_basis = 4792
// while the homepage live price looks higher, and what moved the AFHO/USDC
// pool around the last open→after-hours transition?
//
// Prints:
//   1. marketStatus (state/day/ts) + ammState floor/budget/decay counters
//   2. offerList + accepted_offers (are there fills for dex_buyback to act on?)
//   3. the exact price the app computes: TWAP mirror (staleness/density rules)
//      vs vault-ratio fallback — both, plus which one the UI is showing
//   4. the pool's recent swap history (pre/post price per tx) to identify
//      what actually moved the price (buyback fills, dip buys, bounty sells)
//
// Read-only: getAccountInfo / getMultipleAccountsInfo / getSignaturesForAddress
// / getTransaction / getBalance. No transactions are sent.
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import idl from "../target/idl/amm.json" with { type: "json" };
import fs from "fs";

// RPC: env wins, then .env (never prints the key).
function rpcUrl() {
    if (process.env.ANCHOR_PROVIDER_URL) return process.env.ANCHOR_PROVIDER_URL;
    const env = fs.readFileSync(".env", "utf-8");
    const m = env.match(/^RPC_URL=(.+)$/m);
    return m ? m[1].trim() : "https://api.devnet.solana.com";
}
const conn = new Connection(rpcUrl(), "confirmed");
const deployment = JSON.parse(fs.readFileSync("app/public/deployment.json", "utf-8"));

const MINT = new PublicKey(deployment.mint);
const USDC = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT");
const AMM = new PublicKey(deployment.ammProgram);
const CPMM = new PublicKey(deployment.raydiumProgram);
const STAKING = new PublicKey(deployment.stakingProgram);
const poolState = new PublicKey(deployment.raydiumPool);
const ammStatePda = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), MINT.toBuffer()], AMM)[0];
const marketPda = PublicKey.findProgramAddressSync([Buffer.from("market_status")], new PublicKey(deployment.crankProgram))[0];
const acceptedPda = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), MINT.toBuffer()], AMM)[0];
const offerListPda = PublicKey.findProgramAddressSync([Buffer.from("offer_list"), MINT.toBuffer()], AMM)[0];
const bountyVaultPda = PublicKey.findProgramAddressSync([Buffer.from("bounty_vault")], new PublicKey(deployment.crankProgram))[0];

const coder = new BorshAccountsCoder(idl);
const tok = (a) => (a && a.data && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null);
const fmtUsdc = (raw) => (raw === null ? "—" : (Number(raw) / 1e6).toFixed(2));
const fmtAfho = (raw) => (raw === null ? "—" : (Number(raw) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 0 }));
const fmtFloor = (n) => `$${(Number(n) / 1e9).toPrecision(4)} (${n})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the app's exact mirror (chainDataHelpers.ts) ──
const HEADER = 43, OBS_NUM = 100, OBS_SIZE = 40, Q32 = 1n << 32n, FPOQ = 1_000_000_000_000n;
const WINDOW = 600n, MAX_AGE = 600n;
function readTwap(d, nowSec) {
    if (d.length < HEADER + OBS_NUM * OBS_SIZE) return { why: "account too short" };
    if (d[8] === 0) return { why: "ring not initialized" };
    const idx = d[9] | (d[10] << 8);
    const read = (i) => {
        const s = HEADER + (i % OBS_NUM) * OBS_SIZE;
        const lo = d.readBigUInt64LE(s + 8), hi = d.readBigUInt64LE(s + 16);
        return { ts: d.readBigUInt64LE(s), cum: (hi << 64n) | lo };
    };
    const latest = read(idx);
    if (latest.ts === 0n) return { why: "latest ts == 0" };
    const now = BigInt(Math.max(0, Math.trunc(nowSec)));
    const age = now - latest.ts;
    if (now < latest.ts || age > MAX_AGE) return { why: `stale: latest obs ${age}s old (> ${MAX_AGE}s)`, latestTs: latest.ts };
    let oldest = null;
    for (let step = 0; step < OBS_NUM; step++) {
        const o = read(idx + OBS_NUM - step);
        if (o.ts === 0n) break;
        oldest = o;
        if (o.ts <= now - WINDOW || o.ts <= latest.ts - WINDOW) break;
    }
    if (!oldest) return { why: "no usable oldest" };
    const dt = latest.ts - oldest.ts;
    if (dt === 0n) return { why: "dt == 0" };
    if (dt > WINDOW * 2n) return { why: `sparse: dt=${dt}s > 2×window` };
    const dcum = latest.cum >= oldest.cum ? latest.cum - oldest.cum : 0n;
    return { dcum, dt, idx, latestTs: latest.ts };
}

// ── 1. market status + amm state ──
const mi = await conn.getAccountInfo(marketPda);
const mDay = mi.data.readBigUInt64LE(17);
const mTs = Number(mi.data.readBigUInt64LE(9));
console.log("=== marketStatus ===");
console.log(`state=${mi.data[8]} (0=open,1=after-hours,2=closed,3=halted) day=${mDay} lastUpdate=${new Date(mTs * 1000).toISOString()}`);

const asi = await conn.getAccountInfo(ammStatePda);
const ammState = coder.decode("AmmState", asi.data);
const s = (v) => String(v);
console.log("\n=== ammState ===");
console.log(`highest_buyback_basis = ${s(ammState.highest_buyback_basis)}  ${fmtFloor(ammState.highest_buyback_basis)}`);
console.log(`bb_budget=${s(ammState.bb_budget_usdc)} bb_spent=${s(ammState.bb_spent_usdc)} slices=${s(ammState.bb_slice_count)} bb_last_slot=${s(ammState.bb_last_slot)}`);
console.log(`dip_budget=${s(ammState.dip_budget_usdc)} dip_spent=${s(ammState.dip_spent_usdc)} dip_day_start=${s(ammState.dip_day_start_usdc)}`);
console.log(`day_index=${s(ammState.day_index)} untaken_days=${s(ammState.untaken_days)}`);
console.log(`cpmm_pool=${new PublicKey(ammState.cpmm_pool_state).toBase58()} (deployment says ${poolState.toBase58()})`);
console.log(`keeper=${new PublicKey(ammState.keeper).toBase58()}`);

// vault balances
const [usdcVaultBal, afhoVaultBal, dipBal, rewardsBal] = await Promise.all([
    conn.getAccountInfo(ammState.usdc_vault), conn.getAccountInfo(ammState.afho_vault),
    conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), MINT.toBuffer()], AMM)[0]),
    conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), MINT.toBuffer()], AMM)[0]),
]);
console.log(`usdc_vault=${fmtUsdc(tok(usdcVaultBal))} USDC   afho_vault=${fmtAfho(tok(afhoVaultBal))} AFHO`);
console.log(`usdc_dip=${fmtUsdc(tok(dipBal))} USDC   usdc_rewards=${fmtUsdc(tok(rewardsBal))} USDC`);

// ── 2. fills / sheet ──
console.log("\n=== accepted_offers (fill % rings, [oldest..today]) ===");
const acci = await conn.getAccountInfo(acceptedPda);
if (acci) {
    const a = coder.decode("AcceptedOffers", acci.data);
    console.log("day:", s(a.dayIndex ?? a.day_index));
    for (const k of ["sml_offers_accepted", "med_offers_accepted", "big_offers_accepted"]) {
        const v = Array.from(a[k] ?? []).map(Number);
        console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
}
const oli = await conn.getAccountInfo(offerListPda);
if (oli) {
    const ol = coder.decode("OfferList", oli.data);
    const offers = Array.isArray(ol.offers) ? ol.offers : [];
    console.log("offerList day:", s(ol.dayIndex ?? ol.day_index), "tiers:", offers.length);
    offers.forEach((o, i) => o && (o.total_offered > 0 || o.totalOffered > 0) &&
        console.log(`  tier ${i}: rem=${s(o.remaining ?? o.remaining)} total=${s(o.total_offered ?? o.totalOffered)} disc=${o.discount_bps ?? o.discountBps}`));
}

// ── 3. what the app displays right now ──
console.log("\n=== live price (app mirror) ===");
const [vA, vU] = [
    PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), poolState.toBuffer(), MINT.toBuffer()], CPMM)[0],
    PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), poolState.toBuffer(), USDC.toBuffer()], CPMM)[0],
];
const obsKey = PublicKey.findProgramAddressSync([Buffer.from("observation"), poolState.toBuffer()], CPMM)[0];
const infos = await conn.getMultipleAccountsInfo([vA, vU, poolState, obsKey]);
const [vAi, vUi, psi, obsi] = infos;
if (!vAi || !vUi || !psi || !obsi) {
    console.log(`price accounts missing: AFHOvault=${!!vAi} USDCvault=${!!vUi} poolState=${!!psi} obs=${!!obsi}`);
    process.exit(1);
}
const baseRaw = tok(vAi), quoteRaw = tok(vUi);
let ratio = null;
if (baseRaw && quoteRaw && baseRaw > 0n) ratio = (quoteRaw * 1_000_000_000_000n) / baseRaw;
console.log(`pool AFHO vault=${fmtAfho(baseRaw)}  USDC vault=${fmtUsdc(quoteRaw)}`);
console.log(`vault-ratio (fallback price) = ${fmtFloor(ratio)}`);
let twapLine = "TWAP: unusable → app falls back to the vault ratio above";
if (obsi) {
    const t = readTwap(obsi.data, Date.now() / 1000);
    if (t.why) twapLine = `TWAP: unusable (${t.why}) → app falls back to the vault ratio above`;
    else {
        // orientation from pool state mints (offsets 168/200, fork layout)
        const pd = psi.data;
        const mint0 = new PublicKey(pd.slice(168, 200)), mint1 = new PublicKey(pd.slice(200, 232));
        const t0base = mint0.equals(MINT) && mint1.equals(USDC);
        const t0quote = mint0.equals(USDC) && mint1.equals(MINT);
        let twap = null;
        if (t0base) twap = (t.dcum * FPOQ) / t.dt / Q32;
        else if (t0quote && t.dcum !== 0n) twap = (t.dt * Q32 * FPOQ) / t.dcum;
        twapLine = twap && twap > 0n
            ? `TWAP(600s) = ${fmtFloor(twap)}  ← THIS is what the homepage shows (afhoPriceIsTwap=true; mint0=${t0base ? "AFHO" : "USDC"})`
            : `TWAP: orientation unmatched (mint0=${mint0.toBase58()})`;
    }
} else twapLine = "TWAP: observation account missing";
console.log(twapLine);

// ── 4. what actually moved the pool ──
console.log("\n=== pool swap history (newest first) ===");
console.log("bounty vault (crank PDA):", Number(await conn.getBalance(bountyVaultPda)) / 1e9, "SOL (top-up fires < 0.2)");
const slot = await conn.getSlot();
console.log(`current slot=${slot} (bb_last_slot was ${slot - Number(ammState.bb_last_slot)} slots ago)`);
const sigs = await conn.getSignaturesForAddress(poolState, { limit: 250 });
let shown = 0;
for (const sg of sigs) {
    const tx = await conn.getTransaction(sg.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || !tx.meta) { await sleep(80); continue; }
    const t = new Date((sg.blockTime ?? 0) * 1000).toISOString().slice(11, 19);
    const logs = tx.meta.logMessages ?? [];
    const mark = ["dip slice", "buyback slice", "bounty topped up", "Claimed", "floor decay"].find((m) => logs.some((l) => l.includes(m)));
    const failed = tx.meta.err ? "FAILED" : "ok";
    // pool vault balances: match pre/postTokenBalances by the vaults' index in the account keys
    const msg = tx.transaction.message;
    const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const idxA = keys.keySegments().flatMap((k) => k.map(String)).indexOf(vA.toBase58());
    const idxU = keys.keySegments().flatMap((k) => k.map(String)).indexOf(vU.toBase58());
    const at = (list, idx) => list?.find((b) => b.accountIndex === idx);
    const preA = at(tx.meta.preTokenBalances, idxA), postA = at(tx.meta.postTokenBalances, idxA);
    const preU = at(tx.meta.preTokenBalances, idxU), postU = at(tx.meta.postTokenBalances, idxU);
    let price = "";
    if (preA && postA && preU && postU) {
        const a0 = BigInt(preA.uiTokenAmount.amount), a1 = BigInt(postA.uiTokenAmount.amount);
        const u0 = BigInt(preU.uiTokenAmount.amount), u1 = BigInt(postU.uiTokenAmount.amount);
        const p0 = a0 > 0n ? (u0 * 1_000_000_000_000n) / a0 : 0n;
        const p1 = a1 > 0n ? (u1 * 1_000_000_000_000n) / a1 : 0n;
        const dir = a1 < a0 ? "BUY " : a1 > a0 ? "SELL" : "flat";
        const pct = p0 > 0n ? Number(((p1 - p0) * 10000n) / p0) / 100 : 0;
        if (dir !== "flat" || pct !== 0)
            price = ` ${fmtFloor(p0)}→${fmtFloor(p1)} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%) ${dir} dAFHO=${fmtAfho(a1 - a0)} dUSDC=${fmtUsdc(u1 - u0)}`;
    }
    if (!mark && !failed.startsWith("F") && price === "") continue; // skip the no-op sampling flood
    shown++;
    console.log(`${t} ${sg.signature.slice(0, 10)} ${failed}${mark ? ` [${mark}]` : ""}${price}`);
    await sleep(60);
}
console.log(`\n(${shown} shown of ${sigs.length} scanned — read-only; nothing was sent)`);
