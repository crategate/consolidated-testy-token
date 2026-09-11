// AFHO announcement bot — posts protocol events to X (Twitter) and/or Telegram.
//
// Read-only watcher: polls the AMM / crank-oracle / staking accounts and posts
// an announcement for each notable protocol event:
//
//   1. Daily bond offer sheet goes up for sale (bond sizes / discounts / vesting days)
//   2. Daily buyback completes (AFHO purchased, average price, USDC spent)
//   3. Buy-the-dip digest — ONE post per ET calendar day at a random
//       minute inside the 10–11am or 1–3pm ET band (re-rolled daily, so
//       the slot changes), only when at least one dip slice fired since
//       the previous digest (slices, AFHO bought, avg price, USDC
//       deployed, dip vault left)
//   4. Market-state changes (with the associated unstake fee)
//   4b. Closed-session flash sale: AFTER-HOURS → CLOSED with bonds still on
//       the sheet — every remaining tier is 0.5% deeper for the closed window
//   5. Monday market open (open + fee + % supply staked + bond vault remaining)
//   6. Ratchet-floor decay digest — the bond offer floor decayed (old → new
//       floor + % change). NOT posted when the cut lands: decays fire at the
//       day-start transition, and the digest holds for a RANDOM minute inside
//       the 12:00–13:00 ET window (re-rolled daily), once per ET calendar
//       day. Ratchets (floor moving up on buyback fills) shift the baseline
//       silently.
//   7. Alt-sheet window — the second, fixed-terms sheet the keeper posts in
//       the suspended market state. Announced ONCE per trading day, 5 minutes
//       AFTER the window opens (and only if it is still open at post time —
//       an early close posts nothing, by design). Copy is deliberately
//       oblique: no state names, no sale jargon.
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


export const DEVNET_PREFIX = "devnet testing: ";

// Alt-sheet announcement delay: the window is announced 5 minutes AFTER it
// opens (and only if it is still open at post time).
const ALT_ANNOUNCE_DELAY_MS = 5 * 60 * 1000;

// Night-desk announcement gate: only post once the BEST remaining tier's
// exact claim discount reaches this bar (hundredths of a percent; 200 = 2%).
// Matches the combinator's MIN_LIST_STORED listing floor — a shallower
// effective discount is the ratchet floor eating the listed deal, not a real
// bond sale.
const DESK_ANNOUNCE_MIN_DISCOUNT_BP100 = 200;

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

export function unstakeFeeLabel(pool: any, state: number): string {
    if (state === 0) return "no unlock fees";
    const bpsByState: Record<number, number> = {
        1: pool.afterHoursPenaltyBps as number,
        2: pool.closedPenaltyBps as number,
        3: pool.haltedPenaltyBps as number,
    };
    const bps = bpsByState[state] ?? 0;
    const pct = bps / 100;
    const label = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
    return `${label}% penalty to principle for unlock`;
}

// ── text spinning ────────────────────────────────────────────────────────────
// every `{a|b|c}` group picks one option at random
// (nesting works), and each event also has several full-template variants,
// so repeated announcements read differently. 
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
    )}% {discount|off} ${tier.vestingDays}d {vest|vesting}`;
}

// 1. Bond offer sheet posted for the night desk.
export function bondsMessage(sheet: {
    big: TierLine;
    med: TierLine;
    sml: TierLine;
}): string {
    const lines: string[] = [
        pick([
            "{discounted|Vesting|AFHO|Bulk token} bond{s| offers} {are now available|have posted|now trading}",
            "The {OTC|after hours desk} {just|has|} {posted|dropped|published} {tonights's|the daily} {bond|offer} {sheet|deals}",
            "{Fresh|New} AFHO bonds just {hit the desk|went on sale}",
            "{Bond desk|Offer desk|OTC office} {is open|opened|now open|trading now}..  AFHO {bonds|vesting bulk bonds} {now available|on sale now}",
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
        `{Daily buyback|Buyback vault drain|Bond buyback spend} {complete|finished|ended}: ${a} AFHO token at ${p} avg for ${u} USDC`,
        `Buyback {done|finished|concluded|terminated}: ${a} AFHO at ${p} {average|avg}.. ${u} USDC {spent|used}`,
        `{Today's|The day's} buyback {closed|ended} after spending ${u} USDC on ${a} AFHO @ ${p} average `,
    ]);
}

// Daily dip-digest window: the digest lands at a random minute inside one
// of these ET bands (50/50 band pick, re-rolled every ET calendar day so
// the slot changes). Minutes are ET minutes-of-day (10:00 = 600).
export const DIP_SLOT_BANDS: Array<[number, number]> = [
    [10 * 60, 11 * 60], // mid-morning 10:00–10:59 ET
    [13 * 60, 15 * 60], // mid-afternoon 13:00–14:59 ET
];

// Random digest slot: uniform minute inside a random band.
export function rollDipSlotMinute(): number {
    const [lo, hi] =
        DIP_SLOT_BANDS[Math.floor(Math.random() * DIP_SLOT_BANDS.length)];
    return lo + Math.floor(Math.random() * (hi - lo));
}

// Re-roll inside the band that contains `nowMin` — used when a dip fires
// after today's slot already passed: uniform minute in [nowMin, hi).
export function rollDipSlotMinuteFrom(nowMin: number, hi: number): number {
    return nowMin + Math.floor(Math.random() * (hi - nowMin));
}

// 3. Daily buy-the-dip digest. Per-slice posts are gone: slices accumulate
// in the poll loop and ONE digest posts per ET calendar day, at a random
// minute inside the 10–11am or 1–3pm ET band, only when at least one slice
// fired since the last digest.
export function dipDigestMessage(
    slices: number,
    afho: number,
    usdc: number,
    price: number,
    dipUsdcRemaining: number
): string {
    const a = formatAfho(afho);
    const u = formatUsdc(usdc);
    const r = formatUsdc(dipUsdcRemaining);
    const n = formatWhole(slices);
    if (afho <= 0) {
        // No measurable AFHO across the whole window (claims or buyback
        // slices shared every poll window) — report spend and vault only.
        return pick([
            `Dip {digest|recap}: ${n} dip ${slices === 1 ? "buy" : "buys"} ${u} USDC deployed ${r} {still in|left in} the dip vault`,
            `Buy-the-dip {update|report}: ${n} slice${slices === 1 ? "" : "s"} fired for ${u} USDC ${r} USDC left in the vault`,
        ]);
    }
    const p = formatPrice(price);
    if (slices === 1) {
        return pick([
            `Dip {buy|scoop} today: ${a} AFHO @ ${p} ${u} USDC deployed ${r} {still in|left in} the dip vault`,
            `One dip {executed|fired} since the last update: ${a} AFHO @ ${p} ${r} USDC {remains|left} in the dip vault`,
            `{Bought|Picked up} ${a} AFHO @ ${p} on the dip ${u} USDC in ${r} USDC left in the vault`,
        ]);
    }
    return pick([
        `Dip {digest|recap|report}: ${n} dip buys — ${a} AFHO @ ${p} avg ${u} USDC deployed ${r} {still in|left in} the dip vault`,
        `Buy-the-dip {update|report}: ${n} slices fired ${a} AFHO {scooped|picked up} @ ${p} avg ${u} USDC spent ${r} USDC left`,
        `${n} dip buys since the last update — ${a} AFHO @ ${p} avg, ${u} USDC in dip vault at ${r}`,
    ]);
}

// 4. Market state changed.
export function marketStateMessage(state: number, feeLabel: string): string {
    const name = MARKET_NAMES[state] ?? state;
    return pick([
        `Market ${name} ${feeLabel}`,
        `{Status|State} update: market ${name} ${feeLabel}`,
        `Market {is now|switched to} ${name} ${feeLabel}`,
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
        )}% {discount|off} ${t.vestingDays}d {vest|vesting}`;
    const lines: string[] = [
        pick([
            `Market CLOSED — {bonus discount|night owl special}: every {bond|offer} drops another {0.5%|50 pts|50bps|half percent}`,
            `{extended hours|after hours} {finished|ended|done}. Market {now CLOSED|just closed} — the {closed-session|50pts|late-night} discount just kicked in: −0.5% more on every bond left`,
            `CLOSED-session prices are live — {all|any|the} remaining bonds {drop|discount|move down|priced better by} {an extra|another|an additional|a bonus} {0.5%|50 points|50bps|half percent}.`,
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
        `Monday open ${feeLabel} ${s}% of supply staked ${v} AFHO in bond vault`,
        `The week {starts|opens} ${feeLabel} ${s}% of supply staked ${v} AFHO {in the|sitting in the} bond vault`,
        `Monday {bell|open}: ${feeLabel} ${s}% staked ${v} AFHO in the bond vault`,
    ]);
}

// 6. Ratchet-floor decay digest. Floor units are nano-USD (price per whole
// token × 1e9), the same convention the /dash "Ratchet floor (USDC)" row
// shows, so 4792 → "$0.000004792". The floor only ever moves DOWN via
// calc_completed_offers decay (fills ratchet it up), so the message is the
// desk easing its no-discount boundary toward the live market after days
// with no bond sales. Posted at the noon ET slot, not when the cut lands.
export function floorDecayMessage(oldFloorUsd: number, newFloorUsd: number): string {
    const fmt = (v: number) => `$${v.toFixed(9)}`;
    const pct = oldFloorUsd > 0 ? ((newFloorUsd - oldFloorUsd) / oldFloorUsd) * 100 : 0;
    const pctLabel = `${pct > 0 ? "+" : "-"}${Math.abs(pct).toFixed(1)}%`;
    const o = fmt(oldFloorUsd);
    const n = fmt(newFloorUsd);
    return pick([
        `Bond floor {update|adjustment}: ratcheted bond offer floor ${o} → ${n} (${pctLabel}) — {the desk re-prices toward market|bond pricing eases toward the tape|the floor steps down to meet demand}`,
        `{Floor digest|Floor check}: ratcheted bond offer floor now ${n}, down from ${o} (${pctLabel}) — {unsold|unfilled} bond pricing {eases|moves closer to the live market}`,
        `The ratcheted bond offer floor {stepped down|eased|slid} ${o} → ${n} (${pctLabel}) — {no takers at the old floor|the desk meets the market where it is|pricing re-anchors to live trade}`,
    ]);
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Alt-sheet window (suspended state only). Announced once per trading
// day, 5 minutes after the window opens, and only while the window is
// still open at post time. Copy is deliberately oblique — no state names,
// no sale jargon; the tier lines carry the concrete terms.
export function altSheetMessage(tiers: {
    big: TierLine & { left: number; total: number };
    med: TierLine & { left: number; total: number };
    sml: TierLine & { left: number; total: number };
}): string {
    const altLine = (
        name: string,
        t: TierLine & { left: number; total: number }
    ) =>
        `${name}: ${t.left} of ${t.total} × ${formatWhole(t.size)} AFHO @ ${t.discountPct.toFixed(1)}% {under market|off live price} ${t.vestingDays}d {unlock|vest}`;
    const lines: string[] = [
        pick([
            `Something {rare|unusual} just {hit|landed on} the bond desk 👀 — a {limited|one-off} sheet is live, {3–5%|3 to 5 percent} {under market|off live price}, {short|quick} {unlock|vesting}. When it's gone, it's gone.`,
            `{Rare drop|Special window}: the desk just listed a {one-time|limited} bond sheet at {3–5%|3 to 5 percent} {under market|off the live price} — {no schedule|no warning}, {no reruns today|gone when the window closes}.`,
            `The desk just opened a {side window|second shelf}: bonds at {3–5%|3 to 5 percent} {under market|off live}, {3–7|3 to 7} day {unlock|vesting}. {First come|Fastest hands} win.`,
        ]),
    ];
    if (tiers.big.total > 0) lines.push(altLine("Big", tiers.big));
    if (tiers.med.total > 0) lines.push(altLine("Med", tiers.med));
    if (tiers.sml.total > 0) lines.push(altLine("Sml", tiers.sml));
    return lines.join("\n");
}

// Decay digest window: the digest lands at a random minute inside
// 12:00–13:00 ET ("around noon", re-rolled daily so the exact time moves).
const DECAY_SLOT_BAND: [number, number] = [12 * 60, 13 * 60];

export function rollDecaySlotMinute(): number {
    const [lo, hi] = DECAY_SLOT_BAND;
    return lo + Math.floor(Math.random() * (hi - lo));
}

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

// (retired: the decay digest now uses a randomized daily slot — see
// rollDecaySlotMinute / etMinutesOfDay)

// ET minutes-of-day (10:30 ET = 630). Host-TZ-independent like the helpers
// above — the dip digest compares this against its daily random slot.
export function etMinutesOfDay(now: Date = new Date()): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hourCycle: "h23",
    }).format(now); // "9:05" / "13:45"
    const [h, m] = parts.split(":").map(Number);
    return h * 60 + m;
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
// once per event, so X and Telegram always mirror each other. `silent` opts
// the post out of Telegram push notifications (X has no equivalent): routine
// state changes post silently so the notable events actually ping phones.
async function announce(text: string, opts?: { silent?: boolean }): Promise<void> {
    const silent = opts?.silent ?? false;
    const body = spin(DEVNET_MODE ? DEVNET_PREFIX + text : text);

    // Channels are independent: a failure on one (rate limit, revoked
    // token, API outage) logs and moves on — it must never block the
    // others, and never marks the whole poll as failed.
    if (X_ENABLED) {
        if (body.length > 280) {
            console.warn(`!! tweet exceeds 280 chars (${body.length}):\n${body}`);
        }
        if (DRY_RUN) {
            console.log(`[dry-run][x] would tweet:\n${body}\n`);
        } else {
            try {
                await postTweet(body);
                console.log(`[x] ${body.replace(/\n/g, " ")}`);
            } catch (e) {
                console.error(`!! [x] post failed: ${(e as Error).message}`);
            }
        }
    }

    if (TG_ENABLED) {
        if (DRY_RUN) {
            console.log(`[dry-run][tg] would post:\n${body}\n`);
        } else {
            try {
                await sendTelegram(body, silent);
                console.log(`[tg]${silent ? " (silent)" : ""} ${body.replace(/\n/g, " ")}`);
            } catch (e) {
                console.error(`!! [tg] post failed: ${(e as Error).message}`);
            }
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

async function sendTelegram(text: string, silent = false): Promise<void> {
    await telegramApi("sendMessage", {
        chat_id: TELEGRAM_CHANNEL_ID,
        text: escapeHtml(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: silent,
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
    (idl as any).address = programId.toBase58();
    return new anchor.Program(idl, provider);
}
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
// quote_claim's TIER-SCALED pricing exactly (offer_claim.rs): the ratchet
// floor lifts clamped tiers in strict big>med>sml order, so this gate never
// over-reports a deal the on-chain claim would refuse with FloorHeldAtSpot.
// `connection` is unused here but kept to match the call-site shape.
async function bestDeskDiscountBp100(
    connection: Connection,
    ammState: any,
    offerList: any,
    state: number,
    liveFloor: bigint
): Promise<number> {
    if (liveFloor <= 0n) return 0;
    const floor = BigInt(ammState.highestBuybackBasis.toString());
    const satSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);

    const discount = (key: string): number => {
        const o = (offerList as any)[key];
        return o ? num(o.discountBps) : 0;
    };
    // Stored discounts are tenths of a percent (115 = 11.5%); the state-2
    // closed-session boost adds 5 tenths to every tier.
    const tierQuote = (d: number): bigint => {
        const boosted = state === 2 ? Math.min(255, d + 5) : d;
        return liveFloor - (liveFloor * BigInt(boosted) * 10n) / 10_000n;
    };
    const tierBound = (d: number): bigint => {
        const boosted = state === 2 ? Math.min(255, d + 5) : d;
        const allowance = (liveFloor * BigInt(boosted - d) * 10n) / 10_000n;
        return floor > allowance ? floor - allowance : 0n;
    };

    const dSml = discount("smlOffer");
    const dMed = discount("medOffer");
    const dBig = discount("bigOffer");
    const qSml = tierQuote(dSml);
    const qMed = tierQuote(dMed);
    const qBig = tierQuote(dBig);
    const bSml = tierBound(dSml);
    const bMed = tierBound(dMed);
    const bBig = tierBound(dBig);

    // Exact quote_claim tier-scaling (unrolled eff_sml/eff_med/eff_big block).
    const effSml = qSml >= bSml ? qSml : bSml + satSub(qSml, qBig);
    const liftedMed = bMed + satSub(qMed, qBig);
    const cappedMed = liftedMed < satSub(effSml, 1n) ? liftedMed : satSub(effSml, 1n);
    const effMed = qMed >= bMed ? qMed : (cappedMed > bMed ? cappedMed : bMed);
    const effBig = qBig > bBig ? qBig : bBig;

    let best = 0;
    const tiers = [
        ["smlOffer", effSml],
        ["medOffer", effMed],
        ["bigOffer", effBig],
    ] as const;
    for (const [key, eff] of tiers) {
        const o = (offerList as any)[key];
        if (!o || num(o.remaining) <= 0 || num(o.lotSize) <= 0) continue;
        if (eff >= liveFloor) continue; // at/above spot — no real discount
        const bp100 = Number(((liveFloor - eff) * 10_000n) / liveFloor);
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
    // Alt desk sheet (same OfferList layout, separate PDA) — read lazily at
    // post time; the fetch throws while the account doesn't exist yet.
    const [altListPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("alt_offer_list"), afhoMint.toBuffer()],
        ammProgramId
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
    // Ratchet-floor decay digest (section 6): the floor only ever moves DOWN
    // via decay — buyback/dip fills ratchet it UP — so current floor < last
    // announced floor = a decay happened. Held for the noon ET slot (decays
    // land at the day-start transition, ~9:30 ET on mainnet; the digest
    // batches them to lunch), once per ET calendar day. Ratchets upward move
    // the baseline silently. Seeded from live state on restart so a mid-day
    // restart never re-announces an old decay; the NEXT decay re-arms it.
    let floorAnnouncedRaw: number | null = null;
    let decayAnnouncedDate: string | null = null;
    // Buy-the-dip digest (loop section 4): slices accumulate into a pending
    // window; ONE digest per ET calendar day at a random minute inside the
    // 10–11am / 1–3pm ET bands (re-rolled daily so the slot changes), only
    // when ≥1 slice fired since the previous digest. A dip landing after
    // today's slot but still inside a band re-rolls a fresh slot later
    // today (the once-per-day cap stands). In-memory like the decay
    // baseline: a mid-day restart forgets the pending window and re-rolls
    // today's slot.
    let dipPendingSlices = 0;
    let dipPendingAfhoWhole = 0;
    let dipPendingUsdcWhole = 0;
    let dipAnnouncedDate: string | null = null;
    let dipSlotDate = "";
    let dipSlotMinute = -1;
    // Decay digest slot: randomized daily inside 12:00–13:00 ET (replaces
    // the old "first poll at-or-after noon" — same batching, moving time).
    let decaySlotDate = "";
    let decaySlotMinute = -1;
    // Alt-sheet window: one announcement per trading day, scheduled 5
    // minutes after the window opens (see section 7 in the poll loop).
    let haltAnnouncedDay = -1;
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
            const floorRaw = num(ammState.highestBuybackBasis);

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
                            ),
                            { silent: true }
                        );
                    } else if (dayStartedOpen) {
                        // Morning open is a real daily event — announce it.
                        await announce(marketStateMessage(state, feeLabel), {
                            silent: true,
                        });
                    } else if (state === 3) {
                        // Halts are safety-relevant — announce the change.
                        await announce(marketStateMessage(state, feeLabel), {
                            silent: true,
                        });
                        // ── 7: alt-sheet window — 5-minute delayed post ──
                        // Scheduled the moment the window opens; the post
                        // itself re-reads the market state and only fires if
                        // the window is STILL open (an early close posts
                        // nothing — no end-of-window announcement, by
                        // design). Latched once per trading day at schedule
                        // time, so window flaps never double-post. A
                        // mid-window restart seeds silently (never
                        // re-announces), same rule as every other latch.
                        if (haltAnnouncedDay !== marketDay) {
                            haltAnnouncedDay = marketDay;
                            setTimeout(async () => {
                                try {
                                    const status = await (
                                        crankProgram.account as any
                                    ).marketStatus.fetch(marketStatusPda);
                                    if ((status.currentState as number) !== 3)
                                        return;
                                    const day = num(status.tradingDayIndex);
                                    const alt = await (
                                        ammProgram.account as any
                                    ).offerList.fetch(altListPda);
                                    if (num(alt.dayIndex) !== day) return;
                                    const empty =
                                        num(alt.bigOffer.totalOffered) === 0 &&
                                        num(alt.medOffer.totalOffered) === 0 &&
                                        num(alt.smlOffer.totalOffered) === 0;
                                    if (empty) return;
                                    const sheet = buildSheet(alt);
                                    await announce(
                                        altSheetMessage({
                                            big: { ...sheet.big, left: num(alt.bigOffer.remaining), total: num(alt.bigOffer.totalOffered) },
                                            med: { ...sheet.med, left: num(alt.medOffer.remaining), total: num(alt.medOffer.totalOffered) },
                                            sml: { ...sheet.sml, left: num(alt.smlOffer.remaining), total: num(alt.smlOffer.totalOffered) },
                                        })
                                    );
                                } catch (e) {
                                    // No sheet account yet / transient RPC —
                                    // the window stays unannounced rather
                                    // than late.
                                    console.error(`!! alt-sheet post failed: ${(e as Error).message}`);
                                }
                            }, ALT_ANNOUNCE_DELAY_MS);
                        }
                    }
                    // States 1 and 2 stay SILENT here: the night desk speaks
                    // through its own announcements (sheet post below, or the
                    // flash sale above) — never a bare "desk open/closed"
                    // tweet. No desk opening that day = no end-of-day post.
                }

                // ── 2: night desk opens (discount-gated, latched) ───────────────────
                // The desk announces only when a REAL discount is actually
                // buyable: fresh sheet, lots left, market in a night state,
                // and the best tier's exact tier-scaled claim discount (post-
                // ratchet, with the state-2 bonus allowance) reaches the
                // 2% listing bar. If the ratchet holds the desk at/above
                // spot when after-hours starts, the announcement waits until
                // the decay (or a price move) makes the bonds worth the
                // click. One announcement per calendar day (ET): re-opens/
                // flaps the same day stay silent; a new calendar day
                // announces again. Message matches the session: sheet post
                // in after-hours, flash sale in closed.
                if (
                    (state === 1 || state === 2) &&
                    offerDay === marketDay &&
                    !offerListEmpty(offerList) &&
                    deskAnnouncedDate !== etDate() &&
                    deskDiscount >= DESK_ANNOUNCE_MIN_DISCOUNT_BP100
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

                // ── 4: buy-the-dip — randomized-slot daily digest ────────────────────
                // Per-slice posts are gone: slices accumulate into a pending
                // window and ONE digest fires per ET day, at a random minute
                // inside the 10–11am / 1–3pm band, ONLY when at least one
                // slice fired since the previous digest. AFHO bought is
                // measured per-slice from the afho_vault delta (a claim or
                // buyback slice in the same 60s poll window skews that
                // slice's figure) — the same convention the old per-slice
                // post used. dip_slice_count/dip_spent_usdc reset to 0 on
                // day rollover, so a shrinking counter = day reset.
                if (dipSlotDate !== etDate()) {
                    dipSlotDate = etDate();
                    dipSlotMinute = rollDipSlotMinute();
                }
                const sliceDelta =
                    dipSliceCount >= prevDipSliceCount
                        ? dipSliceCount - prevDipSliceCount
                        : dipSliceCount;
                const spentDelta =
                    dipSpentUsdc >= prevDipSpentUsdc
                        ? dipSpentUsdc - prevDipSpentUsdc
                        : dipSpentUsdc;
                if (sliceDelta > 0 || spentDelta > 0) {
                    dipPendingSlices += Math.max(
                        sliceDelta,
                        spentDelta > 0 ? 1 : 0
                    );
                    dipPendingUsdcWhole += toWhole(spentDelta, usdcDecimals);
                    const afhoDelta = afhoVaultRaw - prevAfhoVaultRaw;
                    if (afhoDelta > 0) {
                        dipPendingAfhoWhole += toWhole(
                            afhoDelta,
                            afhoDecimals
                        );
                    }
                    // Dip fired after today's slot but still inside a band →
                    // fresh random slot later today. Outside the bands the
                    // pending window simply waits for tomorrow's slot.
                    const etNow = etMinutesOfDay();
                    const band = DIP_SLOT_BANDS.find(
                        ([lo, hi]) => etNow >= lo && etNow < hi
                    );
                    if (
                        dipAnnouncedDate !== etDate() &&
                        band &&
                        dipSlotMinute <= etNow
                    ) {
                        dipSlotMinute = rollDipSlotMinuteFrom(etNow, band[1]);
                    }
                }
                if (
                    (dipPendingSlices > 0 || dipPendingUsdcWhole > 0) &&
                    dipAnnouncedDate !== etDate() &&
                    etMinutesOfDay() >= dipSlotMinute
                ) {
                    const price =
                        dipPendingAfhoWhole > 0
                            ? dipPendingUsdcWhole / dipPendingAfhoWhole
                            : 0;
                    await announce(
                        dipDigestMessage(
                            dipPendingSlices,
                            dipPendingAfhoWhole,
                            dipPendingUsdcWhole,
                            price,
                            toWhole(usdcDipRaw, usdcDecimals)
                        )
                    );
                    dipAnnouncedDate = etDate();
                    dipPendingSlices = 0;
                    dipPendingAfhoWhole = 0;
                    dipPendingUsdcWhole = 0;
                }

                // ── 5: ratchet-floor decay — randomized noon digest ─────
                // The floor never moves down except via calc_completed_offers
                // decay (fills ratchet it up), so floor < last-announced floor
                // = a decay happened. Held for a RANDOM minute inside the
                // 12:00–13:00 ET band (re-rolled daily): decays land at the
                // day-start transition (~9:30 ET on mainnet) and the digest
                // batches them to lunch at a time that moves day to day, once
                // per ET calendar day. Ratchets upward move the baseline
                // silently so the next decay measures from the true peak.
                if (decaySlotDate !== etDate()) {
                    decaySlotDate = etDate();
                    decaySlotMinute = rollDecaySlotMinute();
                }
                if (floorAnnouncedRaw === null) floorAnnouncedRaw = floorRaw;
                if (floorRaw > floorAnnouncedRaw) floorAnnouncedRaw = floorRaw;
                if (
                    floorRaw < floorAnnouncedRaw &&
                    decayAnnouncedDate !== etDate() &&
                    etMinutesOfDay() >= decaySlotMinute
                ) {
                    await announce(
                        floorDecayMessage(
                            Number(floorAnnouncedRaw) / 1e9,
                            Number(floorRaw) / 1e9
                        )
                    );
                    decayAnnouncedDate = etDate();
                    floorAnnouncedRaw = floorRaw;
                }
            }

            // ── advance cross-poll memory ──────────────────────────────────────────
            if (!initialized) {
                // Decay digest seed: baseline = the live floor at startup, so
                // a mid-session restart never re-announces an old decay; the
                // NEXT decay (floor dropping below this baseline) re-arms it.
                floorAnnouncedRaw = floorRaw;
                // Restart seed: treat the desk as already-announced ONLY if it
                // is live AND currently passing the discount gate — a mid-
                // session restart must not re-tweet, but a desk sitting below
                // the 2% bar must stay eligible for the delayed announcement
                // once the decay or a price move carries it through.
                if (
                    (state === 1 || state === 2) &&
                    offerDay === marketDay &&
                    !offerListEmpty(offerList) &&
                    deskDiscount >= DESK_ANNOUNCE_MIN_DISCOUNT_BP100
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
