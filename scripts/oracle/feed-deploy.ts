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

const marketStatusJob = OracleJob.fromObject({
    tasks: [
        {
            conditionalTask: {
                attempt: [
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
                            defaultValue: "6",
                        },
                    },
                ],
                onFailure: [
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
                            defaultValue: "6",
                        },
                    },
                ],
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
