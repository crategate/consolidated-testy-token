#!/usr/bin/env python3
"""Offer-sheet scenario sweep — exact port of the make_offers 5-step
combinator (make_offers.rs: daily_totals_pct_bps, lot_tiers, tier_counts,
discount_bump + cascade_discounts, vesting_days) driven over a dozen labeled
AMM states, so the sheet's behavior can be eyeballed without touching devnet.

Pure stdlib. Run: python3 sim/sheet_scenarios.py

Floor units: price-per-token x 1e9 (nano-USD). Costs below use PRICE_FLOOR
as the live price so per-lot USDC lines up with the offer-desk at that price.
"""

LOT_LADDER = [0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500,
              10000, 15000, 20000, 50000, 100000, 250000, 500000, 1000000,
              2500000, 5000000, 10000000]  # tiers 0..22 (top = 10M tokens)
LADDER_TOP = 22
MIN_LIST_STORED = 20          # tenths of a percent — below = unlisted
SHARES = (15, 35, 50)         # token-mass split sml/med/big
VEST_BASE = (5, 10, 20)       # sml/med/big base vesting days
PRICE_FLOOR = 10_390          # live devnet price (floor units) ≈ $1.039e-5
USDC_PER_TOKEN = PRICE_FLOOR / 1e9


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def mom_x_of(momentum):
    return clamp(momentum - 3_500, 0, 6_500) * 10_000 // 6_500


def excitement_of(mom_x, aggression):
    return (6 * mom_x + 4 * aggression) // 10


def daily_totals_pct_bps(momentum):
    pts = [(4500, 50), (5500, 200), (6750, 500), (7500, 500), (8500, 200), (10000, 200)]
    if momentum == 0:
        return 0
    m = momentum
    if m < pts[0][0]:
        return 40
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if m <= x1:
            return y0 + (m - x0) * (y1 - y0) // (x1 - x0)
    return 200


def lot_tiers(vault_tokens, supply, mom_x, excitement):
    abundance = vault_tokens * 100 // supply if supply > 0 else 0
    ceiling = (9 if abundance >= 30 else 7 if abundance >= 20 else 5
               if abundance >= 10 else 3 if abundance >= 4 else 1)
    target = vault_tokens // 100  # ceiling tier targets 1% of vault
    t_hat = 0
    if target > 0:
        for t in range(LADDER_TOP, 0, -1):
            if LOT_LADDER[t] <= target:
                t_hat = t
                break
    shift = clamp(t_hat - ceiling, 0, LADDER_TOP - ceiling)
    climb = ((10_000 - excitement) * 4 + 5_000) // 10_000
    big = clamp(ceiling + shift - climb, 3, LADDER_TOP)
    spacing = 2 + (2 * mom_x + 5_000) // 10_000
    med = clamp(big - spacing, 2, big - 1)
    sml = clamp(med - spacing, 1, med - 1)
    return sml, med, big


def tier_counts(total_tokens, tiers):
    counts = []
    for share, tier in zip(SHARES, tiers):
        mass = total_tokens * share // 100
        lot = LOT_LADDER[tier]
        counts.append(mass // lot if lot else 0)
    return counts


def discount_bump(momentum):
    pts = [(4500, 300), (5750, 1350), (8000, 810), (10000, 810)]
    m = momentum
    if m < pts[0][0]:
        return 300
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if m <= x1:
            return y0 + (m - x0) * (y1 - y0) // (x1 - x0)
    return 810


def cascade(raw, stored_big_cap=255):
    big = clamp(raw[2] // 10, 0, stored_big_cap)
    med = clamp(raw[1] // 10, 0, max(big - 1, 0))
    sml = clamp(raw[0] // 10, 0, max(med - 1, 0))
    return sml, med, big


def vesting_days(base, health, target_bps, realized_bps):
    scaled = (base * (50 + health) + 50) // 100
    days_off = 3 * max(0, target_bps - realized_bps) // 100
    return clamp(scaled - days_off, 3, 25)


def build_sheet(vault_tokens, supply, momentum, aggression, health):
    mom_x = mom_x_of(momentum)
    excitement = excitement_of(mom_x, aggression)
    totals_bps = daily_totals_pct_bps(momentum)
    total_tokens = vault_tokens * totals_bps // 10_000
    tiers = lot_tiers(vault_tokens, supply, mom_x, excitement)
    counts = tier_counts(total_tokens, tiers)
    base_disc = max(discount_bump(momentum) - 400 * aggression // 10_000, 0)
    raw = (base_disc, base_disc + 150, base_disc + 300)
    stored = cascade(raw)
    sheet = []
    for i in range(3):
        listed = counts[i] > 0 and stored[i] >= MIN_LIST_STORED
        vest = vesting_days(VEST_BASE[i], health, raw[i], stored[i] * 10) if listed else 0
        sheet.append({
            "tier": tiers[i], "lot": LOT_LADDER[tiers[i]], "count": counts[i],
            "disc": stored[i] / 10.0, "vest": vest,
            "listed": listed, "per_lot_usdc": LOT_LADDER[tiers[i]] * USDC_PER_TOKEN * (1 - stored[i] / 1000.0),
        })
    offered = sum(s["lot"] * s["count"] for s in sheet)
    return {
        "totals_bps": totals_bps, "total_tokens": total_tokens, "tiers": tiers,
        "sheet": sheet, "offered": offered, "pct_vault": offered * 100.0 / max(vault_tokens, 1),
        "abundance": vault_tokens * 100 // supply if supply else 0,
    }


SCENARIOS = [
    # label,                                  vault,    mom,   aggr, health
    ("Cold start (no price data)",            750_000_000, 0,     0,    40),
    ("Dead flat / quiet chop",                750_000_000, 4_000, 2_000, 40),
    ("Healthy flat (range-bound)",            750_000_000, 4_600, 2_500, 50),
    ("Warming up (early bull)",               750_000_000, 5_200, 3_500, 45),
    ("Ignition (discount peak, mom 5750)",    750_000_000, 5_750, 4_000, 50),
    ("Full bull run",                         750_000_000, 6_800, 5_500, 60),
    ("Euphoria / local top",                  750_000_000, 8_500, 7_000, 65),
    ("Blow-off max euphoria",                 750_000_000, 10_000, 9_000, 70),
    ("Wash-spike plateau (parked mom ~7600)", 750_000_000, 7_600, 8_000, 55),
    ("Post-dump, weak hands sold fills",      750_000_000, 3_600, 8_000, 30),
    ("Heavy staking (health 90)",             750_000_000, 6_000, 4_000, 90),
    ("No stakers (health 0)",                 750_000_000, 6_000, 4_000, 0),
    ("Draining vault (60M left)",             60_000_000, 6_000, 4_000, 50),
    ("Small-vault regime (400k left)",        400_000, 6_000, 4_000, 50),
    ("Full 1B vault (supply cap)",            1_000_000_000, 6_800, 5_500, 60),
]

HEADER = ("== offer-sheet scenario sweep (exact make_offers port; costs at "
         "PRICE_FLOOR = {:,} floor units ≈ ${:.2e}/tok)".format(PRICE_FLOOR, USDC_PER_TOKEN))
print(HEADER)
print()

for label, vault, mom, aggr, health in SCENARIOS:
    supply = 1_000_000_000
    r = build_sheet(vault, supply, mom, aggr, health)

    print(f"== {label}")
    print(f"   inputs: momentum {mom}  aggression {aggr}  stake_health {health}  "
          f"vault {vault:,} tok ({r['abundance']}% of supply)")
    print(f"   totals {r['totals_bps']} bps → {r['total_tokens']:,} tok offered "
          f"({r['pct_vault']:.2f}% of vault) · tiers {r['tiers'][0]}/{r['tiers'][1]}/{r['tiers'][2]}")
    for name, s in zip(("sml", "med", "big"), r["sheet"]):
        if s["listed"]:
            px = s["per_lot_usdc"]
            px_str = f"{px:.2f}" if px >= 0.01 else f"{px:.4f}"
            print(f"     {name:>3}: {s['count']:>6} lots x {s['lot']:>10,} tok  "
                  f"{s['disc']:>5.1f}% off  {s['vest']:>2}d vest  ≈{px_str} USDC/lot")
        else:
            why = "count 0" if s["count"] == 0 else f"disc {s['disc']}% < 2.0%"
            print(f"     {name:>3}: — unlisted ({why})")
    print()
