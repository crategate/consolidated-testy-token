// Read-only X check: GET /2/users/me with CURRENT .env credentials. No posting.
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
require("dotenv").config();

const CK = process.env.X_CONSUMER_KEY;
const CS = process.env.X_CONSUMER_SECRET ?? process.env.SECRET_KEY;
const AT = process.env.X_ACCESS_TOKEN;
const ATS = process.env.X_ACCESS_TOKEN_SECRET;

const pe = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const url = "https://api.twitter.com/2/users/me";
const oauth = {
  oauth_consumer_key: CK,
  oauth_nonce: crypto.randomBytes(16).toString("hex"),
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  oauth_token: AT,
  oauth_version: "1.0",
};
const paramString = Object.keys(oauth).sort().map((k) => `${pe(k)}=${pe(oauth[k])}`).join("&");
const baseString = `GET&${pe(url)}&${pe(paramString)}`;
const signature = crypto.createHmac("sha1", `${pe(CS)}&${pe(ATS)}`).update(baseString).digest("base64");
const header = { ...oauth, oauth_signature: signature };
const auth = "OAuth " + Object.keys(header).sort().map((k) => `${pe(k)}="${pe(header[k])}"`).join(", ");

https.get(url, { headers: { Authorization: auth, "User-Agent": "afho-x-check" } }, (res) => {
  let d = "";
  res.on("data", (c) => (d += c));
  res.on("end", () => {
    console.log("HTTP", res.statusCode);
    console.log(d.slice(0, 500));
  });
}).on("error", (e) => console.error("transport error:", e.message));
