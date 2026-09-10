// Deploys the AFHO Switchboard oracle: a single NYSE market-status feed.
// No price feed — momentum is a self-sampled close→close change computed
// on-chain from the spot oracle, so Switchboard is status-only.
//
// The feed ID is deterministic from the job definition (reruns idempotent).
// Writes the feed ID + canonical quote account to app/public/deployment.json.
//
// Usage: npx ts-node ./scripts/oracle/feed-deploy.ts   (or: anchor run feed-deploy)

import * as sb from "@switchboard-xyz/on-demand";
import { OracleJob, CrossbarClient, FeedHash } from "@switchboard-xyz/common";
import * as dotenv from "dotenv";
import { writeDeploymentState } from "../deployment-state";

dotenv.config();

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing env var: ${name}`);
    return value;
}

// Dual-source halt gate (2026-09-10):
//
// A single API claiming "halted" must be CONFIRMED by the second source
// before the feed reports state 3 — the halt state now drives the alt
// bond sheet (5% of the vault at 3–5% off) plus the highest exit
// penalties, so an oracle glitch must not be able to fire them.
//
// Structure:
//   comparisonTask #1  lhs = massive chain (nested job)  op = EQUAL  rhs = 3
//     onFalse  → massive chain again (every non-3 value passes through
//                untouched — routine states stay single-source, no change)
//     onTrue   → comparisonTask #2  lhs = earnings chain  op = EQUAL  rhs = 3
//                  onTrueValue  = "3"  both sources agree → confirmed halt
//                  onFalse      → earnings chain job (disagreement → the
//                                 SECOND source's real reading wins: never
//                                 fabricate a state the second API didn't
//                                 report; a massive-side glitch degrades to
//                                 earnings' honest value)
//                  onFailureValue = "3"  earnings DOWN while massive claims
//                                 a halt → trust the primary (a simultaneous
//                                 primary glitch + secondary outage is the
//                                 only hole; flip to "0" to fail closed
//                                 instead — tradeoff documented here)
//     onFailure → earnings chain (existing failover, unchanged)
//
// NOTE: the job hash (feed id) changes with this definition → new canonical
// quote account. Re-run feed-deploy to store + go live; the keeper derives
// the quote from app/public/deployment.json each run, so no program change
// is needed (the crank validates the quote against its own embedded feed
// ids, not a pinned id).
const massiveAttempt: OracleJob.ITask[] = [
    {
        httpTask: {
            url: "https://api.massive.com/v1/marketstatus/now?apiKey=${MASSIVE_API_KEY}",
        },
    },
    { jsonParseTask: { path: "$.exchanges.nyse" } },
    {
        stringMapTask: {
            mappings: [
                { key: '"open"', value: "0" },
                { key: '"extended-hours"', value: "1" },
                { key: '"closed"', value: "2" },
                { key: '"halted"', value: "3" },
            ],
            defaultValue: "0",
        },
    },
];

const earningsFallback: OracleJob.ITask[] = [
    {
        httpTask: {
            url: "https://api.earningsapi.com/v1/market-status?apikey=${EARNINGSAPI_KEY}",
        },
    },
    { jsonParseTask: { path: "$.currentMarketStatus" } },
    {
        stringMapTask: {
            mappings: [
                { key: '"open"', value: "0" },
                { key: '"pre-market"', value: "1" },
                { key: '"after-hours"', value: "1" },
                { key: '"closed"', value: "2" },
                { key: '"halted"', value: "3" },
            ],
            defaultValue: "0",
        },
    },
];

const marketStatusJob = OracleJob.fromObject({
    tasks: [
        {
            comparisonTask: {
                op: OracleJob.ComparisonTask.Operation.OPERATION_EQ,
                lhs: { tasks: massiveAttempt },
                rhsValue: "3",
                onTrue: {
                    tasks: [
                        {
                            comparisonTask: {
                                op: OracleJob.ComparisonTask.Operation.OPERATION_EQ,
                                lhs: { tasks: earningsFallback },
                                rhsValue: "3",
                                onTrueValue: "3",
                                onFalse: { tasks: earningsFallback },
                                onFailureValue: "3",
                            },
                        },
                    ],
                },
                onFalse: { tasks: massiveAttempt },
                onFailure: { tasks: earningsFallback },
            },
        },
    ],
});

async function main() {
    const { connection, keypair } = await sb.AnchorUtils.loadEnv();
    const queue = await sb.getDefaultQueue(connection.rpcEndpoint);
    const crossbar = CrossbarClient.default();

    const statusFeed = { name: "NYSE market status", jobs: [{ tasks: marketStatusJob.tasks }] };

    // Store the job definition on crossbar (idempotent) and compute the feed ID.
    await crossbar.storeOracleFeed(statusFeed);
    const statusFeedId = "0x" + FeedHash.computeOracleFeedId(statusFeed).toString("hex");
    console.log("Market status feed ID:", statusFeedId);

    // Status-only quote account.
    const [quoteAccount] = sb.OracleQuote.getCanonicalPubkey(queue.pubkey, [statusFeedId]);
    console.log("Quote account:      ", quoteAccount.toBase58());

    const overrides = {
        MASSIVE_API_KEY: requireEnv("MASSIVE_API_KEY"),
        EARNINGSAPI_KEY: requireEnv("EARNINGSAPI_KEY"),
    };

    const ixs = await queue.fetchManagedUpdateIxs(crossbar, [statusFeedId], {
        payer: keypair.publicKey,
        variableOverrides: overrides,
    });
    const tx = await sb.asV0Tx({
        connection,
        ixs,
        payer: keypair.publicKey,
        signers: [keypair],
    });
    const sig = await connection.sendTransaction(tx);
    console.log("Status update sent:", sig);

    writeDeploymentState({
        marketStatusFeedId: statusFeedId,
        oracleQuoteAccount: quoteAccount.toBase58(),
    });
    console.log("DEPLOY SUCCESS — status feed written to app/public/deployment.json");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
