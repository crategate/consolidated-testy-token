"""Offer-sheet combiner v3 — SEQUENTIAL pipeline, total-tokens-first.

Each dimension depends on the ones already decided (order ablated in E6):

  1. total_tokens <- momentum only: vault * pct_bump(momentum). Bump-shaped:
     courtesy ~0.4% of vault when flat (<4500), ramp through the ignition
     band (4500-5500), apex 5% in strong mid-run, taper to 2% when pinned
     (>8000). Optional +/-20% aggression modulation (tested in E6, default
     OFF — totals stay a pure price signal).
  2. lot tiers    <- vault abundance ceiling + excitement E (0.6*mom_x +
     0.4*aggr_x): big at ceiling - rhu((1-E)*4), spacing = 2 + rhu(2*mom_x),
     med = big - spacing, sml = med - spacing, ordering enforced after
     clamping (sml >= 1, each >= 1 rung apart).
  3. counts       <- DERIVED from 1 & 2: value split big 50 / med 35 / sml 15,
     count[t] = floor(total_tokens * share / lot_tokens). (Price cancels in
     the value split: split_value/(lot*price) = split_tokens/lot.) Then
     vault-limited proportional scale-down, floored, never negative.
     Count 0 => tier unlisted.
  4. discount     <- momentum bump peaking EARLIER than totals (apex 5750 vs
     6750), D_FLAT 300 bps, taper to 60% of peak when pinned; minus
     aggression tightening (400*aggr/10000); plus tier steps {0,+150,+300};
     cascade-clamped to the floor cap (strict big>med>sml preserved);
     tier unlisted if realized < 200 bps. NO momentum bear gate — the floor
     cap does that work (live <= floor => cap <= 0 => nothing lists).
  5. vesting      <- stake health: base {5,10,20} * (0.5 + health/100);
     CROSS-DEPENDENCY on step 4: minus VEST_COMP_K*(target - realized)/100
     days — a floor-crushed discount is compensated with shorter locks.
     Clamped 3..30 whole days. (mode="vest_first"/"independent" drops the
     compensation for the E6 ablation.)

Hard constraints (all enforced here): dynamic tiers with sml < med < big at
>= 1 rung; discount strictly big > med > sml among listed tiers; graceful
vault-limited scale-down; sheet <= MAX_OFFER_PCT_BPS (5%) of vault BY
CONSTRUCTION (pct bump apex = 5%); cold start (momentum == 0) => empty sheet.

LADDER RESCALE (constant change vs draft): the drafted ceilings
(17/15/12/9/6) collapse under derived floor counts — at the mandated
euphoria taper a ~350k vault offers ~5-7k tokens total, the big 50% split
is ~3k, and any big lot >= tier 10 (5000 tokens) floors to count 0 (at
ceiling 17 one big lot alone is 250k = the whole vault). Rungs are scaled
so a full-vault big lot still yields count >= 1 at taper totals; the
ladder structure, E-slide and spacing are unchanged.

Floor-cap note: on-chain, highest_buyback_basis is only READ (offer_claim
ratchet); nothing updates it yet. The sim's floor model lives in run.py
(init at start price, ratchet max +1%/day toward buyback exec prices).
"""

import math

from metrics import MAX_OFFER_PCT_BPS, clamp

# lot_sizer() mirror: tier index 0..21 -> whole NYSEH per lot
LOT_LADDER = [0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500,
              10000, 15000, 20000, 50000, 100000, 250000, 500000, 1000000,
              2500000, 5000000]

TIERS = ("sml", "med", "big")

# --- step 1: total_tokens <- momentum -----------------------------------------
# THREE SHAPE VARIANTS, ablated in E6 (SHAPE selects; "bump" is the default):
#   "bump" — BUMP-TAPER: ramp through ignition, 5% plateau 6750-7500, taper
#            to 2% by 8500. The plateau ends at 7500 (not 8000) on purpose:
#            a clamped +40% wash pump pushes momentum to ~7500-8000, so it
#            lands on the TAPER (wash invariant), while a genuine ignition
#            passes through the plateau rising and gets full sheets.
#   "ramp" — MONOTONE-RAMP: 25 bps at <= 4000, linear to 500 bps at >= 8000.
#   "flat" — always 500 bps (5% cap); metrics shape only the other dims.
PCT_POINTS = [
    (4_500,   50),   # ignition band entry (0.5%)
    (5_500,  200),   # ignition band top (2%)
    (6_750,  500),   # strong mid-run apex reached (5% = MAX_OFFER_PCT_BPS)
    (7_500,  500),   # plateau end
    (8_500,  200),   # euphoria taper
    (10_000, 200),   # pinned: 2% (top of the mandated 1-2% band)
]
PCT_FLAT_BPS = 40      # flat courtesy below 4500 (inside the 0.25-0.5% band)
RAMP_POINTS = ((4_000, 25), (8_000, 500))   # monotone-ramp endpoints
AGGR_MOD = False       # optional +/-20% totals modulation by aggression

# --- step 2: lot tiers ----------------------------------------------------------
# (vault fraction of run's initial vault, ceiling tier index) — RESCALED, see
# module docstring. Draft was (0.75,17) (0.50,15) (0.25,12) (0.10,9) (0,6).
VAULT_CEILING = [(0.75, 9), (0.50, 7), (0.25, 5), (0.10, 3), (0.0, 1)]
W_E_MOM, W_E_AGGR = 0.6, 0.4
E_TIER_SLIDE = 4.0       # big sits this many rungs below ceiling at E = 0
SPACING_BASE = 2
SPACING_MOM = 2.0        # spacing = BASE + rhu(SPACING_MOM * mom_x)

# --- step 3: derived counts -----------------------------------------------------
VALUE_SPLIT = {"big": 0.50, "med": 0.35, "sml": 0.15}

# --- step 4: discount -----------------------------------------------------------
D_FLAT = 300             # bps when momentum < 4500
D_PEAK = 1_350           # bps apex of the discount bump
D_PEAK_MOM = 5_750       # ...reached here (totals apex is 6750 — peaks earlier)
D_TAPER = 810            # bps when pinned >= 8000 (60% of peak)
AGGR_TIGHTEN_BPS = 400   # -400 bps at aggression 10000
TIER_STEP = {"sml": 0, "med": 150, "big": 300}
MIN_TIER_DISC_BPS = 200  # realized < 200 => tier unlisted (incl. via floor cap)

# --- step 5: vesting --------------------------------------------------------------
VEST_BASE = {"sml": 5, "med": 10, "big": 20}
VEST_COMP_K = 3          # days off per 100 bps of floor-cap compression
                           # (draft said k~2; 3 makes the compensation
                           #  visible in crushed-day fills — see E6)
VEST_MIN, VEST_MAX = 3, 30

MOM_X_LO, MOM_X_SPAN = 3_500, 6_500  # shared scale with v1 (NOT a gate here)


def rhu(x: float) -> int:
    """Round half up — integer-friendly spec rounding."""
    return int(math.floor(x + 0.5))


def mom_x_of(momentum: int) -> float:
    return clamp((momentum - MOM_X_LO) / MOM_X_SPAN, 0.0, 1.0)


def _interp(points, x: int) -> float:
    """Piecewise-linear interpolation between (x, y) control points."""
    (x0, y0), (x1, y1) = points
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


def pct_of_vault_bps(momentum: int, shape: str = "bump") -> float:
    """Totals as bps of vault (500 = 5% hard cap). shape: "bump" (plateau +
    euphoria taper), "ramp" (monotone linear), "flat" (always 5%)."""
    if shape == "flat":
        return float(MAX_OFFER_PCT_BPS)
    if shape == "ramp":
        (x0, y0), (x1, y1) = RAMP_POINTS
        if momentum <= x0:
            return float(y0)
        if momentum >= x1:
            return float(y1)
        return _interp(((x0, y0), (x1, y1)), momentum)
    # bump-taper
    if momentum < 4_500:
        return float(PCT_FLAT_BPS)
    for i in range(len(PCT_POINTS) - 1):
        if momentum <= PCT_POINTS[i + 1][0]:
            return _interp((PCT_POINTS[i], PCT_POINTS[i + 1]), momentum)
    return float(PCT_POINTS[-1][1])


def discount_target(momentum: int, aggression: int) -> float:
    """Discount bump (peaks at 5750, earlier than totals) minus aggression
    tightening. bps, before tier steps and the floor cap."""
    if momentum < 4_500:
        bump = float(D_FLAT)
    elif momentum <= D_PEAK_MOM:
        bump = _interp(((4_500, D_FLAT), (D_PEAK_MOM, D_PEAK)), momentum)
    elif momentum <= 8_000:
        bump = _interp(((D_PEAK_MOM, D_PEAK), (8_000, D_TAPER)), momentum)
    else:
        bump = float(D_TAPER)
    return bump - AGGR_TIGHTEN_BPS * (aggression / 10_000)


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
    """(sml, med, big) tier indices, ordering enforced after clamping."""
    ceiling = vault_ceiling(vault_balance, initial_vault)
    big = ceiling - rhu((1.0 - e) * E_TIER_SLIDE)
    spacing = SPACING_BASE + rhu(SPACING_MOM * mom_x)
    med = big - spacing
    sml = med - spacing
    big = max(big, 3)                      # minimum sheet: tiers 1/2/3
    med = min(max(med, 2), big - 1)
    sml = min(max(sml, 1), med - 1)
    return sml, med, big


def build_offer_sheet_v3(momentum: int, stake_health: int, aggression: int,
                         vault_balance: float, live_price: float,
                         floor_price: float, initial_vault: float = 400_000,
                         mode: str = "full", aggr_mod: bool = AGGR_MOD,
                         shape: str = "bump"):
    """Sequential pipeline. mode: "full" (as specced) | "vest_first" (no
    discount->vesting compensation) | "independent" (no compensation and
    per-tier cap clamp without the strict-order cascade).
    shape: totals curve — "bump" | "ramp" | "flat" (ablated in E6).

    Returns None (empty sheet) when shut, else a dict with tier entries:
      {lot_index, lot_size (tokens), total_offered, discount_bps,
       vesting_days, target_discount}
    """
    if momentum == 0:
        return None  # cold start (< 5 samples)

    # -- 1. total tokens -------------------------------------------------------
    pct_bps = pct_of_vault_bps(momentum, shape)
    if aggr_mod:
        pct_bps *= 0.8 + 0.4 * (aggression / 10_000)   # +/-20% around 1.0
    total_tokens = vault_balance * pct_bps / 10_000    # <= 5% by construction

    cap_bps = (1.0 - floor_price / live_price) * 10_000 if live_price > 0 else 0.0

    # -- 2. lot tiers -----------------------------------------------------------
    e, mom_x = excitement(momentum, aggression)
    idx = dict(zip(TIERS, lot_indices(e, mom_x, vault_balance, initial_vault)))

    # -- 3. derived counts --------------------------------------------------------
    counts = {t: int(total_tokens * VALUE_SPLIT[t] / LOT_LADDER[idx[t]])
              for t in TIERS}
    sheet = sum(counts[t] * LOT_LADDER[idx[t]] for t in TIERS)
    if sheet > vault_balance and sheet > 0:   # vault-limited scale-down
        counts = {t: int(counts[t] * vault_balance / sheet) for t in TIERS}
    counts = {t: max(0, c) for t, c in counts.items()}   # never negative

    # -- 4. discount --------------------------------------------------------------
    base = discount_target(momentum, aggression)
    raw = {t: base + TIER_STEP[t] for t in TIERS}
    if mode == "independent":
        capped = {t: min(raw[t], cap_bps) for t in TIERS}
        # keep strict order by unlisting any tier not strictly above the
        # lower listed one (no cascade rescue)
        hi = None
        for t in TIERS:  # sml -> big
            if hi is not None and capped[t] <= hi:
                capped[t] = -1.0   # violates strict order: unlist
            else:
                hi = capped[t]
    else:
        capped = {"big": min(raw["big"], cap_bps)}
        capped["med"] = min(raw["med"], capped["big"] - 1)
        capped["sml"] = min(raw["sml"], capped["med"] - 1)

    listed = [t for t in TIERS
              if counts[t] > 0 and capped[t] >= MIN_TIER_DISC_BPS]
    if not listed:
        return None

    # -- 5. vesting (cross-depends on realized discounts in "full" mode) ----------
    tiers = {}
    for t in listed:
        vest_base = VEST_BASE[t] * (0.5 + stake_health / 100)
        if mode == "full":
            days_off = int(VEST_COMP_K * max(0.0, raw[t] - capped[t]) / 100)
        else:
            days_off = 0
        vest = clamp(rhu(vest_base) - days_off, VEST_MIN, VEST_MAX)
        tiers[t] = {
            "lot_index": idx[t],
            "lot_size": LOT_LADDER[idx[t]],
            "total_offered": counts[t],
            "discount_bps": int(capped[t]),
            "vesting_days": vest,
            "target_discount": int(raw[t]),
        }

    sheet_tokens = sum(x["total_offered"] * x["lot_size"] for x in tiers.values())
    return {"pct_bps": pct_bps, "e": e, "mom_x": mom_x, "cap_bps": cap_bps,
            "total_tokens": total_tokens, "sheet_tokens": sheet_tokens,
            "tiers": tiers}
