# Port of calculate_momentum_score + offer_accepted_aggression + discount step
# for the stock amm-test-data.ts scenario (pure arithmetic check)
price_changes = [30 + i * 10 for i in range(20)]  # 30..220 cp
head = 0
n = len(price_changes)
MIN_SAMPLES = 5
CAP = 1000
count = 0
w_sum = 0
w_total = 0
recent_sum = 0
recent_n = 0
older_sum = 0
older_n = 0
for age in range(n):
    raw = price_changes[(head + age) % n]
    if raw == 0:
        continue
    v = max(-CAP, min(CAP, raw))
    count += 1
    w = age + 1
    w_sum += v * w
    w_total += w
    if age >= n - 5:
        recent_sum += v
        recent_n += 1
    else:
        older_sum += v
        older_n += 1
print("nonzero samples:", count)
if count < MIN_SAMPLES:
    momentum = 0
else:
    weighted_avg = w_sum // w_total
    trend = (recent_sum // recent_n - older_sum // older_n) if recent_n and older_n else 0
    blended = weighted_avg + trend // 2
    momentum = max(0, min(10000, 5000 + blended * 5000 // 500))
print("momentum:", momentum)

REC = [5, 6, 7, 8, 9]
TIER = [1, 2, 4]
rings = {"sml": [30, 45, 55, 65, 75], "med": [20, 35, 50, 60, 70], "big": [10, 20, 30, 40, 50]}
tw = 0
tp = 0
for ti, ring in enumerate(rings.values()):
    for d, pct in enumerate(ring):
        w = REC[d] * TIER[ti]
        tw += pct * w
        tp += 100 * w
aggr = tw * 10000 // tp
print("aggression:", aggr)

def totals_bps(m):
    PTS = [(4500, 50), (5500, 200), (6750, 500), (7500, 500), (8500, 200), (10000, 200)]
    if m == 0:
        return 0
    if m < 4500:
        return 40
    for (x0, y0), (x1, y1) in zip(PTS, PTS[1:]):
        if m <= x1:
            return y0 + (m - x0) * (y1 - y0) // (x1 - x0)
    return 200

tot = totals_bps(momentum)
print("totals bps:", tot)

def bump(m):
    PTS = [(4500, 300), (5750, 1350), (8000, 810), (10000, 810)]
    if m < 4500:
        return 300
    for (x0, y0), (x1, y1) in zip(PTS, PTS[1:]):
        if m <= x1:
            return y0 + (m - x0) * (y1 - y0) // (x1 - x0)
    return 810

base = max(0, bump(momentum) - 400 * aggr // 10000)
raw = [base, base + 150, base + 300]
big = max(0, min(255, raw[2] // 10))
med = max(0, min(big - 1, raw[1] // 10))
sml = max(0, min(med - 1, raw[0] // 10))
print("stored discounts sml/med/big:", sml, med, big, "(MIN_LIST_STORED = 20)")

vault = int(0.99 * 1_000_000_000 * 1e9)
tokens = vault * tot // 10000
print("vault raw:", vault, "-> total_tokens (raw):", tokens, "=", f"{tokens/1e9:,.0f} AFHO")
