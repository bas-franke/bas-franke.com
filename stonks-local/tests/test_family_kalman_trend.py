import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.kalman_trend import slope_tstat

FAM = FAMILIES["kalman_trend"]


def spec(**params):
    return normalize_spec({"family": "kalman_trend", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def rows(xs):
    return {"BTC-EUR": bars([(x, x * 1.01, x * 0.99, x) for x in xs])}


def wiggly(n, drift, seed=0, vol=0.01):
    r = np.random.default_rng(seed).normal(drift, vol, n)
    return list(100.0 * np.exp(np.cumsum(r)))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "zIn": 0.5, "zOut": 1.0}}) is not None
    r = random.Random(11)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec(**{**FAM.default_params(), "mode": "scaled"}))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_tstat_sign_follows_trend():
    up = slope_tstat(np.array(wiggly(200, 0.01, 1)), 0.1, 0.001, 20)
    dn = slope_tstat(np.array(wiggly(200, -0.01, 2)), 0.1, 0.001, 20)
    assert np.nanmean(up[100:]) > 2 and np.nanmean(dn[100:]) < -2


def test_buys_uptrend_sells_downtrend():
    xs = wiggly(120, 0.01, 3) + []
    xs = xs + [xs[-1] * np.exp(-0.015 * (i + 1)) for i in range(60)]
    s = spec(logQLevel=-1.0, logQSlope=-3.0, volHl=15, zIn=1.0, zOut=0.0, mode="binary")
    w = FAM.targets(rows(xs), s)["BTC-EUR"].to_numpy()
    assert np.isnan(w[:30]).all()
    assert w[110] == 1.0
    assert w[-1] == 0.0


def test_scaled_mode_uses_quarters():
    xs = wiggly(300, 0.002, 4, vol=0.02)
    s = spec(logQLevel=-1.0, logQSlope=-3.0, volHl=15, zIn=2.0, zOut=0.0, mode="scaled")
    w = FAM.targets(rows(xs), s)["BTC-EUR"].to_numpy()
    v = w[~np.isnan(w)]
    assert set(np.unique(v)).issubset({0.0, 0.25, 0.5, 0.75, 1.0})


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(logQLevel=-1.3, logQSlope=-3.3, volHl=20, zIn=1.5, zOut=-0.5, mode="binary"),
              spec(logQLevel=-0.5, logQSlope=-2.0, volHl=40, zIn=2.0, zOut=0.0, mode="scaled")):
        full = FAM.targets(cd, s).to_numpy()
        for k in (50, 200, 450):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
            d = cd["BTC-EUR"].copy()
            f = np.random.default_rng(k).uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            np.testing.assert_array_equal(FAM.targets({"BTC-EUR": d}, s).to_numpy()[: k + 1], full[: k + 1])
