// Read-only probe: does the Helius WebSocket path the app depends on actually
// deliver account-change notifications?
//
// Replicates exactly what the app does (web3.js derives wss://<same-host>/?api-key=…
// from VITE_RPC_URL) using the `ws` package from node_modules, subscribes to:
//   1. the MarketMetrics PDA  — written ~every 25s by the keeper's spot-ring
//      sampling txs (buy_the_dip no-op sampling)
//   2. the CPMM pool state    — written on every real swap
// and counts notifications for 75s. Also verifies the connection survives and
// logs any errors/closes — the "silent WS death" the stale-UI symptom implies.
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const env = fs.readFileSync(".env", "utf-8");
const RPC = (env.match(/^RPC_URL=(.+)$/m) || [null, ""])[1].trim();
const WS_URL = RPC.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
console.log("derived WS endpoint:", WS_URL.replace(/api-key=[^&]+/, "api-key=REDACTED"));

const d = JSON.parse(fs.readFileSync("app/public/deployment.json", "utf-8"));
const AMM = new PublicKey(d.ammProgram);
const MINT = new PublicKey(d.mint);
const CPMM = new PublicKey(d.raydiumProgram);
const metricsPda = PublicKey.findProgramAddressSync([Buffer.from("metrics"), MINT.toBuffer()], AMM)[0];
const poolState = new PublicKey(d.raydiumPool);

const ws = new WebSocket(WS_URL);
let events = 0, metricsN = 0, poolN = 0, confirmed = 0;
const t0 = Date.now();

ws.on("open", () => {
    console.log("WS open ✓");
    for (const [id, label, key] of [
        [1, "metrics", metricsPda.toBase58()],
        [2, "poolState", poolState.toBase58()],
    ]) {
        ws.send(JSON.stringify({
            jsonrpc: "2.0", id, method: "accountSubscribe",
            params: [key, { encoding: "base64", commitment: "confirmed" }],
        }));
    }
});
ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id === 1 || m.id === 2) {
        if (m.result !== undefined) { confirmed++; console.log(`subscribed ${m.id === 1 ? "metrics" : "poolState"} ✓ (sub id ${m.result})`); }
        else console.log(`subscribe ${m.id} FAILED:`, JSON.stringify(m.error));
        return;
    }
    if (m.method === "accountNotification") {
        events++;
        //区分: sub id 1 = metrics, 2 = pool
        const subId = m.params.subscription;
        if (subId === 1) { metricsN++; }
        else if (subId === 2) { poolN++; }
        console.log(`notification #${events} (sub=${subId === 1 ? "metrics" : "poolState"}) at +${Math.round((Date.now() - t0) / 1000)}s`);
    }
});
ws.on("error", (e) => console.log("WS error:", e.message));
ws.on("close", (c, r) => console.log(`WS closed code=${c} reason=${r} at +${Math.round((Date.now() - t0) / 1000)}s`));

setTimeout(() => {
    console.log(`\n=== 75s summary: confirmed=${confirmed}/2 subs, notifications=${events} (metrics=${metricsN}, poolState=${poolN}) ===`);
    console.log(confirmed === 2 && events > 0 ? "VERDICT: Helius WS path WORKS — notifications deliver." :
        confirmed === 2 && events === 0 ? "VERDICT: subscriptions confirmed but NO notifications in 75s — either the keeper is idle or writes bypass these accounts." :
        "VERDICT: WS path FAILED — subscriptions never confirmed.");
    process.exit(0);
}, 75000);
