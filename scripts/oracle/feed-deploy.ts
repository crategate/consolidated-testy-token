// Deploys the Switchboard oracle feeds NYSEH depends on, in one run:
//   1. Market status feed (massive.com primary, earningsapi.com fallback) -> u8 state
//   2. NYSEH price feed (Jupiter Price API v3) -> priceChange24h in centi-percent
//      (multiplyTask x100: 1.29% -> 129; negative moves stay negative)
//
// Feed IDs are deterministic from the job definitions, so reruns are idempotent.
// Writes both feed IDs + the canonical quote account to app/public/deployment.json
// for mev-keeper and the dashboard.
//
// Quote account is derived from queue + BOTH feed IDs. Order is pinned:
//   feeds[0] = market status, feeds[1] = price change.
//
// Usage: npx ts-node ./scripts/oracle/feed-deploy.ts   (or: anchor run feed-deploy)

import * as sb from "@switchboard-xyz/on-demand";
import { OracleJob, CrossbarClient, FeedHash } from "@switchboard-xyz/common";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { writeDeploymentState } from "../deployment-state";

dotenv.config();

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing env var: ${name}`);
    return value;
}

function loadMint(): string {
    if (process.env.NYSEH_MINT) return process.env.NYSEH_MINT;
    const deploymentPath = path.join(process.cwd(), "app", "public", "deployment.json");
    if (fs.existsSync(deploymentPath)) {
        const mint = JSON.parse(fs.readFileSync(deploymentPath, "utf-8")).mint;
        if (mint) return mint;
    }
    throw new Error("No mint found: set NYSEH_MINT or run the mint script first");
}

const marketStatusJob = OracleJob.fromObject({
    tasks: [
        {
            conditionalTask: {
                // maybe nested conditional for adding a 3rd API, alphavantage endpoint
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

function priceChangeJob(mint: string): OracleJob {
    return OracleJob.fromObject({
        tasks: [
            {
                httpTask: {
                    url: `https://api.jup.ag/price/v3?ids=${mint}`,
                    headers: [{ key: "x-api-key", value: "${JUP_API_KEY}" }],
                },
            },
            // Base58 mint is alphanumeric, so dot-notation JSONPath is safe here.
            { jsonParseTask: { path: `$.${mint}.priceChange24h` } },
            // Centi-percent: 1.29% -> 129. Keeps precision on-chain as an integer.
            { multiplyTask: { scalar: 100 } },
        ],
    });
}

async function main() {
    const { connection, keypair } = await sb.AnchorUtils.loadEnv();
    const queue = await sb.getDefaultQueue(connection.rpcEndpoint);
    const crossbar = CrossbarClient.default();
    const mint = loadMint();

    const statusFeed = { name: "NYSE market status", jobs: [{ tasks: marketStatusJob.tasks }] };
    const priceFeed = { name: `NYSEH priceChange24h (${mint})`, jobs: [{ tasks: priceChangeJob(mint).tasks }] };

    // Store job definitions on crossbar (idempotent) and compute feed IDs
    await crossbar.storeOracleFeed(statusFeed);
    await crossbar.storeOracleFeed(priceFeed);
    const statusFeedId = "0x" + FeedHash.computeOracleFeedId(statusFeed).toString("hex");
    const priceFeedId = "0x" + FeedHash.computeOracleFeedId(priceFeed).toString("hex");

    console.log("Market status feed ID:", statusFeedId);
    console.log("Price feed ID:      ", priceFeedId);

    // Order pinned: [0] = market status, [1] = price change
    const [quoteAccount] = sb.OracleQuote.getCanonicalPubkey(queue.pubkey, [
        statusFeedId,
        priceFeedId,
    ]);
    console.log("Quote account:      ", quoteAccount.toBase58());

    // First managed update creates the quote account on-chain.
    // On devnet the Jupiter feed will not resolve (token not indexed there) —
    // fall back to a status-only update so the deploy still succeeds.
    const overrides = {
        MASSIVE_API_KEY: requireEnv("MASSIVE_API_KEY"),
        EARNINGSAPI_KEY: requireEnv("EARNINGSAPI_KEY"),
        JUP_API_KEY: requireEnv("JUP_API_KEY"),
    };

    try {
        const ixs = await queue.fetchManagedUpdateIxs(
            crossbar,
            [statusFeedId, priceFeedId],
            { payer: keypair.publicKey, variableOverrides: overrides },
        );
        const tx = await sb.asV0Tx({
            connection,
            ixs,
            payer: keypair.publicKey,
            signers: [keypair],
        });
        const sig = await connection.sendTransaction(tx);
        console.log("Combined update sent:", sig);
    } catch (e) {
        console.warn(
            "Combined update failed (expected on devnet until Jupiter indexes the mint):",
            e instanceof Error ? e.message : e,
        );
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
        console.log("Status-only update sent:", sig);
        console.warn(
            "NOTE: quote account above covers BOTH feeds; the first combined update will create it once the price feed resolves.",
        );
    }

    writeDeploymentState({
        marketStatusFeedId: statusFeedId,
        priceFeedId: priceFeedId,
        oracleQuoteAccount: quoteAccount.toBase58(),
    });
    console.log("DEPLOY SUCCESS — feed IDs written to app/public/deployment.json");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});