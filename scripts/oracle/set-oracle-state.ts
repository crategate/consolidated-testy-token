import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import type { CrankOracle } from "../../target/types/crank_oracle";

// =============================================================================
// ORACLE STATE TEST SCRIPT — DEVNET / LOCALNET ONLY
// =============================================================================
// Usage: npx ts-node scripts/oracle/set-oracle-state.ts <state> [day] [ts]
//   state = 0 (Open), 1 (After Hours), 2 (Closed), 3 (Halted)
//   day   = optional explicit trading_day_index
//   ts    = optional unix timestamp for last_updated_timestamp
//
// Directly writes the MarketStatus PDA via crank_oracle::test_set_state,
// bypassing the Switchboard oracle entirely.
//
// ── DEVNET/TEST ONLY ─────────────────────────────────────────────────────────
// test_set_state has NO auth gate and must be REMOVED before mainnet (it is
// already on the "Before mainnet" checklist in AGENTS.md). The genesis-hash
// gate below is the mechanism that keeps this script off mainnet — it refuses
// any cluster except localnet/devnet. Keep both, and delete both together.
// ─────────────────────────────────────────────────────────────────────────────

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function isLocalnet(endpoint: string): boolean {
    try {
        const host = new URL(endpoint).hostname;
        return (
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "::1" ||
            host === "[::1]"
        );
    } catch {
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    const state = parseInt(args[0]);
    const dayArg = args[1] !== undefined ? parseInt(args[1]) : null;
    const tsArg = args[2] !== undefined ? parseInt(args[2]) : null;

    if (isNaN(state) || state < 0 || state > 3) {
        console.error(
            "Usage: npx ts-node scripts/oracle/set-oracle-state.ts <0|1|2|3> [day] [ts]"
        );
        console.error("  0 = Market Open");
        console.error("  1 = After Hours");
        console.error("  2 = Market Closed");
        console.error("  3 = Trading Halted");
        process.exit(1);
    }
    if (
        (dayArg !== null && (isNaN(dayArg) || dayArg < 0)) ||
        (tsArg !== null && isNaN(tsArg))
    ) {
        console.error("Invalid day/ts arguments.");
        process.exit(1);
    }

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // ── Devnet/localnet gate ────────────────────────────────────────────────
    const endpoint = provider.connection.rpcEndpoint;
    const genesisHash = await provider.connection.getGenesisHash();
    if (!isLocalnet(endpoint) && genesisHash !== DEVNET_GENESIS_HASH) {
        console.error(
            `REFUSING: set-oracle is a DEVNET/LOCALNET test tool.\n` +
                `  endpoint:     ${endpoint}\n` +
                `  genesis hash: ${genesisHash}\n` +
                `For real state changes, run the Switchboard keeper ` +
                `(scripts/oracle/mev-keeper.ts) instead.`
        );
        process.exit(1);
    }

    // Load crank oracle IDL
    const idlPath = path.join(
        process.cwd(),
        "target",
        "idl",
        "crank_oracle.json"
    );
    if (!fs.existsSync(idlPath)) {
        console.error("IDL not found. Run 'anchor build' first.");
        process.exit(1);
    }
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(
        idl,
        provider
    ) as unknown as anchor.Program<CrankOracle>;

    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        program.programId
    );

    // Initialize if the PDA doesn't exist yet (fresh devnet deployment).
    try {
        await program.methods
            .initializeState()
            .accountsPartial({
                marketStatus: marketStatusPda,
                payer: provider.wallet.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();
        console.log("Initialized market status account (state=99).");
    } catch {
        // Already initialized — continue.
    }

    // Read current state to derive sensible day/ts defaults.
    let oldState = 99;
    let currentDay = 0;
    try {
        const fetched = await program.account.marketStatus.fetch(
            marketStatusPda
        );
        if (fetched) {
            oldState = fetched.currentState as number;
            currentDay = fetched.tradingDayIndex.toNumber();
        }
    } catch {
        // Account exists but fetch failed — fall back to defaults.
    }

    // Mirror permissionless_crank's trading-day semantics: a 1/2 → 0
    // transition rolls the day index forward. An explicit day arg wins.
    const day =
        dayArg ??
        ((oldState === 1 || oldState === 2) && state === 0
            ? currentDay + 1
            : currentDay);
    const ts = tsArg ?? Math.floor(Date.now() / 1000);

    const tx = await program.methods
        .testSetState(state, new anchor.BN(day), new anchor.BN(ts))
        .accounts({ marketStatus: marketStatusPda })
        .rpc();

    console.log(
        `Cluster: ${isLocalnet(endpoint) ? "localnet" : "devnet"} ` +
            `(genesis ${genesisHash.slice(0, 8)}…)`
    );
    console.log(`Market Status PDA: ${marketStatusPda.toBase58()}`);
    console.log(
        `State: ${oldState} → ${state} | day index: ${day} | ts: ${ts}`
    );
    console.log(`Tx: ${tx}`);
    console.log(
        `\n!! DEVNET/TEST-ONLY instruction — remove test_set_state (and this script) before mainnet.`
    );
}

main().catch((e) => {
    console.error("Error:", e);
    process.exit(1);
});
