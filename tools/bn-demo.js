const BN = require("bn.js");
const decimals = 9;

function tryIt(label, fn) {
  try {
    console.log(label, "-> OK, value =", fn().toString());
  } catch (e) {
    console.log(label, "-> THREW:", e.message);
  }
}

// What the previously-working pool was seeded with (committed HEAD numbers):
tryIt("OLD  seedAfho: new BN(1000 * 1e9)     ", () => new BN(1000 * 10 ** decimals));
// Your new numbers:
tryIt("NEW  seedAfho: new BN(249000000 * 1e9)", () => new BN(249000000 * 10 ** decimals));
// Your new numbers, safe construction (the fix now in mint-launch.ts):
tryIt("FIXED seedAfho: BN(249M).mul(10^9)    ", () => new BN(249000000).mul(new BN(10).pow(new BN(9))));
// Boundary check — the max number bn.js accepts:
tryIt("max accepted: new BN(2**53 - 1)       ", () => new BN(2 ** 53 - 1));
