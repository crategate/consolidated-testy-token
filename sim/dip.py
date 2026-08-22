"""Buy-the-dip spec port — trigger + sizing curve (pre-implementation model).

Unlike dex_buyback (open-market hours, fill-gated), buy_the_dip is designed to
be callable at ANY time: the only inputs are the live 24h price change and the
chained 20-day price_changes ring in MarketMetrics. This module is the
Rust-portable spec: integer-only, truncating division, inclusive clamps — same
conventions as metrics.py so the on-chain port is mechanical.

RECOMMENDED SPEC (the defaults below; evidence in run_dip.py):
  baseline = mean(newest 5 ring samples)      [recent norm of the 20-day chain]
  depth    = -(pc24 - baseline)               [EXCESS of today's 24h change
             over the recent norm; a -4.5% day in a -4.5%/day grind is the
             trend, not a dip — this kills the slow-bleed reserve drain]
  trigger  : depth >= TRIGGER_CP (300 = 3% worse than the recent norm)
  size     = BASE_SPEND_BPS x depth_factor^2 x trend_mult, bps of the CURRENT
             dip reserve (both legs: usdc_dip and sol_dip)
  day cap  = DAY_CAP_BPS of the reserve per trading day, so one crash candle
             can't empty the reserve even if the crank fires all day

  depth_factor = min(depth, FULL_DEPTH_CP) / FULL_DEPTH_CP, then SQUARED:
             -3% dip -> 9% of base, -6% -> 36%, -10% -> 100%. Convexity keeps
             powder for deeper dips (cascade scenario: 458 / 1,325 / 3,507 /
             3,291 across -3/-6/-10/-15% legs).
  trend_mult   = clamp(10_000 + slope*TREND_GAIN, TREND_FLOOR_BPS, TREND_CAP_BPS)
             with slope = recent-5 mean - older-15 mean [same 5/15 split and
             +/-10% sample clamp as calculate_momentum_score]:
             pullback in an uptrend -> up to 125% of base (buy hard);
             chained 20-day metric rolling over -> down to 25% (knife guard:
             spends 3.0k vs 11.6k naive on the knife scenario, keeps 85% of
             the reserve).

Dip fills ratchet highest_buyback_basis exactly like dex_buyback fills (the
ratchet only moves up, so cheap dip buys never lower the offer-desk floor).

Not modeled here (on-chain concerns, no sim value): slot pacing between
slices, pseudo-random slice jitter, oracle staleness gate. The sim evaluates
one decision per trading day with pc24 = today's close-to-close return.
"""

from metrics import SAMPLE_CAP_CP, clamp, tdiv

# --- knobs under test (defaults = candidate spec) ---------------------------
TRIGGER_CP = 300        # fire when the 24h change is <= -3.00%
FULL_DEPTH_CP = 1_000   # a -10.00% day maps to full depth aggression
BASE_SPEND_BPS = 2_500  # 25% of reserve at full depth, neutral trend
TREND_GAIN = 10         # multiplier bps per centi-percent of slope
TREND_FLOOR_BPS = 2_500  # falling-knife throttle: 25% of base
TREND_CAP_BPS = 12_500   # uptrend-pullback boost: 125% of base
DAY_CAP_BPS = 4_000      # at most 40% of the reserve per trading day

RECENT_N = 5            # slope split — matches momentum's recent window


def recent_mean_cp(price_changes, sample_head):
    """Mean of the newest RECENT_N ring samples (centi-percent); 0 when the
    recent window has no samples (cold start). This is the 'chained 20-day
    metric' baseline the excess-depth mode measures dips against."""
    n = len(price_changes)
    head = sample_head % n
    recent_sum = recent_n = 0
    for age in range(n - RECENT_N, n):
        raw = price_changes[(head + age) % n]
        if raw == 0:
            continue
        recent_sum += clamp(raw, -SAMPLE_CAP_CP, SAMPLE_CAP_CP)
        recent_n += 1
    return tdiv(recent_sum, recent_n) if recent_n else 0


def trend_slope_cp(price_changes, sample_head):
    """Slope of the chained 20-day metric: recent-5 mean minus older-15 mean,
    centi-percent. 0 during cold start (raw==0 reads as 'no sample', exactly
    like calculate_momentum_score)."""
    n = len(price_changes)
    head = sample_head % n
    older_sum = older_n = 0
    for age in range(n - RECENT_N):  # age 0 = oldest entry
        raw = price_changes[(head + age) % n]
        if raw == 0:
            continue
        older_sum += clamp(raw, -SAMPLE_CAP_CP, SAMPLE_CAP_CP)
        older_n += 1
    older = tdiv(older_sum, older_n) if older_n else 0
    return recent_mean_cp(price_changes, sample_head) - older


def dip_spend_bps(pc24_cp, price_changes, sample_head, day_spent_bps=0,
                  trigger_cp=TRIGGER_CP, full_depth_cp=FULL_DEPTH_CP,
                  base_bps=BASE_SPEND_BPS, trend_gain=TREND_GAIN,
                  trend_floor_bps=TREND_FLOOR_BPS, trend_cap_bps=TREND_CAP_BPS,
                  day_cap_bps=DAY_CAP_BPS, mode="excess", depth_power=2):
    """The spec function. Returns bps of the current dip reserve to spend now
    (0 = no buy). `day_spent_bps` is how much of the reserve has already been
    spent today (enforces DAY_CAP_BPS across intraday slices).

    mode "abs":    depth = -pc24  (raw 24h change — the naive trigger)
    mode "excess": depth = -(pc24 - recent-5-day mean). A -4.5% day after two
                   weeks of -4.5% days IS the trend, not a dip — excess mode
                   only fires on moves worse than the recent norm, which is
                   what stops the slow-bleed drain (see run_dip.py C7).

    depth_power 1: depth factor linear — a -3% dip spends 30% of base.
    depth_power 2: quadratic — a -3% dip spends 9% of base, -6% spends 36%,
                   -10% spends 100%. Convexity keeps powder for deeper dips:
                   the protocol only goes big when the move is genuinely big."""
    depth = -pc24_cp
    if mode == "excess":
        depth = -(pc24_cp - recent_mean_cp(price_changes, sample_head))
    if depth < trigger_cp:
        return 0
    clamped = min(depth, full_depth_cp)
    if depth_power == 2:
        depth_bps = clamped * clamped * 10_000 // (full_depth_cp * full_depth_cp)
    else:
        depth_bps = clamped * 10_000 // full_depth_cp
    slope = trend_slope_cp(price_changes, sample_head)
    mult = clamp(10_000 + slope * trend_gain, trend_floor_bps, trend_cap_bps)
    spend = base_bps * depth_bps * mult // 100_000_000
    return min(spend, max(0, day_cap_bps - day_spent_bps))


def self_test():
    ok = True

    def check(name, got, want):
        nonlocal ok
        good = got == want
        ok = ok and good
        print(f"  [{'PASS' if good else 'FAIL'}] {name}: got {got}, want {want}")

    flat = ([100] * 20, 0)          # steady +1%/day uptrend ring
    check("no trigger on -1% day",
          dip_spend_bps(-100, *flat), 0)
    check("trigger boundary (abs mode): -2.99% no, -3.00% yes",
          (dip_spend_bps(-299, *flat, mode="abs", depth_power=1),
           dip_spend_bps(-300, *flat, mode="abs", depth_power=1)),
          (0, 750))  # 2500 x 30% depth x neutral trend
    # full-depth, empty ring (baseline 0 -> excess == abs; slope 0 -> mult 1)
    check("full depth, neutral trend == base",
          dip_spend_bps(-1_000, [0] * 20, 0), BASE_SPEND_BPS)
    check("beyond full depth clamps",
          dip_spend_bps(-2_500, [0] * 20, 0), BASE_SPEND_BPS)
    # uptrend ring: recent 5 at +300, older 15 at +100 -> slope +200 -> mult 12000
    up = [100] * 15 + [300] * 5
    check("uptrend boost == base x 1.2",
          dip_spend_bps(-1_000, up, 0), BASE_SPEND_BPS * 12_000 // 10_000)
    # falling knife: recent 5 at -800, older 15 at +100 -> slope -900 -> floor.
    # baseline -800, so a -18% day is needed for full excess depth.
    knife = [100] * 15 + [-800] * 5
    check("falling knife floored at 25% of base",
          dip_spend_bps(-1_800, knife, 0), BASE_SPEND_BPS * TREND_FLOOR_BPS // 10_000)
    # ...and a mere -10% day inside that knife is only 2% over the norm:
    # no trigger (the knife IS the trend)
    check("knife: -10% day at the -8% norm does not fire",
          dip_spend_bps(-1_000, knife, 0), 0)
    # day cap: already spent 35% -> at most 5% more
    check("day cap binds",
          dip_spend_bps(-1_000, [0] * 20, 0, day_spent_bps=3_500),
          DAY_CAP_BPS - 3_500)
    check("day cap exhausted -> 0",
          dip_spend_bps(-1_000, [0] * 20, 0, day_spent_bps=DAY_CAP_BPS), 0)
    # slope with ring wrap-around (head mid-ring)
    ring = [0] * 20
    vals = [-50] * 15 + [200] * 5   # oldest..newest
    head = 7
    for i, v in enumerate(vals):
        ring[(head + i) % 20] = v
    # wrapped ring slope == 250
    check("wrapped ring slope == 250", trend_slope_cp(ring, (head + 20) % 20), 250)

    # excess mode: dip measured against the recent 5-day norm
    steady_fall = [-450] * 20       # grinding -4.5%/day: -4.5% IS the trend
    check("excess: -4.5% day in a -4.5% trend is not a dip",
          dip_spend_bps(-450, steady_fall, 0, mode="excess"), 0)
    check("excess: same day in a flat trend IS a dip",
          dip_spend_bps(-450, [0] * 20, 0, mode="excess"),
          506)  # 2500 x (0.45)^2 depth x neutral trend (quadratic)
    check("excess: flush out of an uptrend triggers harder",
          dip_spend_bps(-600, up, 0, mode="excess") >
          dip_spend_bps(-600, up, 0, mode="abs"), True)
    # quadratic keeps shallow dips cheap (powder for deeper moves)
    check("quad: -3% dip spends 9% of base, -6% spends 36%",
          (dip_spend_bps(-300, [0] * 20, 0, trend_floor_bps=10_000,
                         trend_cap_bps=10_000),
           dip_spend_bps(-600, [0] * 20, 0, trend_floor_bps=10_000,
                         trend_cap_bps=10_000)),
          (225, 900))
    return ok


if __name__ == "__main__":
    import sys
    sys.exit(0 if self_test() else 1)
