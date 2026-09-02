"""Monte Carlo sweep of the DEPLOYED on-chain offer combinator (make_offers.rs).

Exact integer port of the real pipeline — momentum / stake-health / aggression
feeding the 5-step sequential combinator (totals -> lot tiers -> counts ->
discount cascade -> vesting). This is intentionally NOT combiner_v3.py, which
adds a floor-cap model that does not exist on-chain (the ratchet floor is only
applied at offer_claim, not at sheet construction).

Outputs: a text report (stdout) + PNG explainers in sim/graphs/mc_*.

Usage: python3 sim/mc_sweep.py
"""

import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plot import (BLUE, GRAY, GREEN, INK, LGRAY, RED, WHITE, Canvas, Plot,
                  check_png, save_png)

LOT_LADDER = [0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500,
              10000, 15000, 20000, 50000, 100000, 250000, 500000, 1000000,
              2500000, 5000000, 10000000, 25000000, 50000000, 100000000]
TIERS = ("sml", "med", "big")
VEST_BASE = {"sml": 5, "med": 10, "big": 20}
VEST_MIN, VEST_MAX = 3, 25   # 25 = big-tier cap (sml/med saturate below: 8/15)
MIN_LIST_STORED = 20   # tenths of a percent (200 bps)
SUPPLY = 1_000_000

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "graphs")
os.makedirs(OUT, exist_ok=True)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def lot_sizer(t):
    return LOT_LADDER[t] if 0 <= t < len(LOT_LADDER) else 0


def daily_totals_pct_bps(m):
    PTS = [(4500, 50), (5500, 200), (6750, 500), (7500, 500), (8500, 200), (10000, 200)]
    if m == 0:
        return 0
    if m < 4500:
        return 40
    for (x0, y0), (x1, y1) in zip(PTS, PTS[1:]):
        if m <= x1:
            return y0 + (m - x0) * (y1 - y0) // (x1 - x0)
    return 200


def discount_bump(m):
    PTS = [(4500, 300), (5750, 1350), (8000, 810), (10000, 810)]
    if m < 4500:
        return 300
    for (x0, y0), (x1, y1) in zip(PTS, PTS[1:]):
        if m <= x1:
            return y0 + (m - x0) * (y1 - y0) // (x1 - x0)
    return 810


def lot_tiers(vault, supply, mom_x, excitement):
    """Exact port of make_offers::lot_tiers (devnet-big tier shift included).
    The ladder window rides the vault's magnitude: t_hat = highest tier with
    lot <= vault/100 whole tokens (1% of vault); shift = t_hat - ceiling,
    floored at 0 so the small-vault (<= ~900k tokens) regime keeps the
    original tuned ladder. The ladder extends to tier 25 (100M tokens), so the
    window climbs as high as the vault demands instead of pinning at a
    ceiling."""
    abundance = vault * 100 // supply if supply > 0 else 0
    ceiling = (9 if abundance >= 30 else 7 if abundance >= 20 else 5
               if abundance >= 10 else 3 if abundance >= 4 else 1)
    target = vault // 100
    t_hat = 0
    if target > 0:
        for t in range(25, 0, -1):
            if LOT_LADDER[t] <= target:
                t_hat = t
                break
    shift = clamp(t_hat - ceiling, 0, 25 - ceiling)
    climb = ((10000 - excitement) * 4 + 5000) // 10000
    big = clamp(ceiling + shift - climb, 3, 25)
    spacing = 2 + (2 * mom_x + 5000) // 10000
    med = clamp(big - spacing, 2, big - 1)
    sml = clamp(med - spacing, 1, med - 1)
    return sml, med, big


def tier_counts(total_tokens, tiers):
    shares = (15, 35, 50)   # sml, med, big token-mass split
    out = []
    for sh, t in zip(shares, tiers):
        lot = lot_sizer(t)
        mass = total_tokens * sh // 100
        out.append(mass // lot if lot else 0)
    return out


def vesting_days(base, sh):
    # on-chain the floor-compensation term is always 0 (target-realized < 10 bps),
    # so vesting is a pure function of stake health, clamped 3..25 (big-tier cap).
    return clamp((base * (50 + sh) + 50) // 100, VEST_MIN, VEST_MAX)


def build_sheet(momentum, stake_health, aggression, vault, supply=SUPPLY):
    """Exact port of make_offers::handler. Returns None (dark desk) or a dict."""
    if momentum == 0:
        return None  # cold start (< 5 samples) or score clamped to 0

    totals_bps = daily_totals_pct_bps(momentum)
    total_tokens = vault * totals_bps // 10000
    mom_x = clamp(momentum - 3500, 0, 6500) * 10000 // 6500
    excitement = (6 * mom_x + 4 * aggression) // 10
    tiers = lot_tiers(vault, supply, mom_x, excitement)
    counts = tier_counts(total_tokens, tiers)
    base = max(discount_bump(momentum) - (400 * aggression) // 10000, 0)
    raw = (base, base + 150, base + 300)  # sml, med, big (bps)
    big_s = clamp(raw[2] // 10, 0, 255)
    med_s = clamp(raw[1] // 10, 0, max(big_s - 1, 0))
    sml_s = clamp(raw[0] // 10, 0, max(med_s - 1, 0))
    stored = (sml_s, med_s, big_s)

    listed = {}
    for i, t in enumerate(TIERS):
        if counts[i] > 0 and stored[i] >= MIN_LIST_STORED:
            listed[t] = {
                "lot_index": tiers[i],
                "lot_size": lot_sizer(tiers[i]),
                "total_offered": counts[i],
                "discount_stored": stored[i],       # tenths of a percent
                "discount_pct": stored[i] / 10.0,
                "vesting_days": vesting_days(VEST_BASE[t], stake_health),
            }
    if not listed:
        return None
    return {
        "momentum": momentum, "stake_health": stake_health, "aggression": aggression,
        "vault": vault, "totals_bps": totals_bps, "total_tokens": total_tokens,
        "mom_x": mom_x, "excitement": excitement, "tiers": listed,
    }


# ──────────────────────────── report helpers ────────────────────────────────

def fmt_sheet(s):
    if s is None:
        return "  (dark desk)"
    lines = [f"  totals {s['totals_bps']} bps -> {s['total_tokens']:,} tokens "
             f"(mom_x {s['mom_x']}, E {s['excitement']})"]
    for t in TIERS:
        e = s["tiers"].get(t)
        if not e:
            lines.append(f"  {t:<3}  --")
            continue
        lines.append(f"  {t:<3}  tier {e['lot_index']:>2} ({e['lot_size']:>8,} AFHO)  "
                     f"x{e['total_offered']:<3}  {e['discount_pct']:>5.1f}% off  "
                     f"{e['vesting_days']:>2}d vest")
    return "\n".join(lines)


def mood_table():
    rows = [
        ("COLD START", 0, 40, 0, 0.40),
        ("DEEP BEAR (low momentum)", 400, 25, 1000, 0.40),
        ("CHOP / FLAT", 5000, 40, 3000, 0.40),
        ("IGNITION", 6000, 50, 5000, 0.40),
        ("STRONG RUN (plateau)", 7000, 60, 6000, 0.40),
        ("EUPHORIA TAPER", 8000, 80, 7000, 0.40),
        ("PINNED EUPHORIA", 9500, 100, 8500, 0.40),
        ("BEAR, STILL LISTED", 3000, 30, 1500, 0.40),
        ("HIGH DEMAND / LOW DISC", 6000, 60, 9000, 0.40),
        ("LOW DEMAND / DEEP DISC", 6000, 60, 500, 0.40),
        ("THIN VAULT (4% supply)", 6000, 50, 4000, 0.04),
        ("THIN VAULT (1% supply)", 6000, 50, 4000, 0.01),
        ("LOW STAKE (dumping)", 6000, 10, 5000, 0.40),
        ("HIGH STAKE (sticky)", 6000, 90, 5000, 0.40),
    ]
    print("\n=== EXAMPLE OFFER SHEETS (on-chain combinator, vault = % of supply) ===")
    for label, m, sh, ag, vf in rows:
        vault = int(SUPPLY * vf)
        s = build_sheet(m, sh, ag, vault)
        print(f"\n[{label}]  momentum={m}  stake_health={sh}  aggression={ag}  vault={vf:.0%} of supply")
        print(fmt_sheet(s))


def vesting_report():
    print("\n=== VESTING DAYS (exact on-chain formula) ===")
    print("vest = clamp( (base*(50 + stake_health) + 50) / 100, 3, 25 )")
    print("base: sml=5, med=10, big=20  (the floor-compensation term is always 0 on-chain)")
    print("\n  stake_health   sml(5)   med(10)  big(20)")
    for sh in (0, 10, 25, 40, 50, 75, 100):
        print(f"  {sh:>12}   {vesting_days(5, sh):>4}     {vesting_days(10, sh):>4}     {vesting_days(20, sh):>4}")
    print("\n  MIN = 3 days (sml @ sh=0)     MAX = 25 days (big @ sh=100, capped)")
    print("  'typical' sh=40 -> sml 5 / med 9 / big 18 days")
    print("  NOTE: 25-day vesting is the ABSOLUTE MAXIMUM (big tier at stake_health=100).")


def momentum_gate_report():
    print("\n=== MOMENTUM REQUIREMENT FOR AN ACTIVE SHEET ===")
    print("The ONLY hard momentum gate in make_offers is momentum == 0:")
    print("  * cold start: fewer than 5 nonzero entries in the 20-day price_changes ring")
    print("  * sustained crash: >=5 samples whose blended daily move <= -5% (score clamps to 0)")
    print("  For a normally funded vault (big lot affordable), once momentum > 0 the desk lists")
    print("  EVERY day: the big tier always lists at >= 3.0% off (raw big = base + 300 bps,")
    print("  base >= 0). The sheet SCALES with momentum, it does not turn off.")
    print("  Thin-vault + high-aggression can also dark the desk (see NO-SHEET section).")
    print("\n  momentum -> totals (% vault) and base discount (bps):")
    print("  " + "-" * 62)
    print(f"  {'momentum':>10} {'totals%':>9} {'disc bump':>10} {'base@aggr5k':>12}")
    for m in (0, 1000, 3000, 4500, 5000, 5500, 6000, 6750, 7000, 7500, 8000, 9000, 10000):
        bps = daily_totals_pct_bps(m)
        bump = discount_bump(m)
        base = max(bump - 400 * 5000 // 10000, 0)
        print(f"  {m:>10} {bps/100:>8.2f}% {bump:>10} {base:>12}")


def no_sheet_report():
    print("\n=== WHEN IS THERE *NO* SHEET? (on-chain truth) ===")
    print("A tier lists only when BOTH: (a) its derived count > 0, AND")
    print("(b) its realized discount >= 200 bps (2.0%). So the desk is dark when:")
    print("1. momentum == 0  ->  cold start (<5 samples) OR sustained <= -5%/day crash.")
    print("2. vault too thin ->  total_tokens cannot fill even ONE lot of any tier (counts all 0).")
    print("3. big tier count == 0 AND aggression so high it squeezes sml/med below 2.0%")
    print("   (base = max(300 - 400*aggr/10000, 0); med unlists when aggr > 6250 at low momentum).")
    print("   Only possible when the vault cannot afford a big lot (approx <= 2% of supply).")
    print("   (The ratchet floor does NOT remove a sheet — it only clamps the claim price at")
    print("    offer_claim, so a listed sheet can still execute AT the floor with 0% discount.)")
    print("\n  minimum momentum for a non-empty sheet, by vault size (of 1M supply), aggression=0:")
    print("  " + "-" * 44)
    for vf in (0.40, 0.20, 0.10, 0.04, 0.02, 0.01):
        vault = int(SUPPLY * vf)
        first = next((m for m in range(1, 10001) if build_sheet(m, 40, 0, vault) is not None), None)
        print(f"  vault {vf:>4.0%} ({vault:>7,} AFHO)  ->  active at momentum >= {first if first else 'never'}")


# ──────────────────────────── monte carlo ───────────────────────────────────

def mc_stats(N=20000, seed=7):
    rng = random.Random(seed)
    vaults = [int(SUPPLY * f) for f in (0.40, 0.20, 0.10, 0.04, 0.02, 0.01)]
    active = 0
    tier_count = {1: 0, 2: 0, 3: 0}
    disc = {"sml": [], "med": [], "big": []}
    vest = {"sml": [], "med": [], "big": []}
    tots = []
    # band stats for momentum deciles
    bands = {}
    for _ in range(N):
        m = rng.randint(0, 10000)
        sh = rng.randint(0, 100)
        ag = rng.randint(0, 10000)
        vault = rng.choice(vaults)
        s = build_sheet(m, sh, ag, vault)
        b = m // 1000 * 1000
        bands.setdefault(b, {"n": 0, "active": 0, "disc": []})
        bands[b]["n"] += 1
        if s is None:
            continue
        active += 1
        bands[b]["active"] += 1
        tots.append(s["total_tokens"])
        k = len(s["tiers"])
        tier_count[k] += 1
        for t in TIERS:
            e = s["tiers"].get(t)
            if e:
                disc[t].append(e["discount_pct"])
                vest[t].append(e["vesting_days"])
                if t == "big":
                    bands[b]["disc"].append(e["discount_pct"])

    print("\n=== MONTE CARLO (n=%d, uniform momentum/stake/aggression, vault in {40,20,10,4,2,1}%%) ===" % N)
    print(f"  active sheets: {active}/{N} ({100*active/N:.1f}%)   dark: {N-active} ({100*(N-active)/N:.1f}%)")
    print(f"  tiers listed -> 1 tier: {tier_count[1]}, 2 tiers: {tier_count[2]}, 3 tiers: {tier_count[3]}")
    for t in TIERS:
        if disc[t]:
            d = sorted(disc[t]); v = sorted(vest[t])
            med = len(d) // 2
            print(f"  {t:<3} median discount {d[med]:>5.1f}%  p10 {d[len(d)//10]:>5.1f}%  p90 {d[len(d)*9//10]:>5.1f}%   "
                  f"vesting {v[0]}..{v[-1]}d (med {v[med]}d)")
    if tots:
        t2 = sorted(tots); m2 = len(t2) // 2
        print(f"  total tokens/sheet: p10 {t2[len(t2)//10]:,}  med {t2[m2]:,}  p90 {t2[len(t2)*9//10]:,}")

    print("\n  activation by momentum band (any vault):")
    print("  " + "-" * 52)
    for b in sorted(bands):
        st = bands[b]
        pct = 100 * st["active"] / st["n"]
        md = (sorted(st["disc"])[len(st["disc"]) // 2] if st["disc"] else 0.0)
        bar = "#" * int(pct / 5)
        print(f"  {b:>5}-{b+999:<5}  {pct:>5.1f}% active {bar:<20} big disc med {md:>5.1f}%")
    print("  (the <100% in low-momentum bands is thin-vault + high-aggression samples,")
    print("   NOT momentum: at vault >= 4% every momentum>0 sample lists. see no-sheet section)")
    return bands


# ──────────────────────────── plots ─────────────────────────────────────────

def cmap(t):
    t = clamp(t, 0.0, 1.0)
    stops = [(0.0, (255, 255, 255)), (0.33, (255, 205, 130)),
             (0.66, (235, 120, 60)), (1.0, (150, 25, 25))]
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if t <= b:
            k = (t - a) / (b - a)
            return tuple(int(ca[i] + (cb[i] - ca[i]) * k) for i in range(3))
    return stops[-1][1]


def heatmap(c, x0, y0, x1, y1, grid, lo, hi, nan_color=WHITE):
    """grid[j][i] value at (col i, row j); drawn top-left at (x0,y0)."""
    ncol = len(grid[0]); nrow = len(grid)
    cw = (x1 - x0) / ncol; ch = (y1 - y0) / nrow
    for j in range(nrow):
        for i in range(ncol):
            v = grid[j][i]
            col = nan_color if v is None else cmap((v - lo) / (hi - lo))
            c.rect(x0 + i * cw, y0 + j * ch, x0 + (i + 1) * cw, y0 + (j + 1) * ch, col, fill=True)


def plot_vesting():
    c = Canvas(880, 360)
    xs = list(range(0, 101, 5))
    grid = [[vesting_days(VEST_BASE[t], sh) for sh in xs] for t in TIERS]
    heatmap(c, 150, 60, 840, 210, grid, VEST_MIN, VEST_MAX)
    # row + col labels
    for j, t in enumerate(TIERS):
        c.text(10, 66 + j * 50, f"{t.upper()} BASE {VEST_BASE[t]}", INK)
        for sh in (0, 25, 50, 75, 100):
            x = 150 + sh / 100 * 690
            c.text(x - 6, 74 + j * 50, str(vesting_days(VEST_BASE[t], sh)), INK)
    c.text(150, 30, "VESTING DAYS BY TIER AND STAKE HEALTH (HEAT = MORE DAYS)", INK)
    c.text(150, 216, "STAKE HEALTH 0 -> 100 (5% STEPS); ROWS = sml / med / big", INK)
    c.text(150, 234, "MIN 3d (sml, sh 0)  ...  MAX 25d (big, sh 100, CAPPED)", INK)
    c.text(150, 252, "25-DAY VESTING = ABSOLUTE MAX (BIG TIER CAP)", RED)
    # colorbar
    for k in range(0, 101):
        c.rect(760 + k / 100 * 70, 270, 760 + (k + 1) / 100 * 70, 280, cmap(k / 100), fill=True)
    c.text(760, 292, "3d", INK); c.text(810, 292, "25d", INK)
    path = os.path.join(OUT, "mc_vesting.png")
    save_png(c, path)
    w, h = check_png(path)
    print(f"  wrote mc_vesting.png ({w}x{h})")


def plot_discount_heatmap():
    c = Canvas(880, 600)
    ms = list(range(0, 10001, 250))
    ags = list(range(0, 10001, 500))
    grid = []
    for ag in ags:
        row = []
        for m in ms:
            s = build_sheet(m, 50, ag, int(SUPPLY * 0.40))
            row.append(s["tiers"]["big"]["discount_pct"] if s and "big" in s["tiers"] else None)
        grid.append(row)
    heatmap(c, 140, 40, 840, 520, grid, 0.0, 13.5, nan_color=LGRAY)
    p = Plot(c, 140, 40, 840, 520, xr=(0, 10000), yr=(0, 10000))
    # axis labels on top of the heatmap
    for m in (0, 2500, 5000, 7500, 10000):
        c.line(p.X(m), 520, p.X(m), 524, INK); c.text(p.X(m) - 10, 526, str(m), INK)
    for ag in (0, 2500, 5000, 7500, 10000):
        c.line(136, p.Y(ag), 140, p.Y(ag), INK); c.text(80, p.Y(ag) - 4, str(ag), INK)
    c.text(150, 16, "BIG-TIER DISCOUNT %  (x = MOMENTUM, y = AGGRESSION; GREY = DARK DESK)", INK)
    c.text(150, 540, "MOMENTUM", INK)
    c.text(20, 250, "AGGR", INK)
    # colorbar
    for k in range(0, 101):
        c.rect(580 + k / 100 * 220, 555, 580 + (k + 1) / 100 * 220, 565, cmap(k / 100), fill=True)
    c.text(580, 578, "0%", INK); c.text(780, 578, "13.5%", INK)
    path = os.path.join(OUT, "mc_discount_heatmap.png")
    save_png(c, path)
    w, h = check_png(path)
    print(f"  wrote mc_discount_heatmap.png ({w}x{h})")


def plot_totals_tiers():
    c = Canvas(880, 620)
    ms = list(range(0, 10001, 100))
    p1 = Plot(c, 70, 40, 860, 300, xr=(0, 10000), yr=(0, 5.5))
    p1.frame(xticks=[(0, "0"), (2500, "2500"), (5000, "5000"), (7500, "7500"), (10000, "10000")],
             yticks=[(0, "0"), (1, "1%"), (2, "2%"), (3, "3%"), (4, "4%"), (5, "5%")],
             ylabel="TOTALS % VAULT")
    p1.band(4500, 5500, LGRAY)
    p1.series(ms, [daily_totals_pct_bps(m) / 100 for m in ms], BLUE)
    p1.vline(4500, GRAY); p1.vline(6750, GRAY); p1.vline(7500, GRAY); p1.vline(8500, GRAY)
    p1.text(p1.X(4600), p1.Y(5.3), "IGNITION 4500-5500", INK)
    p1.text(p1.X(6800), p1.Y(5.3), "PLATEAU 6750-7500", INK)
    p1.text(p1.X(7600), p1.Y(3.0), "TAPER", INK)

    p2 = Plot(c, 70, 360, 860, 580, xr=(0, 10000), yr=(0, 10))
    p2.frame(xticks=[(0, "0"), (2500, "2500"), (5000, "5000"), (7500, "7500"), (10000, "10000")],
             yticks=[(0, "0"), (2, "2"), (4, "4"), (6, "6"), (8, "8")],
             xlabel="MOMENTUM", ylabel="BIG LOT TIER")
    for vf, color in ((0.40, BLUE), (0.20, GREEN), (0.10, RED), (0.04, GRAY)):
        vault = int(SUPPLY * vf)
        ys = []
        for m in ms:
            s = build_sheet(m, 50, 4000, vault)
            ys.append(s["tiers"]["big"]["lot_index"] if s and "big" in s["tiers"] else None)
        p2.series(ms, ys, color)
    c.text(90, 590, "VAULT: BLUE 40%  GREEN 20%  RED 10%  GREY 4% OF SUPPLY", INK)
    path = os.path.join(OUT, "mc_totals_tiers.png")
    save_png(c, path)
    w, h = check_png(path)
    print(f"  wrote mc_totals_tiers.png ({w}x{h})")


def plot_active_map():
    c = Canvas(880, 620)
    ms = list(range(0, 10001, 250))
    ags = list(range(0, 10001, 500))
    grid = []
    for ag in ags:
        row = []
        for m in ms:
            s = build_sheet(m, 50, ag, int(SUPPLY * 0.40))
            row.append(0 if s is None else len(s["tiers"]))
        grid.append(row)
    # categorical colors: 0 dark (light grey), 1 tier, 2, 3
    colmap = {0: (235, 235, 235), 1: (255, 210, 150), 2: (230, 130, 90), 3: (150, 25, 25)}
    ncol, nrow = len(ms), len(ags)
    cw, ch = 700 / ncol, 480 / nrow
    for j in range(nrow):
        for i in range(ncol):
            c.rect(140 + i * cw, 40 + j * ch, 140 + (i + 1) * cw, 40 + (j + 1) * ch, colmap[grid[j][i]], fill=True)
    p = Plot(c, 140, 40, 840, 520, xr=(0, 10000), yr=(0, 10000))
    for m in (0, 2500, 5000, 7500, 10000):
        c.line(p.X(m), 520, p.X(m), 524, INK); c.text(p.X(m) - 10, 526, str(m), INK)
    for ag in (0, 2500, 5000, 7500, 10000):
        c.line(136, p.Y(ag), 140, p.Y(ag), INK); c.text(80, p.Y(ag) - 4, str(ag), INK)
    c.text(150, 16, "ACTIVE SHEET vs DARK: GREY=DARK, ORANGE=1 TIER, RED=2, DARK RED=3 TIERS", INK)
    c.text(150, 540, "MOMENTUM", INK); c.text(20, 250, "AGGR", INK)
    c.text(150, 556, "vault 40% of supply, stake_health 50. Dark only where momentum==0.", INK)
    path = os.path.join(OUT, "mc_active_map.png")
    save_png(c, path)
    w, h = check_png(path)
    print(f"  wrote mc_active_map.png ({w}x{h})")


def plot_totals_heatmap():
    c = Canvas(880, 600)
    ms = list(range(0, 10001, 250))
    ags = list(range(0, 10001, 500))
    grid = [[daily_totals_pct_bps(m) / 100.0 for m in ms] for _ in ags]
    heatmap(c, 140, 40, 840, 520, grid, 0.0, 5.0, nan_color=LGRAY)
    p = Plot(c, 140, 40, 840, 520, xr=(0, 10000), yr=(0, 10000))
    for m in (0, 2500, 5000, 7500, 10000):
        c.line(p.X(m), 520, p.X(m), 524, INK); c.text(p.X(m) - 10, 526, str(m), INK)
    for ag in (0, 2500, 5000, 7500, 10000):
        c.line(136, p.Y(ag), 140, p.Y(ag), INK); c.text(80, p.Y(ag) - 4, str(ag), INK)
    c.text(150, 16, "TOTALS OFFERED % OF VAULT  (x = MOMENTUM, y = AGGRESSION; WHITE = 0%/DARK)", INK)
    c.text(150, 540, "MOMENTUM", INK)
    c.text(20, 250, "AGGR", INK)
    # colorbar
    for k in range(0, 101):
        c.rect(580 + k / 100 * 220, 555, 580 + (k + 1) / 100 * 220, 565, cmap(k / 100), fill=True)
    c.text(580, 578, "0%", INK); c.text(770, 578, "5%", INK)
    c.text(150, 556, "rows identical: totals depend ONLY on momentum (aggression shapes tiers/discounts)", INK)
    path = os.path.join(OUT, "mc_totals_heatmap.png")
    save_png(c, path)
    w, h = check_png(path)
    print(f"  wrote mc_totals_heatmap.png ({w}x{h})")


def plot_examples():
    examples = [
        ("COLD START", 0, 40, 0, 0.40),
        ("CHOP FLAT", 5000, 40, 3000, 0.40),
        ("IGNITION", 6000, 50, 5000, 0.40),
        ("PLATEAU", 7000, 60, 6000, 0.40),
        ("EUPHORIA TAPER", 8000, 80, 7000, 0.40),
        ("PINNED", 9500, 100, 8500, 0.40),
        ("BEAR LISTED", 3000, 30, 1500, 0.40),
        ("HIGH DEMAND", 6000, 60, 9000, 0.40),
        ("LOW DEMAND", 6000, 60, 500, 0.40),
    ]
    c = Canvas(900, 640)
    colw = 300
    x0 = 10
    for idx, (label, m, sh, ag, vf) in enumerate(examples):
        row, col = divmod(idx, 3)
        px = x0 + col * colw
        py = 10 + row * 210
        s = build_sheet(m, sh, ag, int(SUPPLY * vf))
        c.text(px, py, f"{label} (m{m} sh{sh} a{ag})", INK)
        y = py + 14
        if s is None:
            c.text(px, y, "DARK DESK", RED)
            c.text(px, y + 14, "momentum == 0", INK)
            continue
        c.text(px, y, f"totals {s['totals_bps']}bps {s['total_tokens']:,} tok", INK); y += 14
        for t in TIERS:
            e = s["tiers"].get(t)
            if not e:
                c.text(px, y, f"{t}: --", GRAY); y += 14
                continue
            c.text(px, y, f"{t}: t{e['lot_index']} {e['lot_size']:,} x{e['total_offered']} "
                          f"{e['discount_pct']:.1f}% {e['vesting_days']}d", INK)
            y += 14
    path = os.path.join(OUT, "mc_examples.png")
    save_png(c, path)
    w, h = check_png(path)
    print(f"  wrote mc_examples.png ({w}x{h})")


def main():
    vesting_report()
    momentum_gate_report()
    no_sheet_report()
    mood_table()
    mc_stats()

    print("\n=== rendering PNGs ->", OUT, "===")
    plot_vesting()
    plot_discount_heatmap()
    plot_totals_heatmap()
    plot_totals_tiers()
    plot_active_map()
    plot_examples()
    print("done")


if __name__ == "__main__":
    main()
