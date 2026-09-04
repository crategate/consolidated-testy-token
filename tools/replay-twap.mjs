// Replay the Rust read_twap/q32_to_floor against the live observation account,
// plus derive the pool PDAs for both mint orders.
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const CPMM = new PublicKey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
const CONFIG = new PublicKey("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDCoct = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT");
const USDC_DEV = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const AFHO = new PublicKey("2q9X78MuZHEgPf3vzvSRFPPUdzbXxP28hpPK8KrTU439");

const poolPda = (mintA, mintB) => {
    const [t0, t1] = mintA.toBuffer() <= mintB.toBuffer() ? [mintA, mintB] : [mintB, mintA];
    return PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), CONFIG.toBuffer(), t0.toBuffer(), t1.toBuffer()],
        CPMM
    )[0];
};
console.log("PDA(WSOL,USDCoct) =", poolPda(WSOL, USDCoct).toBase58());
console.log("PDA(WSOL,4zMMC)   =", poolPda(WSOL, USDC_DEV).toBase58());
console.log("PDA(AFHO,USDCoct) =", poolPda(AFHO, USDCoct).toBase58());
console.log("PDA(USDCoct,AFHO) =", poolPda(USDCoct, AFHO).toBase58());

// AFHO/USDC pool (F7X658) — replay the observation read exactly like raydium.rs
const pool = new PublicKey("F7X658hVjDaEWsobdSdHDAsisUhwr5q8sNS7CeaaU1B2");
const [obsKey] = PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), pool.toBuffer()],
    CPMM
);
const o = await conn.getAccountInfo(obsKey, "confirmed");
const d = o.data;
const HEADER = 8 + 1 + 2 + 32; // 43
const DISC = 8;
const OBS = 100;
const size = 40;
const init = d[DISC];
const idx = d.readUInt16LE(DISC + 1);
console.log("\nAFHO/USDC observation:", { init, idx });
const read = (i) => {
    const s = HEADER + (i % OBS) * size;
    return {
        ts: d.readBigUInt64LE(s),
        c0: d.readBigUInt64LE(s + 8),
        c1: d.readBigUInt64LE(s + 24),
    };
};
// cumulative_token_0_price_x32 is u128: low 8 bytes at s+8, high 8 at s+16
const read128 = (i) => {
    const s = HEADER + (i % OBS) * size;
    const lo = d.readBigUInt64LE(s + 8);
    const hi = d.readBigUInt64LE(s + 16);
    return (hi << 64n) | lo;
};
for (let i = 0; i < 8; i++) {
    const oi = read(i);
    const c = read128(i);
    console.log(`  obs[${i}] ts=${oi.ts} cum0=${c}`);
}

// Replay read_twap_token0_in_token1 with now = current time
const now = BigInt(Math.floor(Date.now() / 1000));
const WINDOW = 600n;
const Q32 = 1n << 32n;
const latest = read(idx % OBS);
console.log("latest obs (index", idx % OBS, "): ts =", latest.ts, "now =", now);
if (init === 1 && latest.ts !== 0n) {
    let oldest = null;
    for (let step = 0; step < OBS; step++) {
        const i = (idx + OBS - step) % OBS;
        const oi = read(i);
        if (oi.ts === 0n) break;
        oldest = i;
        if (oi.ts <= now - WINDOW || oi.ts <= latest.ts - WINDOW) break;
    }
    if (oldest !== null) {
        const oOld = read(oldest);
        const dt = latest.ts - oOld.ts;
        const dcum = read128(idx % OBS) - read128(oldest);
        console.log("oldest index:", oldest, "ts:", oOld.ts, "dt:", dt);
        let twap = null;
        if (dt !== 0n) {
            if (dt <= WINDOW * 2n) twap = dcum / dt;
            console.log("dcum:", dcum, "twap_q32 (token1 per token0, raw):", twap);
        }
        if (twap !== null && twap !== 0n) {
            // q32_to_floor with token_0=USDC, token_1=AFHO, base=AFHO, quote=USDC → invert
            const priceQ32 = (Q32 * Q32) / twap;
            for (const fpq of [1_000_000_000n, 1_000_000_000_000n]) {
                const floor = (priceQ32 * fpq) / Q32;
                console.log(`  FPOQ32=${fpq}: floor=${floor} (price×1e9 should be ~2500)`);
            }
        }
    } else {
        console.log("ring: no usable oldest → fallback would be used");
    }
} else {
    console.log("ring not initialized or latest ts == 0 → vault-ratio fallback used");
}
