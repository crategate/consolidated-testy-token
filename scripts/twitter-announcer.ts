// AFHO announcement bot — posts protocol events to X (Twitter) and/or Telegram.
//
// Read-only watcher: polls the AMM / crank-oracle / staking accounts and posts
// an announcement for each notable protocol event:
//
//   1. Daily bond offer sheet goes up for sale (bond sizes / discounts / vesting days)
//   2. Daily buyback completes (AFHO purchased, average price, USDC spent)
//   3. Buy-the-dip trigger (AFHO bought, price, remaining dip vault)
//   4. Market-state changes (with the associated unstake fee)
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
// Telegram credentials — MTProto userbot via gramjs (the "telegram" package):
//   TG_API_ID        numeric api_id from https://my.telegram.org → API
//                    development tools (this is NOT the api_hash)
//   TG_API_HASH      api_hash from the same page
//   TG_PHONE         account phone number (only needed for the first login)
//   TG_SESSION       string session; auto-saved to .env after the first login
//   TG_CHANNEL       channel/group to post into: @username or -100… numeric id
//   TG_TEST_SERVER   "true" = Telegram test DCs instead of production
//
//   The logged-in account must be an admin of TG_CHANNEL with post rights.
//   DC IPs/ports are resolved by the client automatically — you never
//   configure them.
//
// Flags:
//   X_ENABLED / TG_ENABLED  channel switches (X on by default, TG off by default)
//   DEVNET_MODE  "true" prepends "devnet testing: " to every announcement
//   DRY_RUN      "true" logs the post text instead of hitting X / Telegram
//   POLL_INTERVAL_MS  poll cadence (default 60000)
//
// Run: yarn add telegram && npx ts-node scripts/twitter-announcer.ts
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
import * as readline from "readline";

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
// with spin groups INTACT — announce() spins once per channel, so X and
// Telegram get their own wording.

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

// Telegram MTProto (userbot) config. TG_API_ID is the INTEGER id from
// my.telegram.org (not the api_hash). TG_SESSION is auto-saved to .env
// after the first interactive login.
const TG_API_ID = Number(process.env.TG_API_ID ?? 0);
const TG_API_HASH = process.env.TG_API_HASH ?? "";
const TG_SESSION = process.env.TG_SESSION ?? "";
const TG_PHONE = process.env.TG_PHONE ?? "";
const TG_CHANNEL = process.env.TG_CHANNEL ?? "";
const TG_TEST_SERVER = ["true", "1", "yes"].includes(
    (process.env.TG_TEST_SERVER ?? "").toLowerCase()
);
const TG_DEVICE_MODEL = process.env.TG_DEVICE_MODEL ?? "AFHO Announcer";
const TG_APP_VERSION = process.env.TG_APP_VERSION ?? "1.0.0";
const TG_SYSTEM_VERSION = process.env.TG_SYSTEM_VERSION ?? process.platform;

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

// Post to every enabled channel. Spinning runs once per channel, so X and
// Telegram each get their own variation of the same announcement.
async function announce(text: string): Promise<void> {
    const template = DEVNET_MODE ? DEVNET_PREFIX + text : text;

    if (X_ENABLED) {
        const body = spin(template);
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
        const body = spin(template);
        if (DRY_RUN) {
            console.log(`[dry-run][tg] would post:\n${body}\n`);
        } else {
            await sendTelegram(body);
            console.log(`[tg] ${body.replace(/\n/g, " ")}`);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// TELEGRAM CLIENT (MTProto userbot via gramjs). Lazily required so the
// 'telegram' package is only needed when TG_ENABLED=true. DC IPs/ports are
// resolved by the client — TG_TEST_SERVER switches to the test DCs.
// ════════════════════════════════════════════════════════════════════════════

let tgClient: any = null;

function loadTelegram(): any {
    try {
        return require("telegram");
    } catch {
        throw new Error(
            "TG_ENABLED=true but the 'telegram' (gramjs) package is not " +
                "installed. Run: yarn add telegram"
        );
    }
}

function promptLine(question: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// Persist the string session into .env so later runs skip the login flow.
function upsertEnv(key: string, value: string): void {
    const envPath = path.join(process.cwd(), ".env");
    const content = fs.existsSync(envPath)
        ? fs.readFileSync(envPath, "utf-8")
        : "";
    const line = `${key}="${value.replace(/"/g, '\\"')}"`;
    const re = new RegExp(`^${key}=.*$`, "m");
    const next = re.test(content)
        ? content.replace(re, () => line)
        : content.replace(/\s*$/, "") + "\n" + line + "\n";
    fs.writeFileSync(envPath, next);
}

// Connect once at startup; on a fresh session run the interactive phone
// login (code + optional 2FA) and save the resulting session to .env.
async function initTelegram(): Promise<void> {
    if (!TG_ENABLED || DRY_RUN) return; // dry run never touches Telegram

    if (TG_API_ID === 0 || TG_API_HASH === "") {
        throw new Error(
            "TG_ENABLED=true but TG_API_ID / TG_API_HASH are missing. Get " +
                "the numeric api_id and the api_hash from https://my.telegram.org " +
                "→ API development tools, then set both in .env."
        );
    }
    if (TG_CHANNEL === "") {
        throw new Error(
            "TG_ENABLED=true but TG_CHANNEL is not set. Use the channel " +
                "username (@your_channel) or numeric id (-100…)."
        );
    }

    const telegram = loadTelegram();
    const { StringSession } = require("telegram/sessions");
    tgClient = new telegram.TelegramClient(
        new StringSession(TG_SESSION),
        TG_API_ID,
        TG_API_HASH,
        {
            connectionRetries: 5,
            deviceModel: TG_DEVICE_MODEL,
            appVersion: TG_APP_VERSION,
            systemVersion: TG_SYSTEM_VERSION,
            testServers: TG_TEST_SERVER,
        }
    );
    await tgClient.connect();
    if (!(await tgClient.checkAuthorization())) {
        console.log(" Telegram first login — a code will arrive in Telegram.");
        await tgClient.start({
            phoneNumber: async () =>
                TG_PHONE ||
                (await promptLine("Telegram phone (e.g. +15551234567): ")),
            password: async () =>
                await promptLine("Telegram 2FA password (blank if none): "),
            phoneCode: async () => await promptLine("Telegram login code: "),
            onError: (err: any) =>
                console.error(" telegram login error:", err),
        });
        const saved = tgClient.session.save();
        if (typeof saved === "string" && saved.length > 0) {
            upsertEnv("TG_SESSION", saved);
            console.log(
                " telegram session saved to .env (TG_SESSION) — future runs skip login."
            );
        }
    }
}

async function sendTelegram(text: string): Promise<void> {
    await tgClient.sendMessage(TG_CHANNEL, { message: text });
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

    console.log(" AFHO announcer started");
    console.log("  cluster:", RPC_URL);
    console.log("  ammState:", ammStatePda.toBase58());
    console.log("  marketStatus:", marketStatusPda.toBase58());
    console.log(
        "  channels:",
        [X_ENABLED ? "X" : null, TG_ENABLED ? "Telegram" : null]
            .filter(Boolean)
            .join(" + ")
    );
    if (TG_ENABLED && !DRY_RUN) console.log("  telegram target:", TG_CHANNEL);
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
