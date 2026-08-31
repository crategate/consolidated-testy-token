import { Connection, PublicKey } from "@solana/web3.js";
const c = new Connection("http://127.0.0.1:8899", "confirmed");
const info = await c.getAccountInfo(new PublicKey(process.argv[2]));
console.log("owner:", info?.owner.toBase58(), "len:", info?.data.length);
if (info && info.data.length >= 72) {
  console.log("amount@64:", Buffer.from(info.data.slice(64, 72)).readBigUInt64LE().toString());
}
