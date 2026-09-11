import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import type { CrankOracle } from "../target/types/crank_oracle";

// =============================================================================
// DEVNET/LOCALNET RESET — WIPES TRADING-DAY CLOCK + AMM HISTORY + RECORDS LEDGER
// =============================================================================
// What this resets:
//   1. crank-oracle MarketStatus PDA  →  state 99 (fail-closed init sentinel),
//       trading_day_index 0, last_updated_timestamp 0 (initialize_state values).
//   2. AMM runtime bookkeeping       →  reset_devnet_state (devnet-only):
//       metrics (day_index, price_changes + sample_head, spot ring, stake
//       health, staked/supply snapshots), accepted_offers (day + 5d fills),
//       offer_list (day + sheet terms/counts), amm_state budgets/proceeds/
//       ratchet floor/untaken days. Pinned config + vault balances preserved.
//   3. app/public/records.json        →  { version: 1, rows: [] }
//   4. app/public/records/archives.json → { version: 1, archives: [] }
//   5. app/public/records/archive-<a>-<b>.{json,pdf}  →  deleted
//
// What this does NOT reset (no on-chain instruction wipes these; a truly fresh
// devnet is `anchor deploy` again + re-run the launch flow):
//   - staking pool totals/positions, vault + Raydium pool token balances
//   - the lazily-created alt_offer_list (state-3 sheet)
//
// Safety:
//   - Dry-run by default; set EXECUTE=1 to actually write.
//   - The AMM step calls the devnet-only `reset_devnet_state` instruction —
//     the AMM program must be (re)deployed with that instruction first
//     (`anchor build && anchor deploy`), or the call reverts `InstructionError`.
//   - Refuses any cluster except localnet/devnet via the devnet genesis hash
//     (same gate as scripts/oracle/set-oracle-state.ts). This is a
//     DEVNET/TEST-ONLY tool — remove before mainnet (MAINNET_CHECKLIST §2).
// =============================================================================

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const RECORDS_PATH = path.join(process.cwd(), "app", "public", "records.json");
const ARCHIVE_DIR = path.join(process.cwd(), "app", "public", "records");
const ARCHIVES_MANIFEST = path.join(ARCHIVE_DIR, "archives.json");
const DEPLOYMENT_PATH = path.join(process.cwd(), "app", "public", "deployment.json");

// Reset targets — identical to crank_oracle::initialize_state.
const RESET_STATE = 99;
const RESET_DAY = 0;
const RESET_TS = 0;

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

function printUsage(): void {
    console.log(
        [
            "Usage: anchor run reset-devnet",
            "       EXECUTE=1 anchor run reset-devnet   # actually write (default is dry-run)",
            "",
            "Resets the devnet trading-day clock, AMM history, and records ledger:",
            "  MarketStatus → state 99 (init sentinel), day 0, timestamp 0",
            "  AMM metrics / accepted_offers / offer_list / bookkeeping → zero",
            "  records.json → empty ledger",
            "  records/archives.json → empty manifest",
            "  records/archive-*.{json,pdf} → deleted",
            "",
            "DEVNET/LOCALNET ONLY — refuses mainnet.",
        ].join("\n"),
    );
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        printUsage();
        return;
    }
    const execute = process.env.EXECUTE === "1";

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // ── Devnet/localnet gate ────────────────────────────────────────────────
    const endpoint = provider.connection.rpcEndpoint;
    const genesisHash = await provider.connection.getGenesisHash();
    if (!isLocalnet(endpoint) && genesisHash !== DEVNET_GENESIS_HASH) {
        console.error(
            `REFUSING: reset-devnet is a DEVNET/LOCALNET test tool.\n` +
                `  endpoint:     ${endpoint}\n` +
                `  genesis hash: ${genesisHash}\n` +
                `For a real reset there is no mainnet path — mainnet state is ` +
                `immutable by design; use the launch flow on a fresh deployment instead.`,
        );
        process.exit(1);
    }

    // ── Load crank oracle IDL ───────────────────────────────────────────────
    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(idlPath)) {
        console.error("IDL not found. Run 'anchor build' first.");
        process.exit(1);
    }
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider) as unknown as anchor.Program<CrankOracle>;

    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        program.programId,
    );

    // ── Load AMM program + derive its zero-copy state PDAs ────────────────
    const ammIdlPath = path.join(process.cwd(), "target", "idl", "amm.json");
    if (!fs.existsSync(ammIdlPath)) {
        console.error("AMM IDL not found. Run 'anchor build' first.");
        process.exit(1);
    }
    const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf-8"));
    const mint = new PublicKey(deployment.mint);
    const ammIdl = JSON.parse(fs.readFileSync(ammIdlPath, "utf-8"));
    const ammProgram = new anchor.Program(ammIdl as anchor.Idl, provider);
    const ammPda = (seed: string) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from(seed), mint.toBuffer()],
            ammProgram.programId,
        )[0];

    // ── Read current state for the change report ────────────────────────────
    let current: { state: number; day: number; ts: number } | null = null;
    try {
        const fetched = await program.account.marketStatus.fetch(marketStatusPda);
        if (fetched) {
            current = {
                state: fetched.currentState as number,
                day: fetched.tradingDayIndex.toNumber(),
                ts: fetched.lastUpdatedTimestamp.toNumber(),
            };
        }
    } catch {
        current = null;
    }

    console.log(
        `Cluster: ${isLocalnet(endpoint) ? "localnet" : "devnet"} ` +
            `(genesis ${genesisHash.slice(0, 8)}…)`,
    );
    console.log(`Market Status PDA: ${marketStatusPda.toBase58()}`);
    console.log(
        current
            ? `On-chain now:     state ${current.state} | day ${current.day} | ts ${current.ts}`
            : "On-chain now:     (account not initialized)",
    );
    console.log(`On-chain reset:   state ${RESET_STATE} | day ${RESET_DAY} | ts ${RESET_TS}`);
    console.log(
        `AMM reset:        metrics / accepted_offers / offer_list / amm bookkeeping → zero`,
    );
    console.log(`Records reset:    ${path.relative(process.cwd(), RECORDS_PATH)} → empty`);
    console.log(`Archives reset:   ${path.relative(process.cwd(), ARCHIVE_DIR)} → cleared`);

    if (!execute) {
        console.log("\nDry run — no writes. Re-run with EXECUTE=1 to apply.");
        return;
    }

    // ── On-chain: ensure PDA exists, then force the init-sentinel values ────
    try {
        await program.methods
            .initializeState()
            .accountsPartial({
                marketStatus: marketStatusPda,
                payer: provider.wallet.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();
    } catch {
        // Already initialized — the reset write below will overwrite it.
    }

    const tx = await program.methods
        .testSetState(RESET_STATE, new anchor.BN(RESET_DAY), new anchor.BN(RESET_TS))
        .accounts({ marketStatus: marketStatusPda })
        .rpc();

    // ── AMM runtime state → zero (devnet-only instruction) ───────────────
    // Resize first so the offer_list zero-copy load can't fail on a
    // pre-widening (devnet-big) account; migrate is an idempotent no-op once
    // the account is the current size.
    await ammProgram.methods
        .migrateOfferList()
        .accountsStrict({
            authority: provider.wallet.publicKey,
            ammState: ammPda("amm_state"),
            offerList: ammPda("offer_list"),
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    const ammTx = await ammProgram.methods
        .resetDevnetState()
        .accountsStrict({
            authority: provider.wallet.publicKey,
            ammState: ammPda("amm_state"),
            metrics: ammPda("metrics"),
            acceptedOffers: ammPda("accepted_offers"),
            offerList: ammPda("offer_list"),
        })
        .rpc();

    // ── Local records ledger + archives ─────────────────────────────────────
    fs.writeFileSync(
        RECORDS_PATH,
        JSON.stringify({ version: 1, rows: [] }, null, 2) + "\n",
    );
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.writeFileSync(
        ARCHIVES_MANIFEST,
        JSON.stringify({ version: 1, archives: [] }, null, 2) + "\n",
    );
    for (const f of fs.readdirSync(ARCHIVE_DIR)) {
        if (/^archive-\d+-\d+\.(json|pdf)$/.test(f)) {
            fs.rmSync(path.join(ARCHIVE_DIR, f));
        }
    }

    console.log("\nReset complete.");
    console.log(`  market status tx: ${tx}`);
    console.log(`  amm reset tx:     ${ammTx}`);
    console.log("  records.json → empty ledger");
    console.log("  records/archives.json → empty manifest");
    console.log("  archive-*.{json,pdf} deleted");
    console.log(
        "\n!! DEVNET/TEST-ONLY — remove this script (and the anchor label) before mainnet (MAINNET_CHECKLIST §2).",
    );
}

main().catch((e) => {
    console.error("Error:", e);
    process.exit(1);
});
