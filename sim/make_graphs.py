"""Generate the v3 explainer graphs (G1-G6) into sim/graphs/*.png.

    python3 sim/make_graphs.py

Pure stdlib; rendering in sim/plot.py, data from the sim engine (run.py)
with final v3 constants (combiner_v3.py). Every PNG is parsed back
(signature + IHDR) after writing. G5 also prints lifespan numbers.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import run
from combiner_v3 import TIER_STEP, discount_target, pct_of_vault_bps
from plot import (BLUE, GREEN, INK, LGRAY, RED, GRAY, Canvas, Plot,
                  check_png, save_png)
from scenarios import Scenario, build_scenarios, _g

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "graphs")
os.makedirs(OUT, exist_ok=True)

SC = build_scenarios()
BY_NAME = {sc.name: sc for sc in SC}


def done(name, path):
    w, h = check_png(path)
    print(f"  wrote {name} ({w}x{h}, IHDR ok)")


def legend(c, items, x, y):
    for label, color in items:
        c.line(x, y + 2, x + 14, y + 2, color)
        c.text(x + 18, y, label, INK)
        y += 10


# --- G1: totals curves ---------------------------------------------------------
def g1():
    c = Canvas(900, 600)
    p = Plot(c, 70, 40, 860, 520, xr=(0, 10_000), yr=(0, 5.5))
    p.band(6_750, 7_500, LGRAY)
    xs = list(range(0, 10_001, 50))
    p.frame(xticks=[(0, "0"), (2500, "2500"), (5000, "5000"), (7500, "7500"), (10000, "10000")],
            yticks=[(0, "0"), (1, "1%"), (2, "2%"), (3, "3%"), (4, "4%"), (5, "5%")],
            xlabel="MOMENTUM", ylabel="% VAULT OFFERED / DAY")
    p.vline(4_500, GRAY)
    p.text(p.X(4520), p.Y(5.35), "4500 IGNITION START", INK)
    p.text(p.X(6810), p.Y(5.35), "6750-7500 PLATEAU", INK)
    for shape, color, lab in (("flat", RED, "FLAT 5%"),
                              ("ramp", GREEN, "MONOTONE RAMP"),
                              ("bump", BLUE, "BUMP-TAPER (V3)")):
        p.series(xs, [pct_of_vault_bps(x, shape) / 100 for x in xs], color)
    legend(c, [("BUMP-TAPER (V3)", BLUE), ("MONOTONE RAMP", GREEN), ("FLAT 5%", RED)], 90, 60)
    path = os.path.join(OUT, "totals-curves.png")
    save_png(c, path)
    done("G1 totals-curves.png", path)


# --- G2: discount curve ----------------------------------------------------------
def g2():
    c = Canvas(900, 600)
    p = Plot(c, 70, 40, 860, 520, xr=(0, 10_000), yr=(0, 1750))
    p.band(4_500, 7_000, LGRAY)
    xs = list(range(0, 10_001, 50))
    p.frame(xticks=[(0, "0"), (2500, "2500"), (5000, "5000"), (7500, "7500"), (10000, "10000")],
            yticks=[(0, "0"), (500, "500"), (1000, "1000"), (1500, "1500")],
            xlabel="MOMENTUM", ylabel="DISCOUNT BPS")
    p.text(p.X(5100), p.Y(1700), "IGNITION BAND 4500-7000", INK)
    p.series(xs, [discount_target(m, 0) for m in xs], INK)  # base bump, no tightening
    for t, color in (("sml", GREEN), ("med", BLUE), ("big", RED)):
        p.series(xs, [discount_target(m, 5_000) + TIER_STEP[t] for m in xs], color)
    legend(c, [("BASE BUMP (AGGR 0)", INK), ("SML @AGGR 5000", GREEN),
               ("MED @AGGR 5000", BLUE), ("BIG @AGGR 5000", RED)], 90, 60)
    path = os.path.join(OUT, "discount-curve.png")
    save_png(c, path)
    done("G2 discount-curve.png", path)


# --- G3: bull day by day -----------------------------------------------------------
def _panels(c, rects_xr_yr):
    return [Plot(c, *r[:4], xr=r[4], yr=r[5]) for r in rects_xr_yr]


def g3():
    rows = run.run_sim(BY_NAME["bull"], desk="v3")
    days = [r["day"] for r in rows]
    pct = [(r["sheet"]["pct_bps"] / 100) if r["sheet"] else None for r in rows]
    disc = [(r["sheet"]["tiers"].get("big", {}).get("discount_bps")) if r["sheet"] else None
            for r in rows]
    tier = [(r["sheet"]["tiers"].get("big", {}).get("lot_index")) if r["sheet"] else None
            for r in rows]
    mom = [r["momentum"] for r in rows]
    vault = [r["vault"] for r in rows]

    c = Canvas(900, 600)
    xt = [(1, "1"), (10, "10"), (20, "20"), (30, "30"), (40, "40")]
    p1 = Plot(c, 70, 30, 860, 185, xr=(1, 40), yr=(0, 10_000))
    p1.frame(xticks=xt, yticks=[(0, "0"), (5000, "5000"), (10000, "10000")],
             ylabel="MOMENTUM")
    p1.series(days, mom, BLUE)

    p2 = Plot(c, 70, 225, 860, 380, xr=(1, 40), yr=(0, 5.5))
    p2.frame(xticks=xt, yticks=[(0, "0"), (2.5, "2.5%"), (5, "5%")],
             ylabel="TOTALS % VAULT (G) + BIG DISC BPS (R)")
    p2.series(days, pct, GREEN)
    # big discount on the same panel, rescaled to 0-5.5 via 1600 bps ~ 5.5
    p2.series(days, [(d / 1600 * 5.5) if d is not None else None for d in disc], RED)
    p2.text(p2.X(31), p2.Y(1.2), "RED: DISC, 5.5 = 1600 BPS", INK)

    p3 = Plot(c, 70, 420, 860, 560, xr=(1, 40), yr=(0, 12))
    p3.frame(xticks=xt, yticks=[(0, "0"), (6, "6"), (12, "12")], xlabel="TRADING DAY",
             ylabel="BIG LOT TIER (B) + VAULT (R)")
    p3.series(days, tier, BLUE)
    p3.series(days, [v / 400_000 * 12 for v in vault], RED)
    p3.text(p3.X(24), p3.Y(11), "RED: VAULT, 12 = 400K", INK)
    path = os.path.join(OUT, "bull-day-by-day.png")
    save_png(c, path)
    done("G3 bull-day-by-day.png", path)


# --- G4: wash pump ------------------------------------------------------------------
def g4():
    rows = run.run_sim(BY_NAME["wash-pump"], desk="v3")
    days = [r["day"] for r in rows]
    ret = [r["ret_cp"] / 100 for r in rows]
    mom = [r["momentum"] for r in rows]
    pct = [(r["sheet"]["pct_bps"] / 100) if r["sheet"] else None for r in rows]

    c = Canvas(900, 600)
    xt = [(1, "1"), (10, "10"), (20, "20"), (30, "30"), (40, "40")]
    p1 = Plot(c, 70, 40, 860, 270, xr=(1, 40), yr=(-50, 50))
    p1.frame(xticks=xt, yticks=[(-40, "-40%"), (0, "0"), (40, "+40%")],
             ylabel="RET% BARS + MOMENTUM (R)")
    p1.bars(days, ret, GRAY, base=0.0)
    p1.series(days, [(m - 5000) / 100 for m in mom], RED)  # mom-5000 in % units
    p1.text(p1.X(2), p1.Y(46), "RED: (MOMENTUM-5000)/100", INK)
    p1.hline(0, INK)

    p2 = Plot(c, 70, 330, 860, 560, xr=(1, 40), yr=(0, 5.5))
    p2.frame(xticks=xt, yticks=[(0, "0"), (2.5, "2.5%"), (5, "5%")], xlabel="TRADING DAY",
             ylabel="TOTALS % VAULT OFFERED")
    p2.hline(4.75, LGRAY)
    p2.text(p2.X(2), p2.Y(5.3), "+40% DAY 20: BUMP ~2 DAYS, NOT PINNED", INK)
    p2.series(days, pct, GREEN)
    path = os.path.join(OUT, "wash-pump.png")
    save_png(c, path)
    done("G4 wash-pump.png", path)


# --- G5: lifespan (500 days) ---------------------------------------------------------
def g5():
    def cycle_ret(d, rng):
        up = (d - 1) % 30 < 20
        return (200.0 if up else -200.0) + rng.gauss(0.0, 30.0)

    specs = [("bull +2%/day", Scenario("bull", _g(200.0, 30.0)), BLUE),
             ("chop 0+-1.5%", Scenario("chop", _g(0.0, 150.0)), GREEN),
             ("cycle +2%x20/-2%x10", Scenario("cycle", cycle_ret), RED)]
    results = {}
    print("G5 lifespan numbers (500 trading days, v3 desk, buyback loop ON):")
    for name, sc, _ in specs:
        rows = run.run_sim(sc, desk="v3", days=500)
        results[name] = rows
        dead = next((r["day"] for r in rows if r["vault"] < 0.10 * run.START_VAULT), None)
        span = f">{len(rows)}" if dead is None else str(dead)
        years = ">1.98" if dead is None else f"{dead / 252:.2f}"
        print(f"  {name:<22} vault<10% at day {span:>4} ({years:>5} years)  "
              f"vault@500 {rows[-1]['vault']:>12,.0f}  "
              f"tokens dist {sum(r['tokens_sold'] for r in rows):>12,.0f}  "
              f"buyback {sum(r['buyback_notional'] for r in rows):>14,.0f}")
        results[name] = (rows, dead)

    c = Canvas(900, 600)
    p = Plot(c, 70, 40, 860, 520, xr=(1, 500), yr=(2, 6))  # log10 vault
    p.frame(xticks=[(1, "1"), (100, "100"), (200, "200"), (300, "300"), (400, "400"), (500, "500")],
            yticks=[(2, "100"), (3, "1K"), (4, "10K"), (5, "100K"), (6, "1M")],
            xlabel="TRADING DAY", ylabel="VAULT TOKENS (LOG)")
    p.hline(math.log10(40_000), GRAY)
    p.text(p.X(5), p.Y(math.log10(40_000) - 0.12), "10% OF INITIAL (40K)", INK)
    for name, _, color in specs:
        rows, _ = results[name]
        p.series([r["day"] for r in rows],
                 [math.log10(max(r["vault"], 100.0)) for r in rows], color)
    legend(c, [(n, col) for n, _, col in specs], 90, 60)
    path = os.path.join(OUT, "lifespan.png")
    save_png(c, path)
    done("G5 lifespan.png", path)


# --- G6: floor lockout -----------------------------------------------------------------
def g6():
    rows = run.run_sim(BY_NAME["crash"], desk="v3")
    days = [r["day"] for r in rows]
    price = [r["price"] for r in rows]
    floor = [r["floor_price"] for r in rows]
    disc = [(r["sheet"]["tiers"].get("big", {}).get("discount_bps")) if r["sheet"] else None
            for r in rows]
    target = [discount_target(r["momentum"], r["aggression"]) + TIER_STEP["big"] for r in rows]
    cap = [r["cap_bps"] for r in rows]

    c = Canvas(900, 600)
    xt = [(1, "1"), (10, "10"), (20, "20"), (30, "30"), (40, "40")]
    p1 = Plot(c, 70, 40, 860, 270, xr=(1, 40), yr=(0.5, 1.1))
    p1.frame(xticks=xt, yticks=[(0.5, "0.5"), (0.75, "0.75"), (1.0, "1.0")],
             ylabel="PRICE (B) VS FLOOR (R)")
    p1.series(days, price, BLUE)
    p1.series(days, floor, RED)

    p2 = Plot(c, 70, 330, 860, 560, xr=(1, 40), yr=(-600, 1700))
    p2.frame(xticks=xt, yticks=[(0, "0"), (800, "800"), (1600, "1600")],
             xlabel="TRADING DAY", ylabel="BIG DISC: REALIZED (B) / TARGET (G) / CAP (R)")
    p2.series(days, target, GREEN)
    p2.series(days, cap, RED)
    p2.series(days, disc, BLUE)  # None gaps = unlisted
    p2.hline(200, LGRAY)
    p2.text(p2.X(2), p2.Y(340), "200 BPS MIN-LIST LINE; GAPS = TIER UNLISTED", INK)
    path = os.path.join(OUT, "floor-lockout.png")
    save_png(c, path)
    done("G6 floor-lockout.png", path)


def main():
    print("generating graphs ->", OUT)
    g1()
    g2()
    g3()
    g4()
    g5()
    g6()
    print("all graphs verified (signature + IHDR parse)")


if __name__ == "__main__":
    main()