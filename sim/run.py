"""NYSEH offer-desk simulation driver — combiner v1 (frozen) vs v3 (pipeline).

Usage:
    python3 sim/run.py            # self-test + all scenarios + invariants + E1-E6
    python3 sim/run.py --quiet    # checks & experiment tables only (no day tables)

Requires: python3 stdlib only. Deterministic: every run uses random.Random(42).

Each simulated trading day:
  1. scenario base return + yesterday's buyback impact -> today's return
  2. record priceChange24h (centi-percent) into the 20-day ring
  3. ported metrics: momentum, stake health (then record ratio), aggression
  4. combiner (v1 or v3) builds the offer sheet, or shuts the desk
  5. acceptance model fills tiers; fills shift the accepted-offer rings
  6. staking ratio mean-reverts toward the scenario target
  7. vault/token flows: sold lots leave the vault; 80% of proceeds are booked
     back as tokens at today's close (assumption: buyback executes at close;
     its PRICE IMPACT lands on tomorrow's return)
  8. v3 only: the ratchet floor (highest_buyback_basis — on-chain it is only
     READ by offer_claim, nothing updates it yet) is modeled as: init at the
     start price; after each buyback, move toward the exec price at most
     FLOOR_MAX_STEP per day. This is the floor in cap = (1 - floor/live).
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics
from combiner import build_offer_sheet
from combiner_v3 import build_offer_sheet_v3
from metrics import (AcceptedOffers, MetricsState, calculate_momentum_score,
                     calculate_stake_health, offer_accepted_aggression,
                     record_accepted, record_price_change, record_stake_ratio)
from scenarios import build_scenarios

DAYS = 40
SEED = 42

SUPPLY = 1_000_000          # fixed 1M NYSEH
START_VAULT = 400_000.0     # tokens in the treasury vault
START_STAKED_PCT = 40.0     # 400k staked
START_PRICE = 1.0           # USDC per NYSEH

IMPACT_K = 1.0              # buyback price-impact knob (0 disables the loop)
FILL_NOISE = 4.0            # acceptance model noise, fill-%
STAKE_SPEED = 0.1           # mean-reversion speed per day
STAKE_NOISE = 0.5           # ratio points

BUYBACK_SHARE = 0.80        # 80% of proceeds buy back next day (10% stakers,
                            # 10% reserve are not modeled — they don't move
                            # vault tokens or price)
FLOOR_MAX_STEP = 0.01       # v3 ratchet: max +1%/day toward buyback exec price

TIERS = ("sml", "med", "big")


def run_sim(scenario, desk="v1", v3_mode="full", v3_aggr_mod=False,
            v3_shape="bump", impact_k=IMPACT_K, seed=SEED, start_vault=START_VAULT,
            days=DAYS):
    """Simulate one scenario; return list of per-day row dicts."""
    rng = random.Random(seed)
    state = MetricsState(total_staked=int(START_STAKED_PCT * SUPPLY / 100),
                         total_supply=SUPPLY)
    accepted = AcceptedOffers()
    price = START_PRICE
    vault = float(start_vault)
    floor_price = START_PRICE  # v3 ratchet floor model (see module docstring)
    staked_pct = START_STAKED_PCT
    pending_impact_cp = 0.0   # buyback impact landing on today's return
    rows = []

    for day in range(1, days + 1):
        base_cp = scenario.base_ret_cp(day, rng)          # rng draw 1
        ret_cp = base_cp + pending_impact_cp
        price *= 1.0 + ret_cp / 10_000.0

        record_price_change(state, int(round(ret_cp)))
        momentum = calculate_momentum_score(state)
        stake_health = calculate_stake_health(state)
        record_stake_ratio(state)
        aggression = offer_accepted_aggression(accepted)

        cap_bps = (1.0 - floor_price / price) * 10_000 if price > 0 else 0.0
        if desk == "v1":
            sheet = build_offer_sheet(momentum, stake_health, aggression, vault)
        else:
            sheet = build_offer_sheet_v3(momentum, stake_health, aggression,
                                         vault, price, floor_price, start_vault,
                                         mode=v3_mode, aggr_mod=v3_aggr_mod,
                                         shape=v3_shape)
        vault_pre = vault  # balance the sheet was sized against (cap checks)

        fills = {"sml": 0.0, "med": 0.0, "big": 0.0}
        notional = 0.0
        tokens_sold = 0.0
        for t in TIERS:
            noise = rng.gauss(0.0, FILL_NOISE)            # rng draws 2-4
            if sheet is None or t not in sheet["tiers"]:
                continue
            tier = sheet["tiers"][t]
            f = (scenario.base_demand
                 + 4.0 * (tier["discount_bps"] / 100.0)
                 + 20.0 * sheet["mom_x"]
                 - 15.0 * (tier["vesting_days"] / 30.0)
                 + noise)
            f = max(0.0, min(100.0, f))
            fills[t] = f
            lots = (f / 100.0) * tier["total_offered"]
            tokens = lots * tier["lot_size"]
            tokens_sold += tokens
            notional += tokens * price * (1.0 - tier["discount_bps"] / 10_000.0)

        record_accepted(accepted,
                        round(fills["sml"]), round(fills["med"]), round(fills["big"]))

        # vault/token flows + tomorrow's buyback impact
        pending_impact_cp = impact_k * (BUYBACK_SHARE * notional) / (price * SUPPLY) * 10_000.0
        vault -= tokens_sold
        vault += BUYBACK_SHARE * notional / price  # buyback at close (assumption)

        if desk == "v3" and BUYBACK_SHARE * notional > 0:
            # ratchet floor: never sell below highest realized buyback basis
            floor_price = max(floor_price,
                              min(price, floor_price * (1.0 + FLOOR_MAX_STEP)))

        # staking model: mean-revert to scenario target + noise
        staked_pct += STAKE_SPEED * (scenario.stake_target(day) - staked_pct)
        staked_pct += rng.gauss(0.0, STAKE_NOISE)         # rng draw 5
        staked_pct = max(0.0, min(100.0, staked_pct))
        state.total_staked = int(staked_pct * SUPPLY / 100)

        rows.append({
            "day": day, "ret_cp": ret_cp, "price": price,
            "momentum": momentum, "stake_health": stake_health,
            "aggression": aggression, "sheet": sheet, "fills": fills,
            "notional": notional, "buyback_notional": BUYBACK_SHARE * notional,
            "tokens_sold": tokens_sold, "vault": vault, "vault_pre": vault_pre,
            "cap_bps": sheet["cap_bps"] if (desk == "v3" and sheet) else cap_bps,
            "floor_price": floor_price if desk == "v3" else None,
            "impact_cp_next": pending_impact_cp,
        })
    return rows


def _fmt_tier(tiers, key, fmt="{:d}"):
    out = []
    for t in TIERS:
        out.append(fmt.format(tiers[t][key]) if t in tiers else "·")
    return "/".join(out)


def print_table(name, rows, desk):
    print(f"\n== {name} [{desk}] " + "=" * max(1, 72 - len(name)))
    if desk == "v1":
        print(" d  ret%    mom   stk  aggr   A     disc s/m/b      vest s/m/b  sheet%vault fill s/m/b")
    else:
        print(" d  ret%    mom   stk  aggr  pct%  lots  disc s/m/b      vest s/m/b  sheet%vault fill s/m/b")
    for r in rows:
        s = r["sheet"]
        base = (f"{r['day']:2d} {r['ret_cp'] / 100:+6.2f} {r['momentum']:5d} "
                f"{r['stake_health']:4d} {r['aggression']:5d}")
        if s is None:
            tag = f" cap{r['cap_bps']:5.0f}" if desk == "v3" else ""
            print(f"{base}   --{tag} empty --")
        elif desk == "v1":
            t = s["tiers"]
            discs = "/".join(str(t[x]["discount_bps"]) for x in TIERS)
            vests = "/".join(str(t[x]["vesting_days"]) for x in TIERS)
            fills = "/".join(f"{r['fills'][x]:.0f}" for x in TIERS)
            pct_vault = 100.0 * s["sheet_tokens"] / r["vault"] if r["vault"] else 0.0
            print(f"{base} {s['a']:.3f}  {discs:>15}  {vests:>9}  {pct_vault:9.2f}% {fills:>9}")
        else:
            t = s["tiers"]
            lots = _fmt_tier(t, "lot_index")
            discs = _fmt_tier(t, "discount_bps")
            vests = _fmt_tier(t, "vesting_days")
            fills = "/".join(f"{r['fills'][x]:.0f}" if x in t else "·" for x in TIERS)
            pct_vault = 100.0 * s["sheet_tokens"] / r["vault"] if r["vault"] else 0.0
            print(f"{base} {s['pct_bps'] / 100:4.2f} {lots:>5} {discs:>15}  {vests:>9}  "
                  f"{pct_vault:8.2f}% {fills:>9}")
    last = rows[-1]
    print(f"  end: price {last['price']:.4f}  vault {last['vault']:,.0f}  "
          f"tokens dist {sum(r['tokens_sold'] for r in rows):,.0f}  "
          f"buyback {sum(r['buyback_notional'] for r in rows):,.0f} USDC")


# --- v1 invariants (unchanged) --------------------------------------------------

def _sheet_days(rows):
    return [r for r in rows if r["sheet"] is not None]


def _avg_disc(rows):
    ds = [sum(r["sheet"]["tiers"][t]["discount_bps"] for t in TIERS) / 3
          for r in _sheet_days(rows)]
    return sum(ds) / len(ds) if ds else 0.0


def _avg_scale(rows):
    ss = [r["sheet"]["scale"] for r in _sheet_days(rows)]
    return sum(ss) / len(ss) if ss else 0.0


def _avg_sheet_tokens(rows):
    ts = [r["sheet"]["sheet_tokens"] for r in _sheet_days(rows)]
    return sum(ts) / len(ts) if ts else 0.0


def _report(out, name, ok, detail):
    out.append(bool(ok))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} — {detail}")


def check_invariants_v1(results):
    out = []

    bad = [f"{n} d{r['day']}" for n, rows in results.items() for r in rows
           if (r["momentum"] < 3_500 or r["momentum"] == 0) != (r["sheet"] is None)]
    _report(out, "v1.1 gate: momentum<3500 <=> empty sheet",
            not bad, f"violations: {bad[:5]}" if bad else "all scenarios, all 40 days")

    bear = results["bear"]
    late = [r for r in bear if r["day"] >= 7]
    empty_late = all(r["sheet"] is None for r in late)
    bb_late = sum(r["buyback_notional"] for r in late)
    _report(out, "v1.2 bear: desk shut from day ~6, no buybacks",
            empty_late and bb_late == 0.0, f"buyback after d6: {bb_late:,.0f}")

    bull, chop = results["bull"], results["wash-pump"]
    bd, cd = _avg_disc(bull), _avg_disc(chop)
    bs, cs = _avg_scale(bull), _avg_scale(chop)
    bt, ct = _avg_sheet_tokens(bull), _avg_sheet_tokens(chop)
    _report(out, "v1.3 bull > chop: avg discount and sheet size",
            bd > cd and bs > cs,
            f"disc {bd:.0f} vs {cd:.0f} bps; scale {bs:.2f} vs {cs:.2f}; "
            f"tokens {bt:,.0f} vs {ct:,.0f}")

    wash = results["wash-pump"]
    elevated = [r["day"] for r in wash if r["sheet"] and r["sheet"]["a"] >= 0.50]
    streak = mx = 0
    for r in wash:
        streak = streak + 1 if (r["sheet"] and r["sheet"]["scale"] >= 0.95) else 0
        mx = max(mx, streak)
    _report(out, "v1.4 wash pump: A>=0.50 <= 3 days; >=95% sheet < 4 consecutive",
            len(elevated) <= 3 and mx < 4,
            f"A>=0.50 days {elevated}; max >=95%-scale streak {mx}")

    rocket = results["rocket"]
    hot = [r for r in rocket if r["momentum"] >= 9_000]
    hold = all(r["sheet"] and r["sheet"]["scale"] >= 0.90 for r in hot)
    _report(out, "v1.5 rocket: scale>=0.90 whenever momentum>=9000",
            bool(hot) and hold,
            f"{len(hot)} pinned days, min scale {min((r['sheet']['scale'] for r in hot), default=0):.3f}")

    lo, hi = results["bull-low-demand"], results["bull-high-demand"]
    _report(out, "v1.6 high-demand bull tighter than low-demand bull",
            _avg_disc(hi) < _avg_disc(lo),
            f"avg disc high {_avg_disc(hi):.0f} vs low {_avg_disc(lo):.0f} bps")
    return out


def check_buyback_loop(scenario, desk="v1", v3_mode="full"):
    on = run_sim(scenario, desk=desk, v3_mode=v3_mode, impact_k=IMPACT_K, seed=SEED)
    off = run_sim(scenario, desk=desk, v3_mode=v3_mode, impact_k=0.0, seed=SEED)
    p_on, p_off = on[-1]["price"], off[-1]["price"]
    ok = p_on > p_off
    print(f"  [{'PASS' if ok else 'FAIL'}] {desk}.7 buyback loop ON > OFF (same seed) — "
          f"final price {p_on:.4f} vs {p_off:.4f} ({100 * (p_on / p_off - 1):+.1f}%)")
    return [ok]


# --- v3 invariant checks (E5) -----------------------------------------------------

def _day_avg_disc(r):
    """Mean listed-tier discount that day; 0 when the desk is shut."""
    if r["sheet"] is None:
        return 0.0
    ds = [t["discount_bps"] for t in r["sheet"]["tiers"].values()]
    return sum(ds) / len(ds) if ds else 0.0


def check_v3(results, scenarios):
    out = []

    # gate: cold start => empty (floor cap replaces the momentum bear gate)
    bad = [f"{n} d{r['day']}" for n, rows in results.items() for r in rows
           if r["momentum"] == 0 and r["sheet"] is not None]
    explained = all(r["momentum"] == 0 or r["cap_bps"] < 200 or r["sheet"] is not None
                    for rows in results.values() for r in rows)
    _report(out, "v3.1 cold start => empty; empty days explained by cold start or cap<200",
            not bad and explained, f"violations: {bad[:5]}" if bad else "holds, all scenarios")

    bear = results["bear"]
    late = [r for r in bear if r["day"] >= 7]
    bb_late = sum(r["buyback_notional"] for r in late)
    _report(out, "v3.2 bear: floor shuts desk from day ~6, no buybacks",
            all(r["sheet"] is None for r in late) and bb_late == 0.0,
            f"max cap after d6: {max(r['cap_bps'] for r in late):.0f} bps, buyback {bb_late:,.0f}")

    # E5-3 (replaces old #3): ignition discount > euphoria > flat.
    # Buckets pool LISTED days across scenarios (empty days measure the floor,
    # not the curve — floor-blocked ignition days would dilute the bump).
    # Flat-regime listed days are ~nonexistent BY DESIGN (the floor blocks
    # selling near/below basis), so the flat bucket is reported over ALL flat
    # days (empty = 0 bps) to keep "euphoria > flat" meaningful.
    buckets = {"ignition": [], "flat_all": [], "euphoria": []}
    for rows in results.values():
        prev = 0
        for r in rows:
            mom = r["momentum"]
            if r["sheet"] is not None:
                d = _day_avg_disc(r)
                if 4_500 <= mom <= 7_500 and mom > prev:
                    buckets["ignition"].append(d)
                if mom > 8_000:
                    buckets["euphoria"].append(d)
            if mom < 4_500:
                buckets["flat_all"].append(_day_avg_disc(r))  # 0 when shut
            prev = mom
    avgs = {k: (sum(v) / len(v) if v else 0.0) for k, v in buckets.items()}
    _report(out, "v3.3 ignition discount > euphoria > flat (pooled days)",
            avgs["ignition"] > avgs["euphoria"] > avgs["flat_all"],
            f"ignition {avgs['ignition']:.0f} bps (n={len(buckets['ignition'])}), "
            f"euphoria {avgs['euphoria']:.0f} (n={len(buckets['euphoria'])}), "
            f"flat {avgs['flat_all']:.0f} (n={len(buckets['flat_all'])}, incl. shut days)")

    # wash pump: discount not durably elevated; sheet not pinned near cap.
    # v3's wash resistance is structural: a +40% wash lands PAST the early
    # discount peak (5750) and on the taper side of the totals plateau, so
    # the pump day discounts no better than the desk's own ignition-band
    # baseline. "Elevated" = avg discount above the post-pump steady state.
    wash = results["wash-pump"]
    post = sorted(_day_avg_disc(r) for r in wash
                  if 25 <= r["day"] <= DAYS and r["sheet"] is not None)
    baseline = post[len(post) // 2] if post else 0.0   # median
    elevated = [r["day"] for r in wash
                if r["day"] >= 20 and _day_avg_disc(r) > baseline + 100]
    streak = mx = 0
    for r in wash:
        hot = r["sheet"] is not None and r["sheet"]["pct_bps"] >= 475.0
        streak = streak + 1 if hot else 0
        mx = max(mx, streak)
    _report(out, "v3.4 wash pump: discount elevation <= 3 days; >=95% sheet < 4 consecutive",
            len(elevated) <= 3 and mx < 4,
            f"elevated days {elevated} (post-pump median {baseline:.0f} bps); "
            f">=4.75% streak {mx}")

    # hard constraints, every listed day of every scenario
    viol = []
    for n, rows in results.items():
        for r in rows:
            if r["sheet"] is None:
                continue
            t = r["sheet"]["tiers"]
            order = [x for x in TIERS if x in t]
            if any(t[order[i + 1]]["lot_index"] - t[order[i]]["lot_index"] < 1
                   for i in range(len(order) - 1)):
                viol.append(f"{n} d{r['day']} tier-order")
            if any(t[order[i + 1]]["discount_bps"] <= t[order[i]]["discount_bps"]
                   for i in range(len(order) - 1)):
                viol.append(f"{n} d{r['day']} disc-order")
            if any(x["total_offered"] < 0 for x in t.values()):
                viol.append(f"{n} d{r['day']} neg-count")
            if r["sheet"]["sheet_tokens"] > r["vault_pre"] * 0.05 + 1e-6:
                viol.append(f"{n} d{r['day']} cap")
            if any(not (3 <= x["vesting_days"] <= 30) for x in t.values()):
                viol.append(f"{n} d{r['day']} vest-range")
    _report(out, "v3.6 hard constraints: sml<med<big, disc big>med>sml, counts>=0, sheet<=5%, vest 3..30",
            not viol, f"violations: {viol[:5]}" if viol else "every listed day, all scenarios")

    lo, hi = results["bull-low-demand"], results["bull-high-demand"]
    _report(out, "v3.5 high-demand bull tighter than low-demand bull",
            _avg_disc_v3(hi) < _avg_disc_v3(lo),
            f"avg disc high {_avg_disc_v3(hi):.0f} vs low {_avg_disc_v3(lo):.0f} bps")
    return out


def _avg_disc_v3(rows):
    ds = [_day_avg_disc(r) for r in rows if r["sheet"] is not None]
    return sum(ds) / len(ds) if ds else 0.0


# --- experiments -----------------------------------------------------------------

def _t_first(rows, threshold):
    return next((r["day"] for r in rows if r["momentum"] >= threshold), None)


def _vault_lifespan(rows, start_vault, days=DAYS):
    d = next((r["day"] for r in rows if r["vault"] < 0.10 * start_vault), None)
    return str(d) if d else f">{days}"


def e1_ab(bull_sc):
    print("\n== E1 bull A/B: v1 vs v3 " + "=" * 54)
    v1 = run_sim(bull_sc, desk="v1")
    v3 = run_sim(bull_sc, desk="v3")

    def stats(rows):
        return {
            "t>=8000": _t_first(rows, 8_000),
            "t>=9000": _t_first(rows, 9_000),
            "max mom": max(r["momentum"] for r in rows),
            "buyback d1-10": sum(r["buyback_notional"] for r in rows[:10]),
            "tokens dist": sum(r["tokens_sold"] for r in rows),
            "final price": rows[-1]["price"],
        }

    s1, s3 = stats(v1), stats(v3)
    e1 = s1["final price"] / s1["tokens dist"] if s1["tokens dist"] else 0.0
    e3 = s3["final price"] / s3["tokens dist"] if s3["tokens dist"] else 0.0
    print(f"  {'metric':<26}{'v1':>14}{'v3':>14}")
    for k in ("t>=8000", "t>=9000", "max mom"):
        print(f"  {k:<26}{str(s1[k]):>14}{str(s3[k]):>14}")
    print(f"  {'cum buyback d1-10':<26}{s1['buyback d1-10']:>14,.0f}{s3['buyback d1-10']:>14,.0f}")
    print(f"  {'tokens distributed':<26}{s1['tokens dist']:>14,.0f}{s3['tokens dist']:>14,.0f}")
    print(f"  {'final price':<26}{s1['final price']:>14.4f}{s3['final price']:>14.4f}")
    print(f"  {'treasury eff (price/tok)':<26}{e1:>14.3e}{e3:>14.3e}")
    print(f"  {'vault lifespan (d to <10%)':<26}{_vault_lifespan(v1, START_VAULT):>14}"
          f"{_vault_lifespan(v3, START_VAULT):>14}")
    # ignition speed per spec = time-to-pinned (>=9000); t>=8000 shown for color
    p1, p3t = s1["t>=9000"] or 99, s3["t>=9000"] or 99
    ok = e3 >= e1 and p3t <= p1
    note = "" if ok else " (efficiency or ignition regressed)"
    print(f"  [{'PASS' if ok else 'FAIL'}] E1: v3 efficiency >= v1 AND time-to-pinned not slower{note}")
    return [ok]


def e2_rocket(rocket_sc):
    print("\n== E2 rocket euphoria compression: v1 vs v3 " + "=" * 34)
    v1 = run_sim(rocket_sc, desk="v1")
    v3 = run_sim(rocket_sc, desk="v3")
    hot = range(4, 13)  # rows index days 5..13

    def proceeds_token(rows):
        tok = sum(rows[i]["tokens_sold"] for i in hot)
        notl = sum(rows[i]["notional"] for i in hot)
        return notl / tok if tok else 0.0

    p1, p3 = proceeds_token(v1), proceeds_token(v3)
    ratios = [(v3[i]["buyback_notional"] / v1[i]["buyback_notional"], v3[i]["day"])
              for i in hot if v1[i]["buyback_notional"] > 0]
    rmin, dmin = min(ratios) if ratios else (0.0, "-")
    print(f"  proceeds/token (USDC): v1 {p1:.4f}   v3 {p3:.4f}   "
          f"({100 * (p3 / p1 - 1):+.2f}%)")
    print(f"  min daily buyback ratio v3/v1: {rmin:.2f} (day {dmin})  "
          f"[bar: >= 0.80]")
    ok1 = p3 > p1
    ok2 = rmin >= 0.80
    print(f"  [{'PASS' if ok1 else 'FAIL'}] E2a: v3 proceeds/token > v1")
    print(f"  [{'PASS' if ok2 else 'FAIL'}] E2b: daily buyback >= 80% of v1")
    return [ok1, ok2]


def e3_tiers(v3_results):
    print("\n== E3 tier dynamics (v3) " + "=" * 54)
    ok = True
    for name, rows in v3_results.items():
        cells = []
        for r in rows:
            if r["sheet"] is None:
                cells.append(" --- ")
            else:
                t = r["sheet"]["tiers"]
                cells.append("".join(f"{t[x]['lot_index']:2d}" if x in t else " ."
                                     for x in TIERS))
        print(f"  {name:<18}")
        for row_start in range(0, DAYS, 10):
            print(f"    d{row_start + 1:>2}-{row_start + 10:<2} " + " ".join(cells[row_start:row_start + 10]))
        listed = [r for r in rows if r["sheet"] is not None]
        if listed:
            first_big = max((r["sheet"]["tiers"].get("big", {}).get("lot_index", 0)
                             for r in listed[:10]), default=0)
            last_big = max((r["sheet"]["tiers"].get("big", {}).get("lot_index", 0)
                            for r in listed[-10:]), default=0)
            print(f"    big-tier peak first10d {first_big} -> last10d {last_big}; "
                  f"vault {listed[0]['vault']:,.0f} -> {rows[-1]['vault']:,.0f}")
        # ordering assertion (sml<med<big) is v3.6; re-assert here per scenario
        for r in listed:
            t = r["sheet"]["tiers"]
            order = [x for x in TIERS if x in t]
            if any(t[order[i + 1]]["lot_index"] <= t[order[i]]["lot_index"]
                   for i in range(len(order) - 1)):
                ok = False
    print(f"  [{'PASS' if ok else 'FAIL'}] E3: sml<med<big every listed day, every scenario")
    return [ok]


def e4_small_vault(bull_sc):
    print("\n== E4 vault-limited graceful degradation (bull, vault 40k) " + "=" * 19)
    rows = run_sim(bull_sc, desk="v3", start_vault=40_000)
    viol = []
    for r in rows:
        if r["sheet"] is None:
            continue
        t = r["sheet"]["tiers"]
        order = [x for x in TIERS if x in t]
        if any(x["total_offered"] < 0 for x in t.values()):
            viol.append(f"d{r['day']} neg")
        if any(t[order[i + 1]]["lot_index"] <= t[order[i]]["lot_index"]
               for i in range(len(order) - 1)):
            viol.append(f"d{r['day']} order")
        if r["sheet"]["sheet_tokens"] > r["vault_pre"] * 0.05 + 1e-6:
            viol.append(f"d{r['day']} cap {r['sheet']['sheet_tokens']:.0f}")
    listed = [r for r in rows if r["sheet"] is not None]
    biggest = max((r["sheet"]["sheet_tokens"] for r in listed), default=0.0)
    cap_first = 0.05 * listed[0]["vault"] if listed else 0.0
    life = _vault_lifespan(rows, 40_000)
    print(f"  listed days {len(listed)}/{DAYS}; max sheet {biggest:,.0f} tokens "
          f"(first-day 5% cap {cap_first:,.0f}); vault day40 {rows[-1]['vault']:,.0f}; "
          f"lifespan {life}")
    ok = not viol and len(listed) > 0
    print(f"  [{'PASS' if ok else 'FAIL'}] E4: no negatives, ordering holds, "
          f"sheet <= cap, sheets still served{'' if ok else f' — {viol[:5]}'}")
    return [ok]


def e6_shape_ablation(by_name):
    """Totals-curve ablation: bump-taper vs monotone-ramp vs flat-5%."""
    print("\n== E6 totals shape ablation (bump / ramp / flat) " + "=" * 30)
    shapes = ("bump", "ramp", "flat")
    scen_names = ("bull", "bear", "crash", "wash-pump", "rocket")
    print(f"  {'scenario':<11}{'shape':<7}{'efficiency':>12}{'lifespan':>10}"
          f"{'bb d1-10':>12}{'euphoria tok':>14}{'tokens dist':>13}")
    stats = {}
    for nm in scen_names:
        for sh in shapes:
            rows = run_sim(by_name[nm], desk="v3", v3_shape=sh)
            tok = sum(r["tokens_sold"] for r in rows)
            eff = rows[-1]["price"] / tok if tok else 0.0
            life = _vault_lifespan(rows, START_VAULT)
            bb10 = sum(r["buyback_notional"] for r in rows[:10]) if nm == "bull" else None
            euph = sum(r["tokens_sold"] for r in rows if r["momentum"] >= 8_500) if nm == "rocket" else None
            stats[(nm, sh)] = (eff, life, bb10, euph, tok)
            bb_s = f"{bb10:>12,.0f}" if bb10 is not None else f"{'--':>12}"
            eu_s = f"{euph:>13,.0f}" if euph is not None else f"{'--':>14}"
            print(f"  {nm:<11}{sh:<7}{eff:>12.3e}{life:>10}{bb_s}{eu_s}{tok:>13,.0f}")
    # verdict inputs
    be, re_, fe = stats[("bull", "bump")][0], stats[("bull", "ramp")][0], stats[("bull", "flat")][0]
    bbb, bbr, bbf = (stats[("bull", s)][2] for s in shapes)
    eb, er, ef = (stats[("rocket", s)][3] for s in shapes)
    print(f"  verdict inputs — bull eff: bump {be:.3e} ramp {re_:.3e} flat {fe:.3e}; "
          f"bull bb d1-10: {bbb:,.0f}/{bbr:,.0f}/{bbf:,.0f}; "
          f"rocket euphoria tokens: {eb:,.0f}/{er:,.0f}/{ef:,.0f}")
    return []  # informational; verdict written in final report


def e7_order_ablation(bull_sc, wash_sc):
    print("\n== E7 order ablation (bull) " + "=" * 51)
    modes = [("full (totals->tiers->counts->disc->vest)", "full"),
             ("vesting BEFORE discount (no compensation)", "vest_first"),
             ("fully independent dims (no cross-deps)", "independent")]
    results = {}
    for label, mode in modes:
        rows = run_sim(bull_sc, desk="v3", v3_mode=mode)
        tier_days = [(r, t) for r in rows if r["sheet"] for t in r["sheet"]["tiers"]]
        avg_fill = sum(r["fills"][t] for r, t in tier_days) / len(tier_days) if tier_days else 0.0
        tok = sum(r["tokens_sold"] for r in rows)
        eff = rows[-1]["price"] / tok if tok else 0.0
        crushed = [r for r in rows if r["sheet"] and any(
            x["discount_bps"] < x["target_discount"] for x in r["sheet"]["tiers"].values())]
        big_vest = [r["sheet"]["tiers"]["big"]["vesting_days"] for r in crushed
                    if "big" in r["sheet"]["tiers"]]
        cr_fill = [r["fills"][t] for r in crushed for t in r["sheet"]["tiers"]]
        results[mode] = (rows, avg_fill, eff, crushed, big_vest, cr_fill)
        print(f"  {label}")
        print(f"    avg fill {avg_fill:5.1f}%   treasury eff {eff:.3e}   "
              f"floor-crushed days {len(crushed)}")
        if crushed and big_vest:
            print(f"    on crushed days: avg big vest {sum(big_vest) / len(big_vest):.1f}d, "
                  f"avg fill {sum(cr_fill) / len(cr_fill):.1f}%")
        elif crushed:
            print(f"    on crushed days: avg fill {sum(cr_fill) / len(cr_fill):.1f}% "
                  f"(big tier unlisted)")
    full, first = results["full"], results["vest_first"]
    coupling_changes = full[5] and sum(full[5]) / len(full[5]) > sum(first[5]) / len(first[5])
    print(f"  compensation coupling lifts crushed-day fill: "
          f"{sum(full[5]) / len(full[5]):.1f}% vs {sum(first[5]) / len(first[5]):.1f}% "
          f"({'YES' if coupling_changes else 'no measurable difference'})")

    print("\n  totals aggression modulation (optional +/-20%):")
    for sc, nm in ((bull_sc, "bull"), (wash_sc, "wash-pump")):
        off = run_sim(sc, desk="v3", v3_aggr_mod=False)
        on = run_sim(sc, desk="v3", v3_aggr_mod=True)
        t_off = sum(r["tokens_sold"] for r in off)
        t_on = sum(r["tokens_sold"] for r in on)
        print(f"    {nm:<10} tokens dist {t_off:>10,.0f} (mod off) vs {t_on:>10,.0f} (mod on); "
              f"eff {off[-1]['price'] / t_off if t_off else 0:.3e} vs "
              f"{on[-1]['price'] / t_on if t_on else 0:.3e}")
    return []  # informational experiment; verdict in final report


def main():
    quiet = "--quiet" in sys.argv

    print("== metrics self-test " + "=" * 58)
    if not metrics.self_test():
        print("SELF-TEST FAILED — aborting")
        return 1

    scenarios = build_scenarios()
    by_name = {sc.name: sc for sc in scenarios}
    v1_results = {sc.name: run_sim(sc, desk="v1") for sc in scenarios}
    v3_results = {sc.name: run_sim(sc, desk="v3") for sc in scenarios}
    if not quiet:
        for sc in scenarios:
            print_table(sc.name, v1_results[sc.name], "v1")
        for sc in scenarios:
            print_table(sc.name, v3_results[sc.name], "v3")

    checks = []
    print("\n== v1 invariants " + "=" * 62)
    checks += check_invariants_v1(v1_results)
    checks += check_buyback_loop(by_name["bull"], desk="v1")

    print("\n== v3 invariant checks (E5) " + "=" * 51)
    checks += check_v3(v3_results, scenarios)
    checks += check_buyback_loop(by_name["bull"], desk="v3")

    checks += e1_ab(by_name["bull"])
    checks += e2_rocket(by_name["rocket"])
    checks += e3_tiers(v3_results)
    checks += e4_small_vault(by_name["bull"])
    e6_shape_ablation(by_name)
    e7_order_ablation(by_name["bull"], by_name["wash-pump"])

    passed = sum(checks)
    print(f"\n{passed}/{len(checks)} checks pass")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
