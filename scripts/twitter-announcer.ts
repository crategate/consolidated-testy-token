// Twitter announcer bot for AFHO protocol events.
//
// Read-only watcher: polls the AMM / crank-oracle / staking accounts and posts
// a tweet for each notable protocol event:
//
//   1. Daily bond offer sheet goes up for sale (bond sizes / discounts / vesting days)
//   2. Daily buyback completes (AFHO purchased, average price, USDC spent)
//   3. Buy-the-dip trigger (AFHO bought, price, remaining dip vault)
//   4. Market-state changes (with the associated unstake fee)
//   5. Monday market open (open + fee + % supply staked + bond vault remaining)
//
// Credentials (X developer portal → "Keys and tokens"):
//   X_CONSUMER_KEY         API key / consumer key
//   X_CONSUMER_SECRET      API secret / consumer secret (legacy: SECRET_KEY)
//   X_ACCESS_TOKEN         Access token (user context)
//   X_ACCESS_TOKEN_SECRET  Access token secret
//
// NOTE: posting as your own account requires the OAuth 1.0a *user context*
// token pair (X_ACCESS_TOKEN + X_ACCESS_TOKEN_SECRET) in addition to the app
// consumer key/secret. Generate them from the same portal page.
//
// Flags:
//   DEVNET_MODE  "true" prepends "devnet testing: " to every announcement
//   DRY_RUN      "true" logs the tweet text instead of hitting the X API
//   POLL_INTERVAL_MS  poll cadence (default 60000)
//
// Run: npx ts-node scripts/twitter-announcer.ts
//
// This is a read-only observer. It does NOT hold a signer and does NOT move
// any funds — it only watches account state and posts announcements.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import * as https from "https";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

// ════════════════════════════════════════════════════════════════════════════
// MESSAGE DEFINITIONS — all tweet copy lives here. Edit this block only.
// ════════════════════════════════════════════════════════════════════════════

// Prepended to every announcement when devnet mode is enabled.
export const DEVNET_PREFIX = "devnet testing: ";

// crank-oracle market-status mapping (0=open, 1=after-hours, 2=closed, 3=halted).
const MARKET_NAMES: Record<number, string> = {
  0: "OPEN",
  1: "AFTER-HOURS",
  2: "CLOSED",
  3: "HALTED",
};

// Lot-sizer tiers → whole AFHO tokens per lot (programs/amm state lot_sizer).
const LOT_SIZER: number[] = [
  0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000, 15000,
  20000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000,
];

// ── number formatting (copy-facing) ──────────────────────────────────────────

export function formatWhole(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function formatUsdc(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatAfho(n: number): string {
  if (n >= 1000) return formatWhole(n);
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function formatPrice(p: number): string {
  const decimals = p < 0.01 ? 6 : p < 1 ? 4 : 2;
  return `$${p.toFixed(decimals)}`;
}

// Unstake fee label for a market state. Open = no fee; otherwise the staking
// pool's penalty tier (bps) for that state, shown as a whole/tenth percent.
export function unstakeFeeLabel(pool: any, state: number): string {
  if (state === 0) return "no unstake fee";
  const bpsByState: Record<number, number> = {
    1: pool.afterHoursPenaltyBps as number,
    2: pool.closedPenaltyBps as number,
    3: pool.haltedPenaltyBps as number,
  };
  const bps = bpsByState[state] ?? 0;
  const pct = bps / 100;
  const label = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${label}% unstake fee`;
}

// ── event messages ───────────────────────────────────────────────────────────

type TierLine = { size: number; discountPct: number; vestingDays: number };

function tierLine(name: string, tier: TierLine): string {
  return `${name}: ${formatWhole(tier.size)} AFHO @ ${tier.discountPct.toFixed(
    1
  )}% discount · ${tier.vestingDays}d vest`;
}

// 1. Bond offer sheet posted for the night desk.
export function bondsMessage(sheet: {
  big: TierLine;
  med: TierLine;
  sml: TierLine;
}): string {
  const lines: string[] = ["🚨 AFHO bonds are up for sale"];
  if (sheet.big.size > 0) lines.push(tierLine("Big", sheet.big));
  if (sheet.med.size > 0) lines.push(tierLine("Med", sheet.med));
  if (sheet.sml.size > 0) lines.push(tierLine("Sml", sheet.sml));
  return lines.join("\n");
}

// 2. Daily buyback drained the buyback vault.
export function buybackCompleteMessage(
  afho: number,
  avgPrice: number,
  usdc: number
): string {
  return `💸 Daily buyback complete: ${formatAfho(afho)} AFHO @ ${formatPrice(
    avgPrice
  )} avg for ${formatUsdc(usdc)} USDC`;
}

// 3. Buy-the-dip slice fired.
export function dipBuyMessage(
  afho: number,
  price: number,
  dipUsdcRemaining: number
): string {
  return `📉 Buy the dip: bought ${formatAfho(afho)} AFHO @ ${formatPrice(
    price
  )} · ${formatUsdc(dipUsdcRemaining)} USDC left in dip vault`;
}

// 4. Market state changed.
export function marketStateMessage(state: number, feeLabel: string): string {
  return `🔔 Market ${MARKET_NAMES[state] ?? state} · ${feeLabel}`;
}

// 5. Monday market open (richer variant of the market-open message).
export function mondayOpenMessage(
  feeLabel: string,
  stakePct: number,
  bondVaultWhole: number
): string {
  return `🌅 Monday open · ${feeLabel} · ${stakePct.toFixed(
    1
  )}% of supply staked · ${formatWhole(bondVaultWhole)} AFHO in bond vault`;
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIG & CREDENTIALS
// ════════════════════════════════════════════════════════════════════════════

const X_CONSUMER_KEY = process.env.X_CONSUMER_KEY ?? "";
const X_CONSUMER_SECRET =
  process.env.X_CONSUMER_SECRET ?? process.env.SECRET_KEY ?? "";
const X_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN ?? "";
const X_ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET ?? "";
const X_API_BASE = process.env.X_API_BASE ?? "https://api.twitter.com";

const DEVNET_MODE = ["true", "1", "yes"].includes(
  (process.env.DEVNET_MODE ?? "").toLowerCase()
);
const DRY_RUN = ["true", "1", "yes"].includes(
  (process.env.DRY_RUN ?? "").toLowerCase()
);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const RPC_URL =
  process.env.RPC_URL ??
  process.env.ANCHOR_PROVIDER_URL ??
  "https://api.devnet.solana.com";

export function isMondayEt(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  return parts === "Mon";
}

// ════════════════════════════════════════════════════════════════════════════
// X API (OAuth 1.0a user context) — self-contained, no extra dependency.
// ════════════════════════════════════════════════════════════════════════════

export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function oauthAuthorizationHeader(
  method: string,
  url: string,
  extraOAuthParams: Record<string, string> = {}
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: X_CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: "1.0",
    ...extraOAuthParams,
  };

  const paramString = Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(oauth[k])}`)
    .join("&");

  const baseString = `${method}&${percentEncode(url)}&${percentEncode(
    paramString
  )}`;
  const signingKey = `${percentEncode(X_CONSUMER_SECRET)}&${percentEncode(
    X_ACCESS_TOKEN_SECRET
  )}`;
  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  const headerParams = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ")
  );
}

function postTweet(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${X_API_BASE}/2/tweets`);
    const body = JSON.stringify({ text });
    const authorization = oauthAuthorizationHeader("POST", url.toString());

    const req = https.request(
      {
        method: "POST",
        host: url.hostname,
        port: 443,
        path: url.pathname,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "afho-twitter-announcer",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`X API ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function announce(text: string): Promise<void> {
  const body = DEVNET_MODE ? DEVNET_PREFIX + text : text;
  if (body.length > 280) {
    console.warn(`⚠️ tweet exceeds 280 chars (${body.length}):\n${body}`);
  }
  if (DRY_RUN) {
    console.log(`[dry-run] would tweet:\n${body}\n`);
    return;
  }
  await postTweet(body);
  console.log(`[tweeted] ${body.replace(/\n/g, " ")}`);
}

// ════════════════════════════════════════════════════════════════════════════
// CHAIN READS
// ════════════════════════════════════════════════════════════════════════════

function loadDeployment(): any {
  const p = path.join(process.cwd(), "app", "public", "deployment.json");
  if (!fs.existsSync(p)) throw new Error(`deployment.json not found at ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function loadIdl(name: string): anchor.Idl {
  const p = path.join(process.cwd(), "target", "idl", `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`IDL not found at ${p}. Run 'anchor build' first.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function programFor(name: string, provider: anchor.Provider): anchor.Program {
  return new anchor.Program(loadIdl(name), provider);
}

const num = (x: any): number => (x as anchor.BN).toNumber();

function lotSize(tier: number): number {
  return LOT_SIZER[tier] ?? 0;
}

function tierSize(offer: any): number {
  return lotSize(offer.lotSize) * num(offer.totalOffered);
}

function offerListEmpty(offerList: any): boolean {
  return (
    tierSize(offerList.bigOffer) === 0 &&
    tierSize(offerList.medOffer) === 0 &&
    tierSize(offerList.smlOffer) === 0
  );
}

function buildSheet(offerList: any): {
  big: TierLine;
  med: TierLine;
  sml: TierLine;
} {
  const toTier = (offer: any): TierLine => ({
    size: tierSize(offer),
    discountPct: num(offer.discountBps) / 10, // stored tenths of a percent
    vestingDays: num(offer.vestingDays),
  });
  return {
    big: toTier(offerList.bigOffer),
    med: toTier(offerList.medOffer),
    sml: toTier(offerList.smlOffer),
  };
}

function toWhole(raw: number, decimals: number): number {
  return raw / Math.pow(10, decimals);
}

async function tokenBalanceRaw(
  connection: Connection,
  account: PublicKey
): Promise<number> {
  const info = await connection.getTokenAccountBalance(account);
  return Number(info.value.amount);
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  if (!DRY_RUN) {
    const missing = [
      ["X_CONSUMER_KEY", X_CONSUMER_KEY],
      ["X_CONSUMER_SECRET", X_CONSUMER_SECRET],
      ["X_ACCESS_TOKEN", X_ACCESS_TOKEN],
      ["X_ACCESS_TOKEN_SECRET", X_ACCESS_TOKEN_SECRET],
    ]
      .filter(([, v]) => v === "")
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `Missing X credentials: ${missing.join(", ")}. ` +
          `Set them in .env, or run with DRY_RUN=true to preview messages.`
      );
    }
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(anchor.web3.Keypair.generate()), // read-only: never signs
    { commitment: "confirmed" }
  );

  const deployment = loadDeployment();
  const afhoMint = new PublicKey(deployment.mint);
  const ammProgramId = new PublicKey(deployment.ammProgram);
  const crankProgramId = new PublicKey(deployment.crankProgram);
  const stakingProgramId = new PublicKey(deployment.stakingProgram);

  const ammProgram = programFor("amm", provider);
  const crankProgram = programFor("crank_oracle", provider);
  const stakingProgram = programFor("staking", provider);
  // Override program ids — IDL files carry the correct declared ids already,
  // but pin them from deployment.json to match the deployed programs.
  (ammProgram as any).programId = ammProgramId;
  (crankProgram as any).programId = crankProgramId;
  (stakingProgram as any).programId = stakingProgramId;

  const [ammStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_state"), afhoMint.toBuffer()],
    ammProgramId
  );
  const [marketStatusPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market_status")],
    crankProgramId
  );

  // Token decimals are immutable; resolve once.
  const ammState0 = await (ammProgram.account as any).ammState.fetch(
    ammStatePda
  );
  const afhoMintInfo = await connection.getTokenSupply(afhoMint);
  const afhoDecimals = afhoMintInfo.value.decimals;
  const usdcMintInfo = await connection.getTokenSupply(
    new PublicKey(ammState0.usdcMint)
  );
  const usdcDecimals = usdcMintInfo.value.decimals;

  console.log("🔍 AFHO twitter announcer started");
  console.log("  cluster:", RPC_URL);
  console.log("  ammState:", ammStatePda.toBase58());
  console.log("  marketStatus:", marketStatusPda.toBase58());
  console.log("  devnet mode:", DEVNET_MODE);
  console.log("  dry run:", DRY_RUN);
  console.log("  poll interval (ms):", POLL_INTERVAL_MS);

  // ── cross-poll event memory ────────────────────────────────────────────────
  let initialized = false;
  let prevState = -1;
  let prevOfferDayIndex = -1;
  let prevAfhoVaultRaw = 0;
  let prevDipSpentUsdc = 0;
  let prevDipSliceCount = 0;
  // Snapshot of the AFHO bond vault at the start of today's buyback window.
  let buybackSnapshot: { day: number; afhoRaw: number } | null = null;
  let lastReportedBuybackDay = -1;

  while (true) {
    try {
      const ammState = await (ammProgram.account as any).ammState.fetch(
        ammStatePda
      );
      const marketStatus = await (
        crankProgram.account as any
      ).marketStatus.fetch(marketStatusPda);
      const offerList = await (ammProgram.account as any).offerList.fetch(
        ammState.offerList
      );
      const stakingPool = await (stakingProgram.account as any).stakePool.fetch(
        ammState.stakingPool
      );

      const state = marketStatus.currentState as number;
      const marketDay = num(marketStatus.tradingDayIndex);

      const afhoVaultRaw = await tokenBalanceRaw(
        connection,
        new PublicKey(ammState.afhoVault)
      );
      const usdcVaultRaw = await tokenBalanceRaw(
        connection,
        new PublicKey(ammState.usdcVault)
      );
      const usdcDipRaw = await tokenBalanceRaw(
        connection,
        new PublicKey(ammState.usdcDip)
      );

      const bbDay = num(ammState.bbDayIndex);
      const bbSpentUsdc = num(ammState.bbSpentUsdc);
      const dipSpentUsdc = num(ammState.dipSpentUsdc);
      const dipSliceCount = ammState.dipSliceCount as number;
      const offerDay = num(offerList.dayIndex);

      // Buyback baseline: prefer the freshest pre-open afho_vault read when we
      // first see market open; fall back to a mid-buyback startup snapshot.
      if (initialized && prevState !== 0 && state === 0) {
        buybackSnapshot = { day: marketDay, afhoRaw: prevAfhoVaultRaw };
      }
      if (
        (!buybackSnapshot || buybackSnapshot.day !== marketDay) &&
        bbDay === marketDay &&
        usdcVaultRaw > 0
      ) {
        buybackSnapshot = { day: marketDay, afhoRaw: afhoVaultRaw };
      }

      if (initialized) {
        // ── 1/5: market-state change (Monday open gets the richer message) ──
        if (state !== prevState) {
          const feeLabel = unstakeFeeLabel(stakingPool, state);
          if (state === 0 && isMondayEt()) {
            const totalSupplyRaw = Number(
              (await connection.getTokenSupply(afhoMint)).value.amount
            );
            const stakePct =
              totalSupplyRaw > 0
                ? (num(stakingPool.totalStaked) / totalSupplyRaw) * 100
                : 0;
            await announce(
              mondayOpenMessage(
                feeLabel,
                stakePct,
                toWhole(afhoVaultRaw, afhoDecimals)
              )
            );
          } else {
            await announce(marketStateMessage(state, feeLabel));
          }
        }

        // ── 2: bond sheet posted for the night desk ─────────────────────────
        if (offerDay !== prevOfferDayIndex && !offerListEmpty(offerList)) {
          await announce(bondsMessage(buildSheet(offerList)));
        }

        // ── 3: daily buyback drained the buyback vault ──────────────────────
        if (
          buybackSnapshot &&
          buybackSnapshot.day === marketDay &&
          usdcVaultRaw === 0 &&
          bbSpentUsdc > 0 &&
          lastReportedBuybackDay !== marketDay
        ) {
          const afhoBought = toWhole(
            afhoVaultRaw - buybackSnapshot.afhoRaw,
            afhoDecimals
          );
          const usdcSpent = toWhole(bbSpentUsdc, usdcDecimals);
          if (afhoBought > 0 && usdcSpent > 0) {
            await announce(
              buybackCompleteMessage(
                afhoBought,
                usdcSpent / afhoBought,
                usdcSpent
              )
            );
            lastReportedBuybackDay = marketDay;
          }
          buybackSnapshot = null;
        }

        // ── 4: buy-the-dip slice fired ──────────────────────────────────────
        if (
          dipSliceCount > prevDipSliceCount ||
          dipSpentUsdc > prevDipSpentUsdc
        ) {
          const afhoBought = toWhole(
            afhoVaultRaw - prevAfhoVaultRaw,
            afhoDecimals
          );
          const usdcSpent = toWhole(
            dipSpentUsdc - prevDipSpentUsdc,
            usdcDecimals
          );
          const price = afhoBought > 0 ? usdcSpent / afhoBought : 0;
          const dipRemaining = toWhole(usdcDipRaw, usdcDecimals);
          await announce(dipBuyMessage(afhoBought, price, dipRemaining));
        }
      }

      // ── advance cross-poll memory ──────────────────────────────────────────
      prevState = state;
      prevOfferDayIndex = offerDay;
      prevAfhoVaultRaw = afhoVaultRaw;
      prevDipSpentUsdc = dipSpentUsdc;
      prevDipSliceCount = dipSliceCount;
      initialized = true;
    } catch (e) {
      console.error("❌ poll failed:", (e as Error).message);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("❌ announcer fatal:", e);
    process.exit(1);
  });
}
