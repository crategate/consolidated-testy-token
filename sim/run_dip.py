"""Buy-the-dip modeling driver — WHEN does it trigger and FOR HOW MUCH.

    python3 sim/run_dip.py            # self-test + scenario tables + sweep + checks
    python3 sim/run_dip.py --quiet    # checks & sweep summary only

Daily-granularity model on top of the v3 desk loop (same rng discipline as
run.py: identical draw order, so results are comparable). The dip buyer:

  - holds the dip reserve (USDC terms; the sol_dip leg is price-equivalent),
    funded with 10% of every desk sale (the on-chain 80/10/10 claim split),
    plus a pre-accumulated START_RESERVE so knife scenarios have powder;
  - evaluates ONE decision per day: pc24 = today's close-to-close return
    (proxy for the live 24h feed), ring = price_changes as of YESTERDAY's
    close (recorded end-of-day, exactly like on-chain);
  - spends dip_spend_bps() of the CURRENT reserve at today's close; the
    price impact lands on tomorrow's return via the same IMPACT_K loop as
    desk buybacks.

Answers the three design questions:
  WHEN    — trigger days per scenario (too hairy in chop? asleep in crashes?)
  HOW MUCH— spend per trigger and per day, reserve trajectory
  WORTH   — avg 5-day-forward price / entry price per buy, and knife
            preservation vs the no-trend ablation
"""

import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dip
from combiner_v3 import build_offer_sheet_v3
from metrics import (AcceptedOffers, MetricsState, calculate_momentum_score,
                     calculate_stake_health, offer_accepted_aggression,
                     record_accepted, record_price_change, record_stake_ratio)
from run import (DAYS, FILL_NOISE, FLOOR_MAX_STEP, IMPACT_K, SEED,
                 START_PRICE, START_STAKED_PCT, START_VAULT, STAKE_NOISE,
                 STAKE_SPEED, SUPPLY, TIERS)
from scenarios import Scenario, build_scenarios

START_RESERVE = 20_000.0   # pre-accumulated dip reserve (USDC terms)
DIP_SHARE = 0.10           # 10% of claim proceeds feed the reserve
BUYBACK_SHARE = 0.80       # desk buyback leg (impact only, as in run.py)
FWD_DAYS = 5               # value metric: forward price horizon


# --- dip-focused scenarios (kept local so run.py outputs are unchanged) ------

def dip_scenarios():
    def knife_ret(d, rng):
        # accelerating collapse off a flat top, then flat at the bottom
        seq = {-1: 0, 0: 0}
        steps = {1: -500, 2: -800, 3: -1200, 4: -1500, 5: -1500}
        return steps.get(d, 0.0) + rng.gauss(0.0, 20.0) if d <= 5 else rng.gauss(0.0, 15.0)

    def v_recovery_ret(d, rng):
        # one -10% flush out of a mild uptrend, then recovery
        if d == 8:
            return -1000.0 + rng.gauss(0.0, 20.0)
        return (150.0 if d > 8 else 100.0) + rng.gauss(0.0, 25.0)

    def double_dip_ret(d, rng):
        # crash, a week of nothing, second leg down, then flat
        if d in (1, 2):
            return -900.0 + rng.gauss(0.0, 25.0)
        if d in (10, 11):
            return -900.0 + rng.gauss(0.0, 25.0)
        return rng.gauss(0.0, 15.0)

    def bleed_ret(d, rng):
        # slow bleed that accelerates late — the grind into capitulation
        mu = -150.0 if d <= 20 else -450.0
        return mu + rng.gauss(0.0, 40.0)

    def cascade_ret(d, rng):
        # each dip deeper than the last — the powder-deployment test
        steps = {1: -300, 6: -600, 11: -1000, 16: -1500}
        return steps.get(d, 0.0) + rng.gauss(0.0, 20.0)

    return [
        Scenario("knife", knife_ret),
        Scenario("v-recovery", v_recovery_ret),
        Scenario("double-dip", double_dip_ret),
        Scenario("bleed", bleed_ret),
        Scenario("cascade", cascade_ret),
    ]


def run_dip_sim(scenario, cfg=None, impact_k=IMPACT_K, seed=SEED, days=DAYS,
                start_reserve=START_RESERVE):
    """v3 desk loop + dip buyer. Returns (rows, summary)."""
    cfg = cfg or {}
    rng = random.Random(seed)
    state = MetricsState(total_staked=int(START_STAKED_PCT * SUPPLY / 100),
                         total_supply=SUPPLY)
    accepted = AcceptedOffers()
    price = START_PRICE
    vault = float(START_VAULT)
    floor_price = START_PRICE
    staked_pct = START_STAKED_PCT
    pending_impact_cp = 0.0
    reserve = float(start_reserve)
    reserve_peak = reserve
    dip_tokens = 0.0
    spent_total = 0.0
    inflow_total = 0.0
    buys = []          # (day, entry_price, spend, slope_cp)
    prices = {}        # day -> close
    rows = []

    for day in range(1, days + 1):
        base_cp = scenario.base_ret_cp(day, rng)          # rng draw 1
        ret_cp = base_cp + pending_impact_cp
        price *= 1.0 + ret_cp / 10_000.0
        prices[day] = price

        # --- dip decision: live 24h change, ring as of yesterday's close ---
        slope = dip.trend_slope_cp(state.price_changes, state.sample_head)
        spend_bps = dip.dip_spend_bps(int(round(ret_cp)), state.price_changes,
                                      state.sample_head, **cfg)
        spend = reserve * spend_bps / 10_000.0
        if spend > 0:
            reserve -= spend
            spent_total += spend
            dip_tokens += spend / price
            buys.append((day, price, spend, slope))

        record_price_change(state, int(round(ret_cp)))
        momentum = calculate_momentum_score(state)
        stake_health = calculate_stake_health(state)
        record_stake_ratio(state)
        aggression = offer_accepted_aggression(accepted)

        sheet = build_offer_sheet_v3(momentum, stake_health, aggression,
                                     vault, price, floor_price, START_VAULT)

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
            tokens = (f / 100.0) * tier["total_offered"] * tier["lot_size"]
            tokens_sold += tokens
            notional += tokens * price * (1.0 - tier["discount_bps"] / 10_000.0)

        record_accepted(accepted,
                        round(fills["sml"]), round(fills["med"]), round(fills["big"]))

        inflow = DIP_SHARE * notional
        reserve += inflow
        inflow_total += inflow
        reserve_peak = max(reserve_peak, reserve)

        # both buyback legs move tomorrow's price through the same impact loop
        pending_impact_cp = impact_k * (BUYBACK_SHARE * notional + spend) \
            / (price * SUPPLY) * 10_000.0
        vault -= tokens_sold
        vault += BUYBACK_SHARE * notional / price
        if BUYBACK_SHARE * notional > 0:
            floor_price = max(floor_price,
                              min(price, floor_price * (1.0 + FLOOR_MAX_STEP)))

        staked_pct += STAKE_SPEED * (scenario.stake_target(day) - staked_pct)
        staked_pct += rng.gauss(0.0, STAKE_NOISE)         # rng draw 5
        staked_pct = max(0.0, min(100.0, staked_pct))
        state.total_staked = int(staked_pct * SUPPLY / 100)

        rows.append({
            "day": day, "ret_cp": ret_cp, "price": price, "slope_cp": slope,
            "spend_bps": spend_bps, "spend": spend, "reserve": reserve,
            "inflow": inflow, "notional": notional,
        })

    # value capture: mean forward price / entry over buys with a full horizon
    fwd = [prices.get(d + FWD_DAYS, prices[days]) / p
           for d, p, _, _ in buys if d + FWD_DAYS <= days]
    avg_fwd = sum(fwd) / len(fwd) if fwd else None
    knife_spend = sum(s for _, _, s, sl in buys if sl < -100)
    avg_entry = spent_total / dip_tokens if dip_tokens else None
    summary = {
        "triggers": len(buys), "spent": spent_total, "inflow": inflow_total,
        "reserve_end": reserve, "reserve_peak": reserve_peak,
        "tokens": dip_tokens, "avg_entry": avg_entry, "avg_fwd_ratio": avg_fwd,
        "knife_spend": knife_spend, "buys": buys,
    }
    return rows, summary


def print_dip_table(name, rows):
    print(f"\n== {name} [dip] " + "=" * max(1, 70 - len(name)))
    print(" d  ret%   slope  spendbps  spend$    reserve$  (trigger days only; "
          "… = quiet)")
    quiet = 0
    for r in rows:
        if r["spend"] <= 0:
            quiet += 1
            continue
        if quiet:
            print(f"    … {quiet} quiet days")
            quiet = 0
        print(f"{r['day']:2d} {r['ret_cp'] / 100:+6.2f} {r['slope_cp']:+6d} "
              f"{r['spend_bps']:7d} {r['spend']:9,.0f} {r['reserve']:10,.0f}")
    if quiet:
        print(f"    … {quiet} quiet days")


def _fmt_money(x):
    return f"{x:,.0f}"


def sweep(scenarios, configs):
    print("\n== knob sweep " + "=" * 64)
    hdr = (f"  {'config':<12}{'scenario':<12}{'trig':>4}{'spent':>9}"
           f"{'resvEnd':>9}{'knife$':>8}{'fwd/entry':>10}")
    print(hdr)
    results = {}
    for cfg_name, cfg in configs.items():
        for sc in scenarios:
            _, s = run_dip_sim(sc, cfg=cfg)
            results[(cfg_name, sc.name)] = s
            fwd = f"{s['avg_fwd_ratio']:.3f}" if s["avg_fwd_ratio"] else "--"
            print(f"  {cfg_name:<12}{sc.name:<12}{s['triggers']:>4}"
                  f"{_fmt_money(s['spent']):>9}{_fmt_money(s['reserve_end']):>9}"
                  f"{_fmt_money(s['knife_spend']):>8}{fwd:>10}")
        print()
    return results


def _report(out, name, ok, detail):
    out.append(bool(ok))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} — {detail}")


def main():
    quiet = "--quiet" in sys.argv
    print("== dip self-test " + "=" * 62)
    if not dip.self_test():
        print("SELF-TEST FAILED — aborting")
        return 1

    base = {sc.name: sc for sc in build_scenarios()}
    scen_names = ("bull", "bear", "crash", "wash-pump")
    scenarios = [base[n] for n in scen_names] + dip_scenarios()

    cand = {}  # recommended spec = dip.py defaults (excess + quadratic + trend)
    if not quiet:
        for sc in scenarios:
            rows, s = run_dip_sim(sc, cfg=cand)
            print_dip_table(sc.name, rows)
            fwd = (f"{s['avg_fwd_ratio']:.3f}" if s["avg_fwd_ratio"] else "--")
            print(f"  end: triggers {s['triggers']}, spent {_fmt_money(s['spent'])}"
                  f" of peak {_fmt_money(s['reserve_peak'])}, "
                  f"reserve {s['reserve_end']:,.0f}, fwd/entry {fwd}")

    configs = {
        "recommended": {},          # excess trigger + quadratic depth + trend mult
        "abs-linear": {"mode": "abs", "depth_power": 1},   # the naive original
        "excess-lin": {"depth_power": 1},                  # excess, linear depth
        "exq-flat": {"trend_floor_bps": 10_000, "trend_cap_bps": 10_000},
        "naive": {"mode": "abs", "depth_power": 1,
                  "trend_floor_bps": 10_000, "trend_cap_bps": 10_000},
        "hair-150": {"trigger_cp": 150},
        "deep-500": {"trigger_cp": 500, "full_depth_cp": 1_500},
        "base-50": {"base_bps": 5_000, "day_cap_bps": 6_000},
    }
    results = sweep(scenarios, configs)

    print("\n== dip checks (RECOMMENDED spec: excess trigger + quadratic depth "
          "+ trend) " + "=" * 22)
    checks = []
    R = lambda cfg, sc: results[(cfg, sc)]  # noqa: E731

    cr = R("recommended", "crash")
    day1_spend = sum(s for d, _, s, _ in cr["buys"] if d <= 2)
    _report(checks, "C1 crash: fires immediately, >=20% of peak spent in days 1-2",
            cr["triggers"] >= 1 and day1_spend >= 0.20 * cr["reserve_peak"],
            f"days {[d for d, _, _, _ in cr['buys']]}, spent {day1_spend:,.0f} "
            f"/ peak {cr['reserve_peak']:,.0f}")

    kn = R("recommended", "knife")
    kn_naive = R("naive", "knife")
    _report(checks, "C2 knife: trend throttle spends less and keeps >=50% of peak",
            kn["spent"] < kn_naive["spent"]
            and kn["reserve_end"] >= 0.5 * kn["reserve_peak"],
            f"spent {kn['spent']:,.0f} vs naive {kn_naive['spent']:,.0f}; "
            f"end {kn['reserve_end']:,.0f} / peak {kn['reserve_peak']:,.0f}")

    bu = R("recommended", "bull")
    _report(checks, "C3 bull: <=2 triggers, spend <=10% of inflow",
            bu["triggers"] <= 2 and bu["spent"] <= 0.10 * bu["inflow"],
            f"triggers {bu['triggers']}, spent {bu['spent']:,.0f} / inflow {bu['inflow']:,.0f}")

    v = R("recommended", "v-recovery")
    _report(checks, "C4 v-recovery: buys the flush, fwd/entry >= 1.05",
            v["triggers"] >= 1 and v["avg_fwd_ratio"] is not None
            and v["avg_fwd_ratio"] >= 1.05,
            f"triggers {v['triggers']}, fwd/entry "
            f"{v['avg_fwd_ratio'] if v['avg_fwd_ratio'] else '--'}")

    ch = R("recommended", "wash-pump")
    _report(checks, "C5 chop: spend <=5% of inflow (noise dips stay cheap)",
            ch["spent"] <= 0.05 * ch["inflow"],
            f"spent {ch['spent']:,.0f} / inflow {ch['inflow']:,.0f}")

    dd = R("recommended", "double-dip")
    leg1 = sum(s for d, _, s, _ in dd["buys"] if d <= 4)
    leg2 = sum(s for d, _, s, _ in dd["buys"] if 8 <= d <= 13)
    _report(checks, "C6 double-dip: buys both legs (leg2 > 0)",
            leg1 > 0 and leg2 > 0,
            f"leg1 {leg1:,.0f}, leg2 {leg2:,.0f}")

    bl = R("recommended", "bleed")
    _report(checks, "C7 bleed: keeps >=80% of peak through the grind",
            bl["reserve_end"] >= 0.8 * bl["reserve_peak"],
            f"end {bl['reserve_end']:,.0f} / peak {bl['reserve_peak']:,.0f}")

    bl_abs = R("abs-linear", "bleed")
    _report(checks, "C8 excess beats raw-24h trigger on bleed (the C7 failure)",
            bl["spent"] <= 0.25 * bl_abs["spent"],
            f"excess spent {bl['spent']:,.0f} vs abs {bl_abs['spent']:,.0f}")

    passed = sum(checks)
    print(f"\n{passed}/{len(checks)} dip checks pass")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
