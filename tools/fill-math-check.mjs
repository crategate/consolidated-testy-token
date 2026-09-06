// Sanity check for the homepage quick-fill math (mirrors StakeForm.tsx +
// useStake.ts exactly, bigint edition of the BN parser).
function rawToAmountString(raw, decimals) {
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
}
function parseToRaw(amount, decimals) {
    let s = amount.trim();
    if (/e/i.test(s)) s = Number(s).toString();
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1);
    const [whole, frac = ''] = s.split('.');
    const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    const v = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
    return neg ? -v : v;
}

const cases = [
    18446744073709551615n, // u64 max
    750000000000000000n,   // 750M tokens (devnet vault scale)
    9006000000000000n,     // the 9,006,000 UI threshold
    9007199254740993n,     // 2^53 + 1 (float precision boundary)
    123456789n,            // 0.123456789 tokens
    5n,                    // 5 nano-tokens
];
for (let i = 0; i < 2000; i++) {
    cases.push(BigInt(Math.floor(Math.random() * 2 ** 53)) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
}

let fail = 0;
for (const raw of cases) {
    for (const pct of [25, 50, 75, 100]) {
        const fill = pct >= 100 ? raw : (raw * BigInt(pct)) / 100n;
        const s = rawToAmountString(fill, 9);
        const back = parseToRaw(s, 9);
        if (back !== fill || back > raw) { fail++; console.log('FAIL', raw, pct, s, back); }
    }
}

// Does the OLD float parse (`Number(amount) * 1e9`) round above raw for max fills?
let above = 0;
for (const raw of cases.slice(0, 6)) {
    const s = rawToAmountString(raw, 9);
    if (Number(s) * 1e9 > raw) above++;
}

// Parser edge cases that must not throw / must stay conservative
const edges = ['0.5', '12.', '.25', '0.000000005', '1e9', '  42  ', '1000000000', '0.1234567894999'];
const edgeResults = edges.map((e) => {
    try { return `${e} -> ${parseToRaw(e, 9)}`; } catch (err) { return `${e} -> THROWS`; }
});

console.log('roundtrip+pct cases:', cases.length * 4, 'failures:', fail);
console.log('old float path over-balance on max fills:', above, '/ 6');
console.log(edgeResults.join('\n'));
