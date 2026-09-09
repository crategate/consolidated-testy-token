// Read-only demo: why the header ticker moves while NO swaps are happening.
//
// The ticker shows computeLivePrice() (app/src/context/chainDataHelpers.ts):
//   - the pool's 600s observation-ring TWAP while the ring is fresh+dense
//   - the instantaneous vault ratio once the ring is stale
// The TWAP's left edge ("oldest") is re-selected on every recompute: it is the
// newest observation at-or-before (now - 600s). As wall-clock advances with NO
// new swaps, that edge snaps forward from stored observation to stored
// observation, and each snap re-averages a different slice of history → the
// displayed value steps. Once now - latest > 600s the TWAP is declared stale
// and the display flips to the vault ratio (another jump).
//
// This tool fetches the ring + vaults ONCE, then replays the exact client
// math for now = (last swap) .. (last swap + 700s), printing every DISTINCT
// displayed value and why it changed. No transactions are sent.
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

function rpcUrl() {
    if (process.env.ANCHOR_PROVIDER_URL) return process.env.ANCHOR_PROVIDER_URL;
    const env = fs.readFileSync(".env", "utf-8");
    const m = env.match(/^RPC_URL=(.+)$/m);
    return m ? m[1].trim() : "https://api.devnet.solana.com";
}
const conn = new Connection(rpcUrl(), "confirmed");
const d = JSON.parse(fs.readFileSync("app/public/deployment.json", "utf-8"));
const MINT = new PublicKey(d.mint);
const USDC = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT");
const CPMM = new PublicKey(d.raydiumProgram);
const pool = new PublicKey(d.raydiumPool);
const vA = PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), pool.toBuffer(), MINT.toBuffer()], CPMM)[0];
const vU = PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), pool.toBuffer(), USDC.toBuffer()], CPMM)[0];
const obsKey = PublicKey.findProgramAddressSync([Buffer.from("observation"), pool.toBuffer()], CPMM)[0];

const [vAi, vUi, psi, obsi] = await conn.getMultipleAccountsInfo([vA, vU, pool, obsKey]);
const tok = (a) => (a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : 0n);
const afhoRaw = tok(vAi), usdcRaw = tok(vUi);
const vaultRatio = (usdcRaw * 1_000_000_000_000n) / afhoRaw; // floor units

// ── exact client mirror (chainDataHelpers.ts readTwapSample/q32ToFloor) ──
const HEADER = 43, NUM = 100, SIZE = 40, Q32 = 1n << 32n, FPOQ = 1_000_000_000_000n, W = 600n;
const pd = psi.data;
const mint0 = new PublicKey(pd.slice(168, 200)), mint1 = new PublicKey(pd.slice(200, 232));
const t0base = mint0.equals(MINT) && mint1.equals(USDC);
const t0quote = mint0.equals(USDC) && mint1.equals(MINT);
const read = (i) => {
    const s = HEADER + (i % NUM) * SIZE;
    const lo = obsi.data.readBigUInt64LE(s + 8), hi = obsi.data.readBigUInt64LE(s + 16);
    return { ts: obsi.data.readBigUInt64LE(s), cum: (hi << 64n) | lo };
};
const idx = obsi.data[9] | (obsi.data[10] << 8);
const latest = read(idx);

function displayAt(now) {
    // returns { src: 'twap'|'spot'|'unusable', value, dt, oldestTs }
    if (obsi.data[8] === 0 || latest.ts === 0n) return { src: "spot", value: vaultRatio };
    if (now < latest.ts || now - latest.ts > W) return { src: "spot", value: vaultRatio };
    let oldest = null;
    for (let step = 0; step < NUM; step++) {
        const o = read(idx + NUM - step);
        if (o.ts === 0n) break;
        oldest = o;
        if (o.ts <= now - W || o.ts <= latest.ts - W) break;
    }
    if (!oldest) return { src: "spot", value: vaultRatio };
    const dt = latest.ts - oldest.ts;
    if (dt === 0n) return { src: "spot", value: vaultRatio };
    if (dt > W * 2n) return { src: "spot", value: vaultRatio };
    const dcum = latest.cum >= oldest.cum ? latest.cum - oldest.cum : 0n;
    let twap = null;
    if (t0base) twap = (dcum * FPOQ) / dt / Q32;
    else if (t0quote && dcum !== 0n) twap = (dt * Q32 * FPOQ) / dcum;
    if (twap === null || twap <= 0n) return { src: "spot", value: vaultRatio };
    return { src: "twap", value: twap, dt, oldestTs: oldest.ts };
}

const usd = (n) => `$${(Number(n) / 1e9).toPrecision(6)}`;
console.log(`orientation: token0=${t0base ? "AFHO" : t0quote ? "USDC" : "?"} (base=${t0base ? "AFHO" : "USDC"})`);
console.log(`instant vault ratio (fallback spot): ${usd(vaultRatio)}  [constant without swaps]`);
console.log(`last swap wrote an observation at ${new Date(Number(latest.ts) * 1000).toISOString()}`);
console.log(`observations in ring: ${obsi.data[8] === 0 ? 0 : "ring initialized"}, index=${idx}`);
console.log(`\nreplay of what the ticker displays after the last swap, assuming ZERO further swaps:\n`);
let prev = null;
for (let rel = 0; rel <= 700; rel += 5) {
    const now = latest.ts + BigInt(rel);
    const r = displayAt(now);
    const key = `${r.src}:${r.value}`;
    if (key !== prev) {
        const why =
            prev === null ? "first compute (t=0)"
            : r.src === "spot" && prev?.startsWith("twap") ? "stale → FALLS BACK to vault ratio (jump)"
            : r.src === "twap" && prev?.startsWith("spot") ? "new swap would restore TWAP (not shown in this no-swap replay)"
            : r.src === "twap" ? `left edge snapped → window now [${new Date(Number(r.oldestTs) * 1000).toISOString().slice(11, 19)}, now], span ${r.dt}s (re-averaged)`
            : "";
        console.log(`  t+${String(rel).padStart(3)}s  ${r.src === "twap" ? "TWAP " : "SPOT "}${usd(r.value)}  ${why}`);
        prev = key;
    }
}
const current = displayAt(BigInt(Math.floor(Date.now() / 1000)));
console.log(`\nRIGHT NOW the browser computes: ${current.src === "twap" ? `TWAP ${usd(current.value)} (span ${current.dt}s)` : `vault-ratio spot ${usd(current.value)}`} — latest obs is ${Math.floor(Date.now() / 1000) - Number(latest.ts)}s old`);
console.log(`(refetches happen on every account-change WS event, throttled to 1 per 5s, plus the 30s poll — steps become visible at that cadence)`);
