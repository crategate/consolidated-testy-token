"""NYSEH offer-desk simulation driver.

Usage:
    python3 sim/run.py            # self-test + all scenarios + invariant report
    python3 sim/run.py --quiet    # invariant report only (no day tables)

Requires: python3 stdlib only. Run from anywhere; paths are relative to this
file's directory. Deterministic: every run uses random.Random(42).

Each simulated trading day:
  1. scenario base return + yesterday's buyback impact -> today's return
  2. record priceChange24h (centi-percent) into the 20-day ring
  3. ported metrics: momentum, stake health (then record ratio), aggression
  4. combiner builds the 3-tier offer sheet (or shuts the desk)
  5. acceptance model fills tiers; fills shift the accepted-offer rings
  6. staking ratio mean-reverts toward the scenario target
  7. vault/token flows: sold lots leave the vault; 80% of proceeds are
     booked back as tokens at today's close (assumption: buyback executes at
     close, its PRICE IMPACT lands on tomorrow's return)
"""

import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics
from combiner import build_offer_sheet
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


def run_sim(scenario, impact_k=IMPACT_K, seed=SEED):
    """Simulate one scenario; return list of per-day row dicts."""
    rng = random.Random(seed)
    state = MetricsState(total_staked=int(START_STAKED_PCT * SUPPLY / 100),
                         total_supply=SUPPLY)
    accepted = AcceptedOffers()
    price = START_PRICE
    vault = float(START_VAULT)
    staked_pct = START_STAKED_PCT
    pending_impact_cp = 0.0   # buyback impact landing on today's return
    rows = []

    for day in range(1, DAYS + 1):
        base_cp = scenario.base_ret_cp(day, rng)          # rng draw 1
        ret_cp = base_cp + pending_impact_cp
        price *= 1.0 + ret_cp / 10_000.0

        record_price_change(state, int(round(ret_cp)))
        momentum = calculate_momentum_score(state)
        stake_health = calculate_stake_health(state)
        record_stake_ratio(state)
        aggression = offer_accepted_aggression(accepted)

        sheet = build_offer_sheet(momentum, stake_health, aggression, vault)

        fills = {"sml": 0.0, "med": 0.0, "big": 0.0}
        notional = 0.0
        tokens_sold = 0.0
        for t in ("sml", "med", "big"):
            noise = rng.gauss(0.0, FILL_NOISE)            # rng draws 2-4
            if sheet is None:
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
            "vault": vault, "impact_cp_next": pending_impact_cp,
        })
    return rows


def print_table(name, rows):
    print(f"\n== {name} " + "=" * max(1, 78 - len(name)))
    print(" d  ret%    mom   stk  aggr   A     disc s/m/b      vest s/m/b  sheet%vault fill s/m/b")
    for r in rows:
        s = r["sheet"]
        base = (f"{r['day']:2d} {r['ret_cp'] / 100:+6.2f} {r['momentum']:5d} "
                f"{r['stake_health']:4d} {r['aggression']:5d}")
        if s is None:
            print(f"{base}   --    -- empty --              --             --")
        else:
            t = s["tiers"]
            discs = "/".join(str(t[x]["discount_bps"]) for x in ("sml", "med", "big"))
            vests = "/".join(str(t[x]["vesting_days"]) for x in ("sml", "med", "big"))
            fills = "/".join(f"{r['fills'][x]:.0f}" for x in ("sml", "med", "big"))
            pct_vault = 100.0 * s["sheet_tokens"] / r["vault"] if r["vault"] else 0.0
            print(f"{base} {s['a']:.3f}  {discs:>15}  {vests:>9}  {pct_vault:9.2f}% {fills:>9}")
    last = rows[-1]
    print(f"  end: price {last['price']:.4f}  vault {last['vault']:,.0f}  "
          f"total buyback {sum(r['buyback_notional'] for r in rows):,.0f} USDC")


# --- invariants ---------------------------------------------------------------

def _sheet_days(rows):
    return [r for r in rows if r["sheet"] is not None]


def _avg_disc(rows):
    ds = [sum(r["sheet"]["tiers"][t]["discount_bps"] for t in ("sml", "med", "big")) / 3
          for r in _sheet_days(rows)]
    return sum(ds) / len(ds) if ds else 0.0


def _avg_scale(rows):
    ss = [r["sheet"]["scale"] for r in _sheet_days(rows)]
    return sum(ss) / len(ss) if ss else 0.0


def _avg_sheet_tokens(rows):
    ts = [r["sheet"]["sheet_tokens"] for r in _sheet_days(rows)]
    return sum(ts) / len(ts) if ts else 0.0


def check_invariants(results):
    """results: dict name -> rows. Prints PASS/FAIL per invariant."""
    out = []

    def report(name, ok, detail):
        out.append(ok)
        print(f"  [{'PASS' if ok else 'FAIL'}] {name} — {detail}")

    # 1. momentum < 3500 (or 0) => empty sheet, every scenario, every day
    bad = [f"{n} d{r['day']}" for n, rows in results.items() for r in rows
           if (r["momentum"] < 3_500 or r["momentum"] == 0) != (r["sheet"] is None)]
    report("1 gate: momentum<3500 <=> empty sheet",
           not bad, f"violations: {bad[:5]}" if bad else "all scenarios, all 40 days")

    # 2. bear: empty after day ~6, zero buyback notional
    bear = results["bear"]
    late = [r for r in bear if r["day"] >= 7]
    empty_late = all(r["sheet"] is None for r in late)
    bb_late = sum(r["buyback_notional"] for r in late)
    first_shut = next((r["day"] for i, r in enumerate(bear)
                       if r["sheet"] is None and all(x["sheet"] is None for x in bear[i:])), None)
    report("2 bear: desk shut from day ~6, no buybacks",
           empty_late and bb_late == 0.0,
           f"last sheet day before permanent shutdown: {first_shut - 1 if first_shut else 'n/a'}, "
           f"buyback after d6: {bb_late:,.0f}")

    # 3. bull vs chop (wash-pump): richer discounts, bigger sheets
    bull, chop = results["bull"], results["wash-pump"]
    bd, cd = _avg_disc(bull), _avg_disc(chop)
    bs, cs = _avg_scale(bull), _avg_scale(chop)
    bt, ct = _avg_sheet_tokens(bull), _avg_sheet_tokens(chop)
    report("3 bull > chop: avg discount and sheet size",
           bd > cd and bs > cs,
           f"disc {bd:.0f} vs {cd:.0f} bps; scale {bs:.2f} vs {cs:.2f}; "
           f"tokens {bt:,.0f} vs {ct:,.0f}")

    # 4. wash pump: spike is brief and never pinned near max sheet
    wash = results["wash-pump"]
    elevated = [r["day"] for r in wash if r["sheet"] and r["sheet"]["a"] >= 0.50]
    streak = mx = 0
    for r in wash:
        streak = streak + 1 if (r["sheet"] and r["sheet"]["scale"] >= 0.95) else 0
        mx = max(mx, streak)
    report("4 wash pump: A>=0.50 <= 3 days; >=95% sheet < 4 consecutive",
           len(elevated) <= 3 and mx < 4,
           f"A>=0.50 days {elevated}; max >=95%-scale streak {mx}")

    # 5. rocket: >=90% of max sheet while momentum is pinned
    rocket = results["rocket"]
    hot = [r for r in rocket if r["momentum"] >= 9_000]
    hold = all(r["sheet"] and r["sheet"]["scale"] >= 0.90 for r in hot)
    report("5 rocket: scale>=0.90 whenever momentum>=9000",
           bool(hot) and hold,
           f"{len(hot)} pinned days (d{hot[0]['day']}-d{hot[-1]['day']}), "
           f"min scale {min((r['sheet']['scale'] for r in hot), default=0):.3f}")

    # 6. proven demand => tighter discounts (same seed pair)
    lo, hi = results["bull-low-demand"], results["bull-high-demand"]
    report("6 high-demand bull tighter than low-demand bull",
           _avg_disc(hi) < _avg_disc(lo),
           f"avg disc high-demand {_avg_disc(hi):.0f} vs low-demand {_avg_disc(lo):.0f} bps")

    return out


def check_buyback_loop(scenario):
    """7. same-seed bull: buyback loop ON ends above loop OFF."""
    on = run_sim(scenario, impact_k=IMPACT_K, seed=SEED)
    off = run_sim(scenario, impact_k=0.0, seed=SEED)
    p_on, p_off = on[-1]["price"], off[-1]["price"]
    ok = p_on > p_off
    print(f"  [{'PASS' if ok else 'FAIL'}] 7 buyback loop ON > OFF (same seed) — "
          f"final price {p_on:.4f} vs {p_off:.4f} ({100 * (p_on / p_off - 1):+.1f}%)")
    return [ok]


def main():
    quiet = "--quiet" in sys.argv

    print("== metrics self-test " + "=" * 58)
    if not metrics.self_test():
        print("SELF-TEST FAILED — aborting")
        return 1

    scenarios = build_scenarios()
    results = {}
    for sc in scenarios:
        rows = run_sim(sc)
        results[sc.name] = rows
        if not quiet:
            print_table(sc.name, rows)

    print("\n== invariants " + "=" * 66)
    checks = check_invariants(results)
    bull = next(sc for sc in scenarios if sc.name == "bull")
    checks += check_buyback_loop(bull)

    passed = sum(checks)
    print(f"\n{passed}/{len(checks)} invariants pass")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
