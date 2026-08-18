"""Offer-sheet combiner: (momentum, stake_health, aggression, vault) -> 3 tiers.

Rust-ready spec. Units match the on-chain Offer account where practical:
discount in bps (on-chain u8 is tenth-percent: onchain_disc = disc_bps // 10),
vesting in trading days, lot_size in whole NYSEH tokens (on-chain uses the
lot_sizer() tier index; the desk would snap to the nearest rung).

Sheet tiers (order matters everywhere): sml, med, big.

Tuning history (starting spec -> current, and why):
  * Attractiveness weights 0.50/0.30/0.20 -> 0.55/0.35/0.10 (mom/aggr/stake).
    Two invariants pulled opposite ways and both are about aggression:
      - Rocket: with momentum pinned at 10000, acceptance saturates and
        aggression pins near 10000. A had to stay >= ~0.58 (see sheet scale
        below) even at full aggression => momentum weight up.
      - Demand-pair: high demand must TIGHTEN discounts. But high demand also
        lifts price via buybacks, which lifts momentum, which RAISES A.
        Aggression weight had to beat that momentum feedback => aggr up.
      - Stake weight gave up the 0.10; its signal is slow-moving and the
        stake-drop scenario still reads clearly through it.
  * Sheet scale 0.25 + 0.75*A -> clamp(0.25 + 1.25*A, 0, 1).
    With the linear form, "rocket holds >=90% of max sheet" required
    A >= 0.867 while aggression sits near max during a rocket — unreachable
    without gutting the aggression term (which the demand invariant needs).
    Momentum also stays >=9000 for ~3 days AFTER the rocket leg ends (the
    +800cp samples age out slowly), while aggression is already pinned at
    10000; worst-case A there is ~0.52 (mom_x 0.85, aggr 10000, stake ~40).
    Slope 1.25 keeps scale >= 0.90 down to A ~0.52 and saturates at A = 0.6,
    while low-A chop days keep a materially smaller sheet.
"""

from metrics import MAX_OFFER_PCT_BPS, clamp

# --- gate -------------------------------------------------------------------
MOMENTUM_GATE = 3_500   # below this the desk stays shut
MOM_X_SPAN = 6_500      # mom_x = (momentum - GATE) / SPAN, so 10000 pins at 1

# --- attractiveness weights (must sum to <= 1) ------------------------------
W_MOM = 0.55
W_AGGR = 0.35
W_STAKE = 0.10

# --- discounts (bps) ----------------------------------------------------------
DISC_BASE = 300
DISC_SPAN = 1_200                      # disc = BASE + A*SPAN + tier bonus
TIER_DISC_BONUS = {"sml": 0, "med": 150, "big": 300}

# --- vesting (trading days) ---------------------------------------------------
VEST_BASE = {"sml": 7, "med": 14, "big": 30}
# vesting = round(BASE * (1.5 - A)): more attractive => shorter lock

# --- sheet sizing ---------------------------------------------------------------
SHEET_SCALE_FLOOR = 0.25   # fraction of the 5% cap at A = 0
SHEET_SCALE_SLOPE = 1.25   # scale = clamp(FLOOR + SLOPE*A, 0, 1); full at A=0.6
VALUE_SPLIT = {"big": 0.50, "med": 0.35, "sml": 0.15}  # of sheet token total
TIER_COUNTS = {"sml": 10, "med": 4, "big": 2}

TIERS = ("sml", "med", "big")


def attractiveness(momentum: int, stake_health: int, aggression: int):
    """A in [0,1] and the mom_x it was built from.

    stake_health is consumed INVERTED (matches the on-chain comment): a high
    score reads as holder complacency and TIGHTENS offers.
    """
    mom_x = clamp((momentum - MOMENTUM_GATE) / MOM_X_SPAN, 0.0, 1.0)
    a = (W_MOM * mom_x
         + W_AGGR * (1.0 - aggression / 10_000)
         + W_STAKE * (1.0 - stake_health / 100))
    return clamp(a, 0.0, 1.0), mom_x


def build_offer_sheet(momentum: int, stake_health: int, aggression: int,
                      vault_balance: float):
    """Return None (empty sheet) when gated, else a dict:

      {a, mom_x, scale, sheet_tokens, tiers: {sml|med|big:
          {lot_size, vesting_days, discount_bps, total_offered}}}
    """
    if momentum == 0 or momentum < MOMENTUM_GATE:
        return None

    a, mom_x = attractiveness(momentum, stake_health, aggression)
    scale = clamp(SHEET_SCALE_FLOOR + SHEET_SCALE_SLOPE * a, 0.0, 1.0)

    # MAX_OFFER_PCT_BPS = 500 -> never more than 5% of the treasury vault.
    sheet_tokens = vault_balance * (MAX_OFFER_PCT_BPS / 10_000) * scale

    tiers = {}
    for t in TIERS:
        tier_tokens = sheet_tokens * VALUE_SPLIT[t]
        tiers[t] = {
            "lot_size": int(tier_tokens / TIER_COUNTS[t]),
            "vesting_days": int(round(VEST_BASE[t] * (1.5 - a))),
            "discount_bps": int(round(DISC_BASE + a * DISC_SPAN + TIER_DISC_BONUS[t])),
            "total_offered": TIER_COUNTS[t],
        }
    return {"a": a, "mom_x": mom_x, "scale": scale,
            "sheet_tokens": sheet_tokens, "tiers": tiers}