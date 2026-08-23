"""Exact Python ports of the on-chain AFHO offer-desk metrics.

Sources (read-only reference, do not modify):
  - programs/amm/src/instructions/make_offers.rs
      calculate_momentum_score, calculate_stake_health, record_stake_ratio,
      offer_accepted_aggression, MAX_OFFER_PCT_BPS
  - programs/amm/src/state/offersState.rs
      MarketMetrics  { price_changes: [i16;20], sample_head: u8,
                       total_staked, total_supply, trailing_stake_health: [u8;5] }
      AcceptedOffers { sml/med/big_offers_accepted: [u8;5] }  (index 0 = oldest)

Integer semantics mirror Rust: division truncates toward zero (NOT Python's
floor), clamps are inclusive, and ring/buffer layouts match the accounts.

Two latent on-chain hazards documented here (behavior ported as *intended*):
  1. offer_accepted_aggression computes `total_weighted * 10000` in u16.
     total_weighted reaches 7*100*35 = 24500, so the multiply overflows u16
     for any acceptance above ~3%. With overflow-checks = true (workspace
     Cargo.toml) the instruction would PANIC once offers start clearing.
     This port computes the intended 0..10000 value in wide arithmetic.
  2. calculate_momentum_score divides by recent_n without guarding it.
     Five consecutive 0.00% days inside the recent window (raw==0 reads as
     "no sample") with >=5 older nonzero samples => recent_n == 0 => Rust
     divide-by-zero panic. The sim's noise makes 5 exact-zero days
     practically impossible, and this port raises ZeroDivisionError exactly
     like Rust would panic.
"""

MAX_OFFER_PCT_BPS = 500  # sheet may not exceed 5% of treasury vault

RING_N = 20           # price_changes ring length (trading days)
MIN_SAMPLES = 5       # cold start: fewer nonzero samples => momentum 0
NEUTRAL = 5_000       # flat momentum score
CP_FULL_SCALE = 500   # 5.00% in centi-percent
SAMPLE_CAP_CP = 1_000  # per-sample clamp +/-10%/day


def tdiv(a: int, b: int) -> int:
    """Truncating (toward-zero) integer division, matching Rust's `/`."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class MetricsState:
    """Mirror of MarketMetrics (only the fields the metrics read)."""

    def __init__(self, total_staked: int, total_supply: int):
        self.price_changes = [0] * RING_N      # i16 ring, centi-percent
        self.sample_head = 0                   # next write index = oldest slot
        self.total_staked = total_staked
        self.total_supply = total_supply
        self.trailing_stake_health = [0] * 5   # whole %, index 0 = oldest


def record_price_change(state: MetricsState, cp: int) -> None:
    """make_offers.record_price_change: write one i16 sample, advance head."""
    v = clamp(cp, -32768, 32767)  # as i16
    head = state.sample_head % RING_N
    state.price_changes[head] = v
    state.sample_head = (head + 1) % RING_N


def current_stake_ratio(state: MetricsState) -> int:
    """staked / total_supply as whole % (u128 truncating division, cast u8)."""
    if state.total_supply == 0:
        return 0
    return ((state.total_staked * 100) // state.total_supply) % 256  # `as u8`


def calculate_stake_health(state: MetricsState) -> int:
    """0-100. Consumed INVERTED by the combiner: high score = complacency."""
    current = current_stake_ratio(state)
    trailing_avg = sum(state.trailing_stake_health) // 5  # u16 truncating div
    adjustment = clamp(current - trailing_avg, -20, 20)
    return clamp(current + adjustment, 0, 100)


def record_stake_ratio(state: MetricsState) -> None:
    """Shift left, append today's ratio at index 4 (index 0 = oldest)."""
    current = current_stake_ratio(state)
    state.trailing_stake_health = state.trailing_stake_health[1:] + [current]


def calculate_momentum_score(state: MetricsState) -> int:
    """0-10000 (5000 = flat). Exact port; see module docstring for hazards."""
    n = len(state.price_changes)
    head = state.sample_head % n

    count = 0
    w_sum = 0
    w_total = 0
    recent_sum = recent_n = 0
    older_sum = older_n = 0

    # age 0 = oldest entry (sample_head = next write = oldest slot)
    for age in range(n):
        raw = state.price_changes[(head + age) % n]
        if raw == 0:
            continue
        v = clamp(raw, -SAMPLE_CAP_CP, SAMPLE_CAP_CP)
        count += 1
        w = age + 1  # newer days weigh more
        w_sum += v * w
        w_total += w
        if age >= n - 5:
            recent_sum += v
            recent_n += 1
        else:
            older_sum += v
            older_n += 1

    if count < MIN_SAMPLES:
        return 0

    weighted_avg = tdiv(w_sum, w_total)
    if older_n > 0:
        # NOTE: Rust panics here if recent_n == 0 (see module docstring).
        trend = tdiv(recent_sum, recent_n) - tdiv(older_sum, older_n)
    else:
        trend = 0  # all samples inside the recent window

    blended = weighted_avg + tdiv(trend, 2)
    return clamp(NEUTRAL + tdiv(blended * NEUTRAL, CP_FULL_SCALE), 0, 10_000)


class AcceptedOffers:
    """Mirror of AcceptedOffers: per-tier [u8;5] whole-% fills, 0 = oldest."""

    def __init__(self):
        self.sml = [0] * 5
        self.med = [0] * 5
        self.big = [0] * 5


def record_accepted(acc: AcceptedOffers, sml_pct: int, med_pct: int, big_pct: int) -> None:
    """Daily shift, same pattern as record_stake_ratio. 0 for empty-sheet days."""
    for ring, pct in ((acc.sml, sml_pct), (acc.med, med_pct), (acc.big, big_pct)):
        ring[:] = ring[1:] + [clamp(int(pct), 0, 100)]


def offer_accepted_aggression(acc: AcceptedOffers) -> int:
    """0-10000 (bps). 0 = dead, 10000 = everything cleared for 5 days."""
    RECENCY_WEIGHTS = [5, 6, 7, 8, 9]   # index 0 = oldest
    TIER_WEIGHTS = [1, 2, 4]            # sml, med, big

    total_weighted = 0
    total_possible = 0
    for tier_idx, samples in enumerate((acc.sml, acc.med, acc.big)):
        for day_idx, pct in enumerate(samples):
            weight = RECENCY_WEIGHTS[day_idx] * TIER_WEIGHTS[tier_idx]
            total_weighted += pct * weight
            total_possible += 100 * weight
    # On-chain this multiply is u16 and overflows (module docstring, hazard 1);
    # here we compute the intended value.
    return (total_weighted * 10000) // total_possible


def self_test() -> bool:
    """Tiny self-test of the ported metrics. Returns True if all pass."""
    ok = True

    def check(name, got, want):
        nonlocal ok
        good = got == want
        ok = ok and good
        print(f"  [{'PASS' if good else 'FAIL'}] {name}: got {got}, want {want}")

    # Momentum of the ring [30,40,...,220] cp with head=0.
    # Exact Rust arithmetic: weighted_avg = tdiv(32900, 210) = 156,
    # trend = 200 - 100 = 100, blended = 156 + 50 = 206, score = 5000 + 2060.
    m = MetricsState(0, 1_000_000)
    m.price_changes = [30 + 10 * i for i in range(20)]
    m.sample_head = 0
    check("momentum ramp ring == 7060 (Rust-exact; spec said ~6980)",
          calculate_momentum_score(m), 7060)

    # Cold start: < 5 nonzero samples -> 0.
    m2 = MetricsState(0, 1_000_000)
    for cp in (200, 200, 200, 200):
        record_price_change(m2, cp)
    check("cold start (4 samples) == 0", calculate_momentum_score(m2), 0)
    record_price_change(m2, 200)
    check("5 samples of +200cp == 7000", calculate_momentum_score(m2), 7000)

    # Per-sample clamp: +40% days pin at +1000cp -> score clamps at 10000.
    m3 = MetricsState(0, 1_000_000)
    for _ in range(20):
        record_price_change(m3, 4000)
    check("+4000cp ring clamps to 10000", calculate_momentum_score(m3), 10_000)
    m4 = MetricsState(0, 1_000_000)
    for _ in range(20):
        record_price_change(m4, -200)
    check("-200cp ring == 3000", calculate_momentum_score(m4), 3000)

    # Stake health: base + (current - trailing) clamped +/-20.
    s = MetricsState(400_000, 1_000_000)
    s.trailing_stake_health = [40] * 5
    check("stake health flat == 40", calculate_stake_health(s), 40)
    s.total_staked = 500_000
    check("stake health rising == 60", calculate_stake_health(s), 60)
    s.total_staked = 700_000
    check("stake health clamp +20 == 90", calculate_stake_health(s), 90)
    record_stake_ratio(s)
    check("record_stake_ratio shifts", s.trailing_stake_health, [40, 40, 40, 40, 70])

    # Aggression: empty = 0, full-clear 5 days = 10000.
    a = AcceptedOffers()
    check("aggression empty == 0", offer_accepted_aggression(a), 0)
    a.sml, a.med, a.big = [100] * 5, [100] * 5, [100] * 5
    check("aggression full == 10000", offer_accepted_aggression(a), 10_000)
    a2 = AcceptedOffers()
    record_accepted(a2, 0, 0, 100)  # only newest day, big tier cleared
    # (100 * 9 * 4) * 10000 / 24500 = 1469 (truncated)
    check("aggression single big clear == 1469", offer_accepted_aggression(a2), 1469)

    return ok


if __name__ == "__main__":
    import sys
    sys.exit(0 if self_test() else 1)