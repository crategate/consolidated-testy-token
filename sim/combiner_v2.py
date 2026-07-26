"""Offer-sheet combiner v2: one primary driver per dimension (narrative design).

  discount_base <- momentum (BUMP curve: peak in the ignition band, courtesy
                   when flat, reduced "monetization" discount when euphoric),
                   minus aggression tightening, plus strictly-rising tier steps.
  count[t]      <- excitement E = w_m*mom_x + w_a*aggr_x (throttle on base
                   counts), bounded by the 5%-of-vault sheet ceiling, then
                   vault-limited proportional scale-down (never negative).
  lot tier[t]   <- vault abundance (ceiling ladder) + E, with momentum-widened
                   spacing. Ordering sml < med < big enforced ALWAYS.
  vesting[t]    <- stake health primary (high health = longer locks), weak
                   demand secondary sweetener (up to -3 days when aggr low).

Hard constraints honored:
  * sml tier >= 1 below med, med >= 1 below big on every listed day.
  * discount strictly big > med > sml on listed tiers (cascade clamp to the
    floor cap preserves strictness, steps may compress under the cap).
  * floor cap: tier discount <= (1 - floor/live)*10000 bps; a day with
    cap < 200 bps lists nothing (this replaces v1's momentum bear gate —
    the floor does that work). A tier whose own capped discount < 200 bps
    is unlisted individually.
  * cold start (momentum == 0, < 5 samples) -> empty sheet.
  * sheet never exceeds MAX_OFFER_PCT_BPS (5%) of the vault; if the vault
    can't cover the calculated sheet, counts scale down proportionally.

Rescale note: the draft ladder ceilings (17/15/12/9/6) imply a single big lot
of 250k tokens = 62% of the 400k vault — impossible under the 5% sheet cap.
The ladder STRUCTURE is kept but rungs are rescaled so a full-vault big lot is
~1/3 of the sheet ceiling (2 lots x 7500 = 15k vs 20k cap).

Tuning history (draft -> current):
  * E weights 0.6/0.4 -> 0.8/0.2 (mom/aggr). With 0.6/0.4, baseline chop
    (aggr ~0.8) sat at E ~0.53 and the wash-pump spike plateaued at ~0.75
    for 5 days; the "elevated <= 3 days" bar had no room. Upweighting mom_x
    drops the chop baseline (~0.48) and sharpens the spike's peak.
  * count scale 0.25 + 1.25*E -> 0.20 + 1.05*E. Under the draft slope the
    sheet pinned at >=95% of max for ~7 days after one clamped +40% wash
    (the momentum metric's 5-day recent window + buyback echo hold E >= 0.56).
    The gentler slope reaches full counts only near E = 0.76, so a wash pump
    produces < 4 consecutive >=95% days while a true rocket (E = 1.0) still
    opens the sheet fully.
  * ladder ceilings 17/15/12/9/6 -> 11/9/7/4/2 (see rescale note).
"""

import math

from metrics import MAX_OFFER_PCT_BPS, clamp

# lot_sizer() mirror: tier index 0..21 -> whole NYSEH per lot
LOT_LADDER = [0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500,
              10000, 15000, 20000, 50000, 100000, 250000, 500000, 1000000,
              2500000, 5000000]

TIERS = ("sml", "med", "big")

# --- discount: momentum bump curve -------------------------------------------
D_FLAT = 250            # courtesy discount (bps) when flat
D_PEAK = 1_300          # peak discount (bps) in the ignition band (~6000)
BUMP_EUPHORIA = 0.4     # residual bump fraction at momentum 10000
BUMP_PLATEAU = 0.6      # bump fraction at momentum 8000
AGGR_TIGHTEN_BPS = 400  # max aggression tightening: -400 bps at aggr 10000
TIER_STEP = {"sml": 0, "med": 150, "big": 300}   # strictly big > med > sml
MIN_TIER_DISC_BPS = 200  # below this (own discount or floor cap): unlisted

# --- counts: excitement throttle ----------------------------------------------
W_E_MOM = 0.8
W_E_AGGR = 0.2
COUNT_SCALE_FLOOR = 0.20
COUNT_SCALE_SLOPE = 1.05   # scale = clamp(FLOOR + SLOPE*E, 0, 1); full at E~0.76
BASE_COUNT = {"sml": 10, "med": 4, "big": 2}

# --- lot tiers: vault abundance + excitement ----------------------------------
# (vault fraction of initial, ceiling tier index) — rescaled, see module note
VAULT_CEILING = [(0.75, 11), (0.50, 9), (0.25, 7), (0.10, 4), (0.0, 2)]
E_TIER_SLIDE = 4.0       # big sits this many rungs below ceiling at E = 0
SPACING_BASE = 2
SPACING_MOM = 2.0        # spacing = BASE + rhu(SPACING_MOM * mom_x)

# --- vesting: stake health primary ---------------------------------------------
VEST_BASE = {"sml": 5, "med": 10, "big": 20}
VEST_AGGR_RELIEF = 3.0   # up to 3 days off when aggression is low

MOM_X_LO, MOM_X_SPAN = 3_500, 6_500  # shared scale with v1 (NOT a gate here)


def rhu(x: float) -> int:
    """Round half up — integer-friendly spec rounding."""
    return int(math.floor(x + 0.5))


def mom_x_of(momentum: int) -> float:
    return clamp((momentum - MOM_X_LO) / MOM_X_SPAN, 0.0, 1.0)


def bump(momentum: int) -> float:
    """Piecewise-linear ignition bump: 0 at <=4000, 1 at 6000, 0.6 at 8000,
    0.4 at 10000. Peak discount while momentum rises through the ignition
    band; tapering to a monetization discount when euphoric."""
    if momentum <= 4_000:
        return 0.0
    if momentum <= 6_000:
        return (momentum - 4_000) / 2_000
    if momentum <= 8_000:
        return 1.0 - (momentum - 6_000) / 2_000 * (1.0 - BUMP_PLATEAU)
    return BUMP_PLATEAU - (momentum - 8_000) / 2_000 * (BUMP_PLATEAU - BUMP_EUPHORIA)


def excitement(momentum: int, aggression: int):
    """E in [0,1] and mom_x."""
    mx = mom_x_of(momentum)
    e = W_E_MOM * mx + W_E_AGGR * (aggression / 10_000)
    return clamp(e, 0.0, 1.0), mx


def vault_ceiling(vault_balance: float, initial_vault: float) -> int:
    pct = vault_balance / initial_vault if initial_vault > 0 else 0.0
    for threshold, tier in VAULT_CEILING:
        if pct >= threshold:
            return tier
    return VAULT_CEILING[-1][1]


def lot_indices(e: float, mom_x: float, vault_balance: float, initial_vault: float):
    """(sml, med, big) tier indices, ordering enforced after clamping.

    big sits below the vault ceiling by (1-E)*E_TIER_SLIDE rungs; spacing
    widens with momentum (euphoria spreads the tiers).
    """
    ceiling = vault_ceiling(vault_balance, initial_vault)
    big = ceiling - rhu((1.0 - e) * E_TIER_SLIDE)
    spacing = SPACING_BASE + rhu(SPACING_MOM * mom_x)
    med = big - spacing
    sml = med - spacing
    # enforce sml >= 1, med >= sml+1, big >= med+1 (minimum sheet: 1/2/3)
    big = max(big, 3)
    med = min(max(med, 2), big - 1)
    sml = min(max(sml, 1), med - 1)
    return sml, med, big


def vesting_days(tier: str, stake_health: int, aggression: int) -> int:
    """Stake health primary: high health -> longer locks (factor 0.5..1.5).
    Weak demand secondary: up to VEST_AGGR_RELIEF days off when aggr is low."""
    base = VEST_BASE[tier] * (0.5 + stake_health / 100)
    relief = rhu(VEST_AGGR_RELIEF * (1.0 - aggression / 10_000))
    return max(1, rhu(base) - relief)


def build_offer_sheet_v2(momentum: int, stake_health: int, aggression: int,
                         vault_balance: float, live_price: float,
                         floor_price: float, initial_vault: float = 400_000):
    """Return None (empty sheet) when shut, else a dict:

      {e, mom_x, bump, count_scale, cap_bps, sheet_tokens, tiers: {sml|med|big:
          {lot_index, lot_size (tokens), total_offered, discount_bps,
           vesting_days}}}

    `lot_index` is the on-chain Offer.lot_size field (lot_sizer rung);
    `lot_size` here is its token value for sim math.
    """
    if momentum == 0:
        return None  # cold start (< 5 samples)

    # floor cap replaces the momentum bear gate: never offer below basis
    cap_bps = (1.0 - floor_price / live_price) * 10_000 if live_price > 0 else 0.0
    if cap_bps < MIN_TIER_DISC_BPS:
        return None

    e, mom_x = excitement(momentum, aggression)
    count_scale = clamp(COUNT_SCALE_FLOOR + COUNT_SCALE_SLOPE * e, 0.0, 1.0)

    base_disc = D_FLAT + (D_PEAK - D_FLAT) * bump(momentum) \
        - AGGR_TIGHTEN_BPS * (aggression / 10_000)

    idx = dict(zip(TIERS, lot_indices(e, mom_x, vault_balance, initial_vault)))

    # cascade-clamp discounts to the floor cap, preserving strict big>med>sml
    raw = {t: base_disc + TIER_STEP[t] for t in TIERS}
    capped = {"big": min(raw["big"], cap_bps)}
    capped["med"] = min(raw["med"], capped["big"] - 1)
    capped["sml"] = min(raw["sml"], capped["med"] - 1)

    listed = [t for t in TIERS if capped[t] >= MIN_TIER_DISC_BPS]
    if not listed:
        return None

    # 5%-of-vault sheet ceiling, then vault-limited proportional scale-down
    want = sum(BASE_COUNT[t] * count_scale * LOT_LADDER[idx[t]] for t in listed)
    ceiling_tokens = vault_balance * (MAX_OFFER_PCT_BPS / 10_000)
    fit = min(1.0, ceiling_tokens / want) if want > 0 else 0.0
    fit = min(fit, vault_balance / want) if want > 0 else 0.0  # never overdraw

    tiers = {}
    for t in listed:
        count = int(BASE_COUNT[t] * count_scale * fit)  # floor, never negative
        if count <= 0:
            continue
        tiers[t] = {
            "lot_index": idx[t],
            "lot_size": LOT_LADDER[idx[t]],
            "total_offered": count,
            "discount_bps": int(capped[t]),
            "vesting_days": vesting_days(t, stake_health, aggression),
        }
    if not tiers:
        return None

    sheet_tokens = sum(x["total_offered"] * x["lot_size"] for x in tiers.values())
    return {"e": e, "mom_x": mom_x, "bump": bump(momentum),
            "count_scale": count_scale, "cap_bps": cap_bps,
            "sheet_tokens": sheet_tokens, "tiers": tiers}
