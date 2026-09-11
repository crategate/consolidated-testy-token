#!/usr/bin/env python3
"""Exact port of the on-chain offer combinator (make_offers.rs + helpers) to
compute example sheets for a set of AMM states, plus what-if variants
(u16 counts / raised tier ceiling)."""

LOT = [0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
       15000, 20000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000]


def totals_bps(m):
    pts = [(4500, 50), (5500, 200), (6750, 500), (7500, 500), (8500, 200), (10000, 200)]
    if m == 0:
        return 0
    if m < pts[0][0]:
        return 40
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if m <= x1:
            return y0 + (m - x0) * (y1 - y0) // (x1 - x0)
    return 200


def lot_tiers(vault, supply, mom_x, excitement, ceiling_fn=None):
    abundance = (vault * 100 // supply) if supply else 0
    if ceiling_fn:
        ceiling = ceiling_fn(abundance)
    else:
        ceiling = 9 if abundance >= 30 else 7 if abundance >= 20 else 5 if abundance >= 10 else 3 if abundance >= 4 else 1
    climb = ((10000 - excitement) * 4 + 5000) // 10000
    big = max(3, ceiling - climb)
    spacing = 2 + (2 * mom_x + 5000) // 10000  # 2..4
    med = max(2, min(big - 1, big - spacing))
    sml = max(1, min(med - 1, med - spacing))
    return sml, med, big, abundance, ceiling, climb, spacing


def tier_counts(total_tokens, tiers, cap):
    shares = [15, 35, 50]  # sml, med, big
    out = []
    for lot, share in zip([LOT[t] for t in tiers], shares):
        mass = total_tokens * share // 100
        out.append(min(cap, mass // lot) if lot else 0)
    return out


def discount_bump(m):
    pts = [(4500, 300), (5750, 1350), (8000, 810), (10000, 810)]
    if m < pts[0][0]:
        return 300
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if m <= x1:
            return y0 + (m - x0) * (y1 - y0) // (x1 - x0)
    return 810


def cascade(raw):
    big = max(0, min(255, raw[2] // 10))
    med = max(0, min(big - 1, raw[1] // 10))
    sml = max(0, min(med - 1, raw[0] // 10))
    return [sml, med, big]


def vesting(base, health, target_bps, realized_bps):
    scaled = (base * (50 + health) + 50) // 100
    days_off = 3 * max(0, target_bps - realized_bps) // 100
    return max(3, min(25, scaled - days_off))


def sheet(vault, supply, momentum, aggression, health, count_cap=255, ceiling_fn=None, label=""):
    tp = totals_bps(momentum)
    total_tokens = vault * tp // 10000
    mom_x = min(6500, max(0, momentum - 3500)) * 10000 // 6500
    excitement = (6 * mom_x + 4 * aggression) // 10
    sml, med, big, abundance, ceiling, climb, spacing = lot_tiers(vault, supply, mom_x, excitement, ceiling_fn)
    tiers = [sml, med, big]
    counts = tier_counts(total_tokens, tiers, count_cap)
    base_disc = max(0, discount_bump(momentum) - 400 * aggression // 10000)
    raw = [base_disc, base_disc + 150, base_disc + 300]
    stored = cascade(raw)
    bases = [5, 10, 20]
    rows = []
    for i, name in enumerate(["sml", "med", "big"]):
        listed = counts[i] > 0 and stored[i] >= 20
        rows.append({
            "name": name,
            "tier": tiers[i] if listed else 0,
            "lot": LOT[tiers[i]],
            "mass": total_tokens * [15, 35, 50][i] // 100,
            "count": counts[i] if listed else 0,
            "disc": stored[i] / 10 if listed else 0,
            "vest": vesting(bases[i], health, raw[i], stored[i] * 10) if listed else 0,
        })
    print(f"── {label}")
    print(f"   vault={vault/1e6:,.1f}M AFHO  supply={supply/1e6:,.1f}M ({abundance}%)  mom={momentum} aggr={aggression} health={health}")
    print(f"   totals {tp}bps = {total_tokens/1e6:,.2f}M AFHO   mom_x={mom_x} excitement={excitement}")
    print(f"   ceiling={ceiling} climb={climb} spacing={spacing}  →  tiers sml/med/big = {sml}/{med}/{big} (lots {LOT[sml]}/{LOT[med]}/{LOT[big]} AFHO)")
    for r in rows:
        cap_note = "" if r["count"] else "  (unlisted: zero count or discount < 2%)"
        print(f"   {r['name']}: tier {r['tier']}  lot {r['lot']:>8,}  count {r['count']:>6,}  listed {r['count']*r['lot']/1e6:>9,.3f}M  disc {r['disc']:>4}%  vest {r['vest']:>2}d{cap_note}")
    return rows


print("=" * 78)
print("CURRENT CODE (u8 counts, cap 255) — example states")
print("=" * 78)
S1 = sheet(563_250_000, 1_000_000_000, 7400, 4500, 40, label="S1 devnet now (big vault, warm momentum)")
S2 = sheet(563_250_000, 1_000_000_000, 9000, 8000, 60, label="S2 euphoria (same vault, hot momentum + proven demand)")
S3 = sheet(563_250_000, 1_000_000_000, 4500, 1200, 10, label="S3 bear (same vault, weak momentum, cold demand)")
S4 = sheet(400_000_000, 1_000_000_000, 5500, 2500, 20, label="S4 early quiet (40% vault)")
S5 = sheet(80_000_000, 1_000_000_000, 6000, 3000, 30, label="S5 drained vault (8% supply left in vault)")
S6 = sheet(1_000_000, 1_000_000, 7060, 4138, 0, label="S6 test-data repro (vault = full 1M supply, zero stake ratio)")

print()
print("=" * 78)
print("VARIANT A: u16 counts (cap 65535), same ladder — S1/S2/S3")
print("=" * 78)
for (v, s, m, a, h, name) in [(563_250_000, 1_000_000_000, 7400, 4500, 40, "S1"),
                                (563_250_000, 1_000_000_000, 9000, 8000, 60, "S2"),
                                (563_250_000, 1_000_000_000, 4500, 1200, 10, "S3")]:
    sheet(v, s, m, a, h, count_cap=65535, label=f"{name} + u16")

print()
print("=" * 78)
print("VARIANT B: raised ceiling (abundance>=30 -> 15, >=20 -> 12, >=10 -> 9, >=4 -> 6), u8 counts")
print("=" * 78)
ceil_hi = lambda a: 15 if a >= 30 else 12 if a >= 20 else 9 if a >= 10 else 6 if a >= 4 else 3
for (v, s, m, a, h, name) in [(563_250_000, 1_000_000_000, 7400, 4500, 40, "S1"),
                                (563_250_000, 1_000_000_000, 9000, 8000, 60, "S2"),
                                (400_000_000, 1_000_000_000, 5500, 2500, 20, "S4"),
                                (80_000_000, 1_000_000_000, 6000, 3000, 30, "S5")]:
    sheet(v, s, m, a, h, ceiling_fn=ceil_hi, label=f"{name} + raised ceiling (u8)")

print()
print("=" * 78)
print("VARIANT C: raised ceiling + u16 counts")
print("=" * 78)
for (v, s, m, a, h, name) in [(563_250_000, 1_000_000_000, 7400, 4500, 40, "S1"),
                                (563_250_000, 1_000_000_000, 9000, 8000, 60, "S2")]:
    sheet(v, s, m, a, h, count_cap=65535, ceiling_fn=ceil_hi, label=f"{name} + ceiling + u16")

print()
print("=" * 78)
print("TIER VARIANCE — current ladder, abundance >= 30% (ceiling 9)")
print("=" * 78)
print("excitement → climb: 0→4, 2500→3, 5000→2, 7500→1, 10000→0")
print("spacing = 2 + (2*mom_x + 5000)//10000   (mom_x 0→2, 5000→3, 10000→4)")
grid = {}
for exc_bucket, exc in [("E<2500", 1200), ("E~5000", 5000), ("E~7500", 7500), ("E>8750", 9500)]:
    for mx_bucket, mx in [("mx~0", 0), ("mx~5000", 5000), ("mx~10000", 10000)]:
        sml, med, big, a, c, climb, sp = lot_tiers(563_250_000, 1_000_000_000, mx, exc)
        print(f"   {exc_bucket:>7} {mx_bucket:>9} → tiers {sml}/{med}/{big}  (lots {LOT[sml]}/{LOT[med]}/{LOT[big]})")
