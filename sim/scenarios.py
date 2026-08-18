"""Scenario definitions: 40 simulated trading days each.

A scenario supplies, per trading day d (1-based):
  base_ret_cp(d, rng) -> float   daily price return in centi-percent (+200 = +2%)
  base_demand                    acceptance model base fill %
  stake_target(d) -> float       staking ratio mean-reversion target, %

Chop/flat periods use small nonzero gaussian noise on purpose: the on-chain
metric treats a genuine 0.00% day as "no sample", so exact zeros would
freeze the cold-start counter (see metrics.py docstring).
"""


class Scenario:
    def __init__(self, name, base_ret_cp, base_demand=50.0, stake_target=None):
        self.name = name
        self.base_ret_cp = base_ret_cp
        self.base_demand = base_demand
        self._stake_target = stake_target or (lambda d: 40.0)

    def stake_target(self, d):
        return self._stake_target(d)


def _g(mu, sigma):
    return lambda d, rng: rng.gauss(mu, sigma)


def build_scenarios():
    """The 7 spec scenarios. The demand pair (#7) is two entries."""
    def wash_ret(d, rng):
        # single +40% wash pump mid-chop; the metric clamps it to +1000cp.
        # noise is drawn every day so paired runs share the rng stream
        noise = rng.gauss(0.0, 50.0)
        return 4000.0 if d == 20 else noise

    def rocket_ret(d, rng):
        return 800.0 + rng.gauss(0.0, 30.0) if d <= 10 else rng.gauss(0.0, 50.0)

    def crash_ret(d, rng):
        return -1200.0 + rng.gauss(0.0, 30.0) if d <= 3 else rng.gauss(0.0, 15.0)

    return [
        Scenario("bull", _g(200.0, 30.0)),
        Scenario("bear", _g(-200.0, 30.0)),
        Scenario("crash", crash_ret),
        Scenario("wash-pump", wash_ret),
        Scenario("rocket", rocket_ret),
        Scenario("bull-stake-drop", _g(200.0, 30.0),
                 stake_target=lambda d: 40.0 if d <= 20 else 25.0),
        Scenario("bull-low-demand", _g(200.0, 30.0), base_demand=20.0),
        Scenario("bull-high-demand", _g(200.0, 30.0), base_demand=80.0),
    ]