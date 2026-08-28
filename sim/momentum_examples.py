"""Momentum examples: what price_changes ring -> what momentum score ->
what % of vault offered. Exact ports of the deployed formulas
(metrics.calculate_momentum_score + make_offers.daily_totals_pct_bps).

price_changes: [i16; 20] daily priceChange24h in centi-percent (200 = +2%),
oldest -> newest, sample_head = 0 (full ring). Per-sample clamp +-1000cp.
A raw 0 entry reads as "no sample" (skipped entirely).

Run: python3 sim/momentum_examples.py
"""

import sys

sys.path.insert(0, ".")
from sim.metrics import MetricsState, calculate_momentum_score
from sim.mc_sweep import daily_totals_pct_bps

VAULT = 400_000  # 40% of the 1M supply


def score(ring):
    m = MetricsState(0, 1_000_000)
    m.price_changes = list(ring)
    m.sample_head = 0
    return calculate_momentum_score(m)


EXAMPLES = [
    ("COLD START (0 samples)", [0] * 20),
    ("COLD START (4 green days)", [0] * 16 + [200] * 4),
    ("FLAT ZERO (20x 0.00% days)", [0] * 20),
    ("5 GREEN DAYS +2%/day (thin ring)", [0] * 15 + [200] * 5),
    ("CHOP, noise +-0.10%/day", [10, -10] * 10),
    ("STEADY -5.0%/day (crashes)", [-500] * 20),
    ("5 CRASH DAYS -10%/day (clamped)", [0] * 15 + [-1000] * 5),
    ("STEADY -2.0%/day", [-200] * 20),
    ("STEADY -1.0%/day", [-100] * 20),
    ("STEADY -0.5%/day", [-50] * 20),
    ("STEADY +0.3%/day", [30] * 20),
    ("STEADY +0.5%/day", [50] * 20),
    ("STEADY +1.0%/day", [100] * 20),
    ("STEADY +1.75%/day", [175] * 20),
    ("STEADY +2.0%/day", [200] * 20),
    ("STEADY +2.5%/day", [250] * 20),
    ("STEADY +3.0%/day", [300] * 20),
    ("STEADY +4.0%/day", [400] * 20),
    ("STEADY +5.0%/day (clamps)", [500] * 20),
    ("IGNITION RAMP 0.3->2.2% over 20d", [30 + 10 * i for i in range(20)]),
    ("WASH PUMP: chop, then +40% day", [20] * 19 + [1000]),
    ("V-SHAPE: 15 bear days, 5 +3%/day", [-50] * 15 + [300] * 5),
    ("SLOW BLEED then FLAT: 15x -30cp, 5x +10cp", [-30] * 15 + [10] * 5),
]

print(f"{'ring (20 days, oldest->newest)':<34} {'momentum':>9} {'bps':>5} {'% vault':>8} {'tokens@400k':>12}")
print("-" * 84)
for name, ring in EXAMPLES:
    m = score(ring)
    bps = daily_totals_pct_bps(m)
    pct = bps / 100
    toks = VAULT * bps // 10_000
    print(f"{name:<34} {m:>9} {bps:>5} {pct:>7.2f}% {toks:>11,}")
