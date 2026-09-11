import { quoteEffectivePrice } from './omcheck-out/offerMath.js';

// live price 5200 floor-units ($5.2e-6/token), tier discount 11.5% (115 tenths), bonus 0.5% (5 tenths)
const live = 5200n, disc = 115, bonus = 5;
const fmt = (n) => n === null ? 'null' : n.toString();
let failures = 0;
function check(name, actual, expect, extra = '') {
    const ok = actual === expect;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${fmt(actual)}, want ${fmt(expect)}${extra ? ' — ' + extra : ''}`);
}

// 1) STATE 1, floor in the old rescue band [live, live + 0.5%·live): floor = 5210
const band = 5210n;
const s1band = quoteEffectivePrice(live, disc, bonus, band, 1);
check('state 1, floor 5210 (rescue band) → floor held, NO bonus', s1band, 5210n, `>= live → ${s1band >= live}`);

// 2) STATE 2, same floor: bonus allowance applies
const s2band = quoteEffectivePrice(live, disc, bonus, band, 2);
check('state 2, floor 5210 → floor − 0.5%·live = 5184', s2band, 5184n,
    `real discount ${(100 * Number(live - s2band) / Number(live)).toFixed(3)}%`);

// 3) STATE 1, floor well below spot: normal discounted sale, unchanged
const s1normal = quoteEffectivePrice(live, disc, bonus, 4000n, 1);
check('state 1, floor 4000 → full 11.5% discount', s1normal, live - (live * 1150n) / 10000n);

// 4) STATE 1, floor far above spot: floor held, unchanged
const s1far = quoteEffectivePrice(live, disc, bonus, 5300n, 1);
check('state 1, floor 5300 → floor held', s1far, 5300n);

// 5) bonus param is inert outside state 2 — bonus=5 vs 0 in state 1
const a = quoteEffectivePrice(live, disc, 5, band, 1);
const b = quoteEffectivePrice(live, disc, 0, band, 1);
check('state 1 bonus inert (5 vs 0 identical)', a === b, true);

// 6) state 2 boost still deepens the discounted quote (bonusDeepensDiscount)
const s2deep = quoteEffectivePrice(live, disc, bonus, 4000n, 2);
check('state 2, floor 4000 → 12% off (disc + bonus)', s2deep, live - (live * 1200n) / 10000n);

process.exit(failures === 0 ? 0 : 1);
