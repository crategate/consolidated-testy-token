// Read-only inspection of the live devnet AMM state (deployment.json addresses).
// Prints market status, offer list, metrics, and vault balance.
import anchor from "@coral-xyz/anchor";
import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");

const deployment = JSON.parse(
  fs.readFileSync(new URL("../app/public/deployment.json", import.meta.url), "utf-8")
);
const ammIdl = JSON.parse(
  fs.readFileSync(new URL("../target/idl/amm.json", import.meta.url), "utf-8")
);
const crankIdl = JSON.parse(
  fs.readFileSync(new URL("../target/idl/crank_oracle.json", import.meta.url), "utf-8")
);

// Use a dummy read-only provider (no wallet needed for fetches)
const provider = new anchor.AnchorProvider(conn, { publicKey: PublicKey.default }, {});
const amm = new anchor.Program(ammIdl, provider);
const crank = new anchor.Program(crankIdl, provider);

const pub = (s) => new PublicKey(s);
const mint = pub(deployment.mint);

const pda = (prog, seed) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], prog.programId)[0];

// ---- market status (crank) ----
const marketStatus = pub(deployment.marketStatus);
const msInfo = await conn.getAccountInfo(marketStatus);
if (msInfo) {
  const d = msInfo.data;
  console.log("== market_status ==");
  console.log("  state byte @8:", d[8], "(0=open 1=after-hours 2=closed 3=halted)");
  console.log("  day_index @17..25:", Buffer.from(d.slice(17, 25)).readBigUInt64LE().toString());
  console.log("  timestamp:", Buffer.from(d.slice(9, 17)).readBigUInt64LE().toString());
} else {
  console.log("market_status: NOT FOUND");
}

// ---- amm offer list ----
const offerList = pda(amm, "offer_list");
console.log("\n== offer_list ==", offerList.toBase58());
try {
  const sheet = await amm.account.offerList.fetch(offerList);
  console.log("  day_index:", sheet.dayIndex.toString());
  for (const [name, o] of [
    ["big", sheet.bigOffer],
    ["med", sheet.medOffer],
    ["sml", sheet.smlOffer],
  ]) {
    console.log(
      `  ${name}: lot_size=${o.lotSize} discount_bps=${o.discountBps} vesting=${o.vestingDays} total=${o.totalOffered} remaining=${o.remaining}`
    );
  }
} catch (e) {
  console.log("  fetch failed:", e.message);
}

// ---- metrics ----
const metrics = pda(amm, "metrics");
console.log("\n== metrics ==", metrics.toBase58());
try {
  const m = await amm.account.marketMetrics.fetch(metrics);
  const nonzero = m.priceChanges.filter((v) => v !== 0);
  console.log("  day_index:", m.dayIndex.toString());
  console.log("  sample_head:", m.sampleHead);
  console.log("  price_changes nonzero:", nonzero.length, "values:", nonzero.join(","));
  console.log("  trailing_stake_health:", m.trailingStakeHealth.join(","));
  console.log("  total_staked:", m.totalStaked.toString());
  console.log("  total_supply:", m.totalSupply.toString());
  console.log("  daily_close:", m.dailyClose?.toString());
  console.log("  spot_head:", m.spotHead, "spot_last_slot:", m.spotLastSlot?.toString());
  const spotNonzero = m.spotPrices.filter((v) => v.toNumber() !== 0);
  console.log("  spot_prices nonzero:", spotNonzero.length);
} catch (e) {
  console.log("  fetch failed:", e.message);
}

// ---- amm state ----
const ammState = pub(deployment.ammState);
console.log("\n== amm_state ==");
try {
  const s = await amm.account.ammState.fetch(ammState);
  console.log("  afho_mint:", s.afhoMint.toBase58());
  console.log("  afho_vault:", s.afhoVault.toBase58());
  console.log("  keeper:", s.keeper.toBase58());
  console.log("  authority:", s.authority.toBase58());
  console.log("  highest_buyback_basis:", s.highestBuybackBasis.toString());
  console.log("  untaken_days:", s.untakenDays);
  console.log("  cpmm_pool_state:", s.cpmmPoolState?.toBase58?.() ?? s.cpmmPoolState);
  console.log("  dex_program:", s.dexProgram?.toBase58?.() ?? s.dexProgram);
} catch (e) {
  console.log("  fetch failed:", e.message);
}

// ---- vault balance ----
const vault = pub(deployment.ammAfhoVault);
const vInfo = await conn.getAccountInfo(vault);
if (vInfo && vInfo.data.length >= 72) {
  console.log("\n== afho_vault ==");
  console.log("  amount (raw):", Buffer.from(vInfo.data.slice(64, 72)).readBigUInt64LE().toString());
  console.log("  amount (AFHO):", Number(Buffer.from(vInfo.data.slice(64, 72)).readBigUInt64LE()) / 1e9);
} else {
  console.log("\nafho_vault: NOT FOUND or too small", vInfo?.data.length);
}
