import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["psar_core"]


def spec(**params):
    return normalize_spec({"family": "psar_core", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def rows(xs, rng=1.0):
    return {"BTC-EUR": bars([(x, x + rng, x - rng, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "afStart": 0.05, "afMax": 0.03}}) is not None
    r = random.Random(7)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_holds_uptrend_sells_break_rebuys():
    up = [100.0 + 2 * i for i in range(20)]           # steady rise
    crash = [up[-1] - 15 * (i + 1) for i in range(4)]  # sharp fall
    base = crash[-1]
    rebound = [base + 6 * (i + 1) for i in range(10)]  # strong rise again
    xs = up + crash + rebound
    w = FAM.targets(rows(xs), spec(afStart=0.02, afStep=0.02, afMax=0.2, trigger="close", trendSma=0, offWeight=0))
    w = w["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all()
    assert (w[3:20] == 1.0).all()                     # rides the rise
    assert w[21] == 0.0 and w[23] == 0.0               # out after the break
    assert w[-1] == 1.0                                # back in on the rebound


def test_off_weight_and_gate():
    xs = list(np.linspace(300, 100, 60)) + [100.0 + 3 * i for i in range(1, 8)]
    s_gate = spec(afStart=0.02, afStep=0.02, afMax=0.2, trigger="close", trendSma=50, offWeight=0)
    s_free = spec(afStart=0.02, afStep=0.02, afMax=0.2, trigger="close", trendSma=0, offWeight=0)
    s_off = spec(afStart=0.02, afStep=0.02, afMax=0.2, trigger="close", trendSma=0, offWeight=0.3)
    assert FAM.targets(rows(xs), s_free)["BTC-EUR"].to_numpy()[-1] == 1.0   # SAR flipped up
    assert FAM.targets(rows(xs), s_gate)["BTC-EUR"].to_numpy()[-1] == 0.0   # still under SMA50
    w = FAM.targets(rows(xs), s_off)["BTC-EUR"].to_numpy()
    assert w[40] == 0.3                                                    # down trend keeps 30 %


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(afStart=0.01, afStep=0.005, afMax=0.1, trigger="hl", trendSma=50, offWeight=0.2),
              spec(afStart=0.02, afStep=0.02, afMax=0.2, trigger="close", trendSma=0, offWeight=0)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (5, 120, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
            d = cd["BTC-EUR"].copy()                       # scramble the future: the past must not change
            f = np.random.default_rng(k).uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            np.testing.assert_array_equal(FAM.targets({"BTC-EUR": d}, s).to_numpy()[: k + 1], full[: k + 1])
