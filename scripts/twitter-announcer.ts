// AFHO announcement bot — posts protocol events to X (Twitter) and/or Telegram.
//
// Read-only watcher: polls the AMM / crank-oracle / staking accounts and posts
// an announcement for each notable protocol event:
//
//   1. Daily bond offer sheet goes up for sale (bond sizes / discounts / vesting days)
//   2. Daily buyback completes (AFHO purchased, average price, USDC spent)
//   3. Buy-the-dip trigger (AFHO bought, price, remaining dip vault)
//   4. Market-state changes (with the associated unstake fee)
//   4b. Closed-session flash sale: AFTER-HOURS → CLOSED with bonds still on
//       the sheet — every remaining tier is 0.5% deeper for the closed window
//   5. Monday market open (open + fee + % supply staked + bond vault remaining)
//
// All post copy lives in the MESSAGE DEFINITIONS block at the top of this
// file. Copy supports SEO-style "text spinning": {a|b|c} groups pick one
// option at random (nesting works) and each event has several full-template
// variants, so repeated announcements read differently. Spinning runs once
// per channel, so X and Telegram get their own wording.
//
// X (Twitter) credentials — X developer portal → "Keys and tokens":
//   X_CONSUMER_KEY         API key / consumer key
//   X_CONSUMER_SECRET      API secret / consumer secret (legacy: SECRET_KEY)
//   X_ACCESS_TOKEN         Access token (user context)
//   X_ACCESS_TOKEN_SECRET  Access token secret
//
//   NOTE: posting as your own account requires the OAuth 1.0a *user context*
//   token pair (X_ACCESS_TOKEN + X_ACCESS_TOKEN_SECRET) in addition to the app
//   consumer key/secret. Generate them from the same portal page.
//
// Telegram credentials — Bot API (no SDK, no login flow):
//   TELEGRAM_BOT_TOKEN     token from @BotFather (/newbot → copy the token)
//   TELEGRAM_CHANNEL_ID    channel to post into: @username or -100… numeric id
//
//   The bot must be an ADMIN of that channel with "Post messages" enabled.
//   Setup takes ~2 minutes: @BotFather → /newbot → name it → copy the token,
//   create the channel, add the bot as an admin, set the two env vars.
//
// Flags:
//   X_ENABLED / TG_ENABLED  channel switches (X on by default, TG off by default)
//   DEVNET_MODE  "true" prepends "devnet testing: " to every announcement
//   DRY_RUN      "true" logs the post text instead of hitting X / Telegram
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
// MESSAGE DEFINITIONS — all post copy lives here. Edit this block only.
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
    10000000,
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

// ── text spinning ────────────────────────────────────────────────────────────
// SEO-style "spinning": every `{a|b|c}` group picks one option at random
// (nesting works), and each event also has several full-template variants,
// so repeated announcements read differently. Builders return the template
// with spin groups INTACT — announce() spins once per event, so X and
// Telegram always carry the same wording.

export function spin(template: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < template.length) {
        if (template[i] !== "{") {
            out.push(template[i]);
            i++;
            continue;
        }
        const close = matchingBrace(template, i);
        if (close === -1) {
            // Unbalanced '{' — pass through literally.
            out.push(template[i]);
            i++;
            continue;
        }
        const options = splitTopLevel(template.slice(i + 1, close));
        const chosen = options[Math.floor(Math.random() * options.length)] ?? "";
        out.push(spin(chosen));
        i = close + 1;
    }
    return out.join("");
}

// Index of the '}' closing the group opened at openIdx, or -1 if unbalanced.
function matchingBrace(s: string, openIdx: number): number {
    let depth = 0;
    for (let j = openIdx; j < s.length; j++) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

// Split a group body on '|' at nesting depth 0.
function splitTopLevel(group: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of group) {
        if (ch === "{") {
            depth++;
            cur += ch;
        } else if (ch === "}") {
            depth--;
            cur += ch;
        } else if (ch === "|" && depth === 0) {
            parts.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    parts.push(cur);
    return parts;
}

// Random element of a template-variant list.
export function pick<T>(options: T[]): T {
    return options[Math.floor(Math.random() * options.length)];
}

// ── event messages ───────────────────────────────────────────────────────────
// Each builder picks one of several templates; templates may contain {spin}
// groups. All copy lives here — nothing below is user-facing text.

type TierLine = { size: number; discountPct: number; vestingDays: number };

function tierLine(name: string, tier: TierLine): string {
    return `${name}: ${formatWhole(tier.size)} AFHO @ ${tier.discountPct.toFixed(
        1
    )}% {discount|off} · ${tier.vestingDays}d {vest|vesting}`;
}

// 1. Bond offer sheet posted for the night desk.
export function bondsMessage(sheet: {
    big: TierLine;
    med: TierLine;
    sml: TierLine;
}): string {
    const lines: string[] = [
        pick([
            "AFHO bonds are up for sale",
            "The night desk just {posted|dropped} {today's|the daily} bond sheet",
            "{Fresh|New} AFHO bonds just {hit the desk|went on sale}",
            "Bond desk {is open|opened} — AFHO bonds {now available|on sale now}",
        ]),
    ];
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
    const a = formatAfho(afho);
    const p = formatPrice(avgPrice);
    const u = formatUsdc(usdc);
    return pick([
        `Daily buyback complete: ${a} AFHO @ ${p} avg for ${u} USDC`,
        `Buyback {done|finished|wrapped up}: ${a} AFHO at ${p} {average|avg} · ${u} USDC {spent|used}`,
        `{Today's|The day's} buyback {closed|ended}: ${a} AFHO @ ${p} · ${u} USDC`,
    ]);
}

// 3. Buy-the-dip slice fired.
export function dipBuyMessage(
    afho: number,
    price: number,
    dipUsdcRemaining: number
): string {
    const a = formatAfho(afho);
    const p = formatPrice(price);
    const r = formatUsdc(dipUsdcRemaining);
    return pick([
        `Buy the dip: bought ${a} AFHO @ ${p} · ${r} USDC left in dip vault`,
        `Dip buy {executed|fired}: ${a} AFHO @ ${p} · ${r} USDC {remains|left} in the dip vault`,
        `{Bought|Picked up} ${a} AFHO @ ${p} on the dip · ${r} USDC {still in|left in} the dip vault`,
    ]);
}

// 4. Market state changed.
export function marketStateMessage(state: number, feeLabel: string): string {
    const name = MARKET_NAMES[state] ?? state;
    return pick([
        `Market ${name} · ${feeLabel}`,
        `{Status|State} update: market ${name} · ${feeLabel}`,
        `Market {is now|switched to} ${name} · ${feeLabel}`,
    ]);
}

// 4b. Closed-session flash sale: the market went AFTER-HOURS → CLOSED and the
// sheet still has bonds left. Every remaining tier prices +0.5% deeper for
// the closed window (programs/amm offer_claim::quote_claim). Copy shows the
// BOOSTED discount (base + 0.5) and what remains per tier.
export function closedSaleMessage(tiers: {
    big: TierLine & { left: number; total: number };
    med: TierLine & { left: number; total: number };
    sml: TierLine & { left: number; total: number };
}): string {
    const line = (name: string, t: TierLine & { left: number; total: number }) =>
        `${name}: ${t.left} of ${t.total} × ${formatWhole(t.size)} AFHO @ ${(t.discountPct + 0.5).toFixed(
            1
        )}% {discount|off} · ${t.vestingDays}d {vest|vesting}`;
    const lines: string[] = [
        pick([
            `Market CLOSED — {flash sale|night owl special}: every bond left drops another 0.5%`,
            `Market {now CLOSED|just closed} — the {closed-session|late-night} discount just kicked in: −0.5% more on every bond left`,
            `CLOSED-session prices are live — all remaining bonds drop an extra 0.5%`,
        ]),
    ];
    if (tiers.big.left > 0) lines.push(line("Big", tiers.big));
    if (tiers.med.left > 0) lines.push(line("Med", tiers.med));
    if (tiers.sml.left > 0) lines.push(line("Sml", tiers.sml));
    return lines.join("\n");
}

// 5. Monday market open (richer variant of the market-open message).
export function mondayOpenMessage(
    feeLabel: string,
    stakePct: number,
    bondVaultWhole: number
): string {
    const s = stakePct.toFixed(1);
    const v = formatWhole(bondVaultWhole);
    return pick([
        `Monday open · ${feeLabel} · ${s}% of supply staked · ${v} AFHO in bond vault`,
        `The week {starts|opens} · ${feeLabel} · ${s}% of supply staked · ${v} AFHO {in the|sitting in the} bond vault`,
        `Monday {bell|open}: ${feeLabel} · ${s}% staked · ${v} AFHO in the bond vault`,
    ]);
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIG & CREDENTIALS
// ════════════════════════════════════════════════════════════════════════════

// Channel switches: X defaults on; Telegram defaults off until TG_ENABLED=true.
const X_ENABLED = !["false", "0", "no"].includes(
    (process.env.X_ENABLED ?? "").toLowerCase()
);
const TG_ENABLED = ["true", "1", "yes"].includes(
    (process.env.TG_ENABLED ?? "").toLowerCase()
);

const X_CONSUMER_KEY = process.env.X_CONSUMER_KEY ?? "";
const X_CONSUMER_SECRET =
    process.env.X_CONSUMER_SECRET ?? process.env.SECRET_KEY ?? "";
const X_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN ?? "";
const X_ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET ?? "";
const X_API_BASE = process.env.X_API_BASE ?? "https://api.twitter.com";

// Telegram Bot API config.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID ?? "";

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

// Post to every enabled channel with the SAME text — the template is spun
// once per event, so X and Telegram always mirror each other.
async function announce(text: string): Promise<void> {
    const body = spin(DEVNET_MODE ? DEVNET_PREFIX + text : text);

    if (X_ENABLED) {
        if (body.length > 280) {
            console.warn(`!! tweet exceeds 280 chars (${body.length}):\n${body}`);
        }
        if (DRY_RUN) {
            console.log(`[dry-run][x] would tweet:\n${body}\n`);
        } else {
            await postTweet(body);
            console.log(`[x] ${body.replace(/\n/g, " ")}`);
        }
    }

    if (TG_ENABLED) {
        if (DRY_RUN) {
            console.log(`[dry-run][tg] would post:\n${body}\n`);
        } else {
            await sendTelegram(body);
            console.log(`[tg] ${body.replace(/\n/g, " ")}`);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// TELEGRAM SENDER (Bot API) — no SDK, no login flow, one HTTPS call per post.
//
// One-time setup (do this once, then it just works):
//   1. In Telegram, message @BotFather: /newbot → pick a name → copy the
//      token (looks like 123456789:AA…).
//   2. Create the announcement channel, add the bot as an ADMIN with
//      "Post messages" enabled.
//   3. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID (@username or -100…)
//      in .env, then TG_ENABLED=true.
//
// Posts go out as HTML — the copy carries no markup, so & < > are escaped
// and newlines survive. Bots may only post to channels/groups where they
// are admins; they can never message a user who hasn't opened the bot.
// ════════════════════════════════════════════════════════════════════════════

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function telegramApi(
    method: string,
    params: Record<string, unknown>
): Promise<void> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(params);
        const req = https.request(
            {
                method: "POST",
                host: "api.telegram.org",
                port: 443,
                path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    "User-Agent": "afho-announcer",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (
                        res.statusCode &&
                        res.statusCode >= 200 &&
                        res.statusCode < 300
                    ) {
                        resolve();
                    } else {
                        reject(
                            new Error(
                                `Telegram API ${res.statusCode}: ${data.slice(0, 300)}`
                            )
                        );
                    }
                });
            }
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

// Validate the token once at startup — getMe fails fast with a readable
// error ("Unauthorized" = bad token) before the poll loop starts.
async function initTelegram(): Promise<void> {
    if (!TG_ENABLED || DRY_RUN) return; // dry run never touches Telegram
    if (TELEGRAM_BOT_TOKEN === "" || TELEGRAM_CHANNEL_ID === "") {
        throw new Error(
            "TG_ENABLED=true but TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID " +
                "are missing. Create a bot with @BotFather and add it as an " +
                "admin of your channel, then set both in .env."
        );
    }
    try {
        await telegramApi("getMe", {});
    } catch (e) {
        throw new Error(
            `Telegram startup check failed: ${(e as Error).message}`
        );
    }
}

async function sendTelegram(text: string): Promise<void> {
    await telegramApi("sendMessage", {
        chat_id: TELEGRAM_CHANNEL_ID,
        text: escapeHtml(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
    });
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

function programFor(
    name: string,
    programId: PublicKey,
    provider: anchor.Provider
): anchor.Program {
    const idl = loadIdl(name);
    // Pin the program id from deployment.json — deployed programs can be
    // rotated to new ids without an IDL regen. anchor 0.31 reads `idl.address`
    // in the constructor and exposes programId as a getter, so the id must be
    // set here rather than assigned after construction.
    (idl as any).address = programId.toBase58();
    return new anchor.Program(idl, provider);
}

// BN/u64-safe number coercion. Several u64 state fields use u64::MAX as
// their "uninitialized day" sentinel (bb_day_index, etc.), which BN.toNumber()
// rejects outright (it throws above 2^53). Converting via toString keeps big
// values at double precision and the sentinel still compares unequal to any
// real trading day.
function num(x: any): number {
    return anchor.BN.isBN(x) ? Number(x.toString()) : Number(x);
}

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

// Best real discount currently available on the night desk, in hundredths of
// a percent (100 = 1.00%) — 0 when nothing is effectively discounted. Mirrors
// quote_claim exactly: per tier with remaining lots, the discounted quote
// (incl. the state-2 bonus) clamped by the ratchet floor with the bonus-depth
// allowance, measured against the live pool price (vault-ratio spot).
async function bestDeskDiscountBp100(
    connection: Connection,
    ammState: any,
    offerList: any,
    state: number,
    liveFloor: bigint
): Promise<number> {
    if (liveFloor <= 0n) return 0;
    const floor = BigInt(ammState.highestBuybackBasis.toString());
    const bonusTenths = state === 2 ? 5 : 0;
    let best = 0;
    for (const key of ["bigOffer", "medOffer", "smlOffer"]) {
        const o = (offerList as any)[key];
        if (!o || num(o.remaining) <= 0) continue;
        const d = num(o.discountBps);
        const bps = BigInt(Math.min(255, d + bonusTenths)) * 10n;
        const discounted = liveFloor - (liveFloor * bps) / 10_000n;
        const allowance = (liveFloor * BigInt(bonusTenths) * 10n) / 10_000n;
        const bound = floor > allowance ? floor - allowance : 0n;
        const eff = discounted > bound ? discounted : bound;
        if (eff >= liveFloor) continue; // at/above spot — no discount
        const bp100 = Number((liveFloor - eff) * 10_000n / liveFloor);
        if (bp100 > best) best = bp100;
    }
    return best;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    if (!X_ENABLED && !TG_ENABLED) {
        throw new Error(
            "No channel enabled: set X_ENABLED=true or TG_ENABLED=true in .env."
        );
    }

    if (!DRY_RUN) {
        const missing = X_ENABLED
            ? [
                ["X_CONSUMER_KEY", X_CONSUMER_KEY],
                ["X_CONSUMER_SECRET", X_CONSUMER_SECRET],
                ["X_ACCESS_TOKEN", X_ACCESS_TOKEN],
                ["X_ACCESS_TOKEN_SECRET", X_ACCESS_TOKEN_SECRET],
            ]
                .filter(([, v]) => v === "")
                .map(([k]) => k)
            : [];
        if (missing.length > 0) {
            throw new Error(
                `Missing X credentials: ${missing.join(", ")}. Set them in .env, ` +
                `set X_ENABLED=false for Telegram-only, or run with DRY_RUN=true to preview messages.`
            );
        }
    }

    await initTelegram();

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

    const ammProgram = programFor("amm", ammProgramId, provider);
    const crankProgram = programFor("crank_oracle", crankProgramId, provider);
    const stakingProgram = programFor("staking", stakingProgramId, provider);

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

    console.log("AFHO announcer started");
    console.log("  cluster:", RPC_URL);
    console.log("  ammState:", ammStatePda.toBase58());
    console.log("  marketStatus:", marketStatusPda.toBase58());
    console.log(
        "  channels:",
        [X_ENABLED ? "X" : null, TG_ENABLED ? "Telegram" : null]
            .filter(Boolean)
            .join(" + ")
    );
    if (TG_ENABLED && !DRY_RUN) console.log("  telegram target:", TELEGRAM_CHANNEL_ID);
    console.log("  devnet mode:", DEVNET_MODE);
    console.log("  dry run:", DRY_RUN);
    console.log("  poll interval (ms):", POLL_INTERVAL_MS);

    // ── cross-poll event memory ────────────────────────────────────────────
    let initialized = false;
    let prevState = -1;
    let prevOfferDayIndex = -1;
    let prevAfhoVaultRaw = 0;
    let prevDipSpentUsdc = 0;
    let prevDipSliceCount = 0;
    // Snapshot of the AFHO bond vault at the start of today's buyback window.
    let buybackSnapshot: { day: number; afhoRaw: number } | null = null;
    let lastReportedBuybackDay = -1;
    // Desk-open latch: one desk announcement per CALENDAR day (ET — the
    // night session spans midnight UTC, so UTC days would split it). The
    // sheet post and the 1→2 flash sale share the latch: whichever fires
    // first announces the desk; later opens/closes the same calendar day
    // stay silent (price-flap reopenings are noise, not events).
    let deskAnnouncedDate: string | null = null;
    const etDate = (): string =>
        new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date());

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

            // Live AFHO price (floor units, vault-ratio spot over the pinned
            // CPMM pool) — feeds the desk-open discount gate below.
            let liveFloor = 0n;
            try {
                const cpmmPool = new PublicKey(ammState.cpmmPoolState);
                const vaultOf = (m: PublicKey) => PublicKey.findProgramAddressSync(
                    [Buffer.from("pool_vault"), cpmmPool.toBuffer(), m.toBuffer()],
                    new PublicKey(ammState.cpmmProgram)
                )[0];
                const [afhoPoolRaw, usdcPoolRaw] = await Promise.all([
                    tokenBalanceRaw(connection, vaultOf(afhoMint)),
                    tokenBalanceRaw(connection, vaultOf(new PublicKey(ammState.usdcMint))),
                ]);
                if (afhoPoolRaw > 0) liveFloor = BigInt(Math.floor(usdcPoolRaw * 1e12 / afhoPoolRaw));
            } catch {
                liveFloor = 0n; // unreadable pool → discount gate stays shut
            }
            const deskDiscount = await bestDeskDiscountBp100(
                connection, ammState, offerList, state, liveFloor
            );

            const bbDay = num(ammState.bbDayIndex);
            const bbSpentUsdc = num(ammState.bbSpentUsdc);
            const dipSpentUsdc = num(ammState.dipSpentUsdc);
            const dipSliceCount = ammState.dipSliceCount as number;
            const offerDay = num(offerList.dayIndex);

            // Buyback baseline: prefer the freshest pre-open afho_vault read when we
            // first see a day-start open (1→0 or 2→0 — the same pair the crank
            // rolls trading_day_index on; a 3→0 halt lift is not a new day);
            // fall back to a mid-buyback startup snapshot.
            const dayStartedOpen =
                initialized && (prevState === 1 || prevState === 2) && state === 0;
            if (dayStartedOpen) {
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
                // States 1 and 2 stay SILENT in the state-change block: the
                // night desk speaks through its own discount-gated
                // announcement below (sheet post in after-hours, flash sale
                // in closed) — never a bare "desk open/closed" tweet, and no
                // end-of-day post when the desk never opened.
                if (state !== prevState) {
                    const feeLabel = unstakeFeeLabel(stakingPool, state);
                    // Morning-open announcements fire ONLY on the canonical
                    // day-start pair (1→0 or 2→0) — the normal path is
                    // 2→1→0 (extended hours between closed and open), so a
                    // 3→0 halt lift (or any other →0) stays silent here; the
                    // halt itself was announced when it landed.
                    if (dayStartedOpen && isMondayEt()) {
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
                    } else if (dayStartedOpen) {
                        // Morning open is a real daily event — announce it.
                        await announce(marketStateMessage(state, feeLabel));
                    } else if (state === 3) {
                        // Halts are safety-relevant — announce the change.
                        await announce(marketStateMessage(state, feeLabel));
                    }
                    // States 1 and 2 stay SILENT here: the night desk speaks
                    // through its own announcements (sheet post below, or the
                    // flash sale above) — never a bare "desk open/closed"
                    // tweet. No desk opening that day = no end-of-day post.
                }

                // ── 2: night desk opens (discount-gated, latched) ───────────────────
                // The desk announces only when a REAL discount is actually
                // buyable: fresh sheet, lots left, market in a night state,
                // and the best tier's effective discount (post-ratchet, with
                // the state-2 bonus allowance) reaches 1%. If the ratchet
                // holds the desk at/above spot when after-hours starts, the
                // announcement waits until the decay (or a price move) makes
                // the bonds worth the click. One announcement per calendar
                // day (ET): re-opens/flaps the same day stay silent; a new
                // calendar day announces again. Message matches the session:
                // sheet post in after-hours, flash sale in closed.
                if (
                    (state === 1 || state === 2) &&
                    offerDay === marketDay &&
                    !offerListEmpty(offerList) &&
                    deskAnnouncedDate !== etDate() &&
                    deskDiscount >= 100
                ) {
                    const sheet = buildSheet(offerList);
                    if (state === 2) {
                        await announce(
                            closedSaleMessage({
                                big: { ...sheet.big, left: num(offerList.bigOffer.remaining), total: num(offerList.bigOffer.totalOffered) },
                                med: { ...sheet.med, left: num(offerList.medOffer.remaining), total: num(offerList.medOffer.totalOffered) },
                                sml: { ...sheet.sml, left: num(offerList.smlOffer.remaining), total: num(offerList.smlOffer.totalOffered) },
                            })
                        );
                    } else {
                        await announce(bondsMessage(sheet));
                    }
                    deskAnnouncedDate = etDate();
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
            if (!initialized) {
                // Restart seed: treat the desk as already-announced ONLY if it
                // is live AND currently passing the discount gate — a mid-
                // session restart must not re-tweet, but a desk sitting below
                // the 1% bar must stay eligible for the delayed announcement
                // once the decay or a price move carries it through.
                if (
                    (state === 1 || state === 2) &&
                    offerDay === marketDay &&
                    !offerListEmpty(offerList) &&
                    deskDiscount >= 100
                ) {
                    deskAnnouncedDate = etDate();
                }
            }
            prevState = state;
            prevOfferDayIndex = offerDay;
            prevAfhoVaultRaw = afhoVaultRaw;
            prevDipSpentUsdc = dipSpentUsdc;
            prevDipSliceCount = dipSliceCount;
            initialized = true;
        } catch (e) {
            console.error("!! poll failed:", (e as Error).message);
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error("!! announcer fatal:", e);
        process.exit(1);
    });
}
