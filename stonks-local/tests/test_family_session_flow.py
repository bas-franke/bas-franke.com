import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.session_flow import decision_bars, session_mask

FAM = FAMILIES["session_flow"]
H1 = 3_600_000
T0 = 1_600_041_600_000 - (1_600_041_600_000 % 86_400_000)   # midnight UTC


def spec(**params):
    return normalize_spec({"family": "session_flow", "markets": ["BTC-EUR"], "interval": "1h", "params": params}, FAM)


def hourly(day_moves):
    """day_moves: list of (session_return, other_return) per day; session = 14-21 UTC (7 h)."""
    rows, px = [], 100.0
    for s, o in day_moves:
        for h in range(24):
            r = s / 7 if 14 <= h < 21 else o / 17
            nx = px * np.exp(r)
            rows.append((px, max(px, nx) * 1.001, min(px, nx) * 0.999, nx))
            px = nx
    return {"BTC-EUR": bars(rows, start=T0, step=H1)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(5)
    assert sum(FAM.validate({"params": FAM.sample(r)}) is None for _ in range(40)) == 40
    ex = FAM.explain(spec(signal="clv", trendSma=50, combine="or"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_masks():
    ts = T0 + H1 * np.arange(48)
    m = session_mask(ts, 22, 4)
    assert m[22] and m[23] and m[24] and m[25] and not m[26] and not m[21]
    d = decision_bars(ts, 14, 7, H1)
    assert list(np.nonzero(d)[0]) == [20, 44]


def test_session_signal_only_counts_session():
    # session hours rise, the rest of the day falls more: full-day trend down, session trend up
    days = [(0.02, -0.03)] * 15
    w = FAM.targets(hourly(days), spec(lookback=5))["BTC-EUR"].to_numpy()
    assert np.isnan(w[20])            # not enough history at the first decision
    assert w[-1] == 1.0
    days = [(-0.02, 0.03)] * 15
    w = FAM.targets(hourly(days), spec(lookback=5))["BTC-EUR"].to_numpy()
    assert w[-1] == 0.0


def test_holds_between_decisions_and_sells():
    days = [(0.02, 0.0)] * 10 + [(-0.05, 0.0)] * 6
    w = FAM.targets(hourly(days), spec(lookback=5))["BTC-EUR"].to_numpy()
    d10 = 24 * 9 + 20
    assert w[d10] == 1.0 and w[d10 + 5] == 1.0     # carried until the next decision
    assert w[-1] == 0.0


def test_clv_and_sma_or():
    days = [(0.01, 0.0)] * 30
    w = FAM.targets(hourly(days), spec(signal="clv", lookback=5, enter=0.2))["BTC-EUR"].to_numpy()
    assert w[-1] == 1.0
    days = [(-0.01, 0.0)] * 30
    a = FAM.targets(hourly(days), spec(signal="clv", lookback=5, enter=0.2))["BTC-EUR"].to_numpy()
    assert a[-1] == 0.0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(24 * 120, 4, start=T0, step=H1, drift=0.0001, vol=0.006)}
    for s in (spec(lookback=10, trendSma=20, combine="and"),
              spec(signal="clv", sessStart=22, sessLen=5, lookback=7, enter=0.05, gap=0.05, trendSma=15,
                   combine="or")):
        full = FAM.targets(cd, s).to_numpy()
        for k in (24 * 40 + 3, 24 * 90 + 17):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
