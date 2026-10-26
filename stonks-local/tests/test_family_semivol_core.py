import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.semivol_core import upside_share

FAM = FAMILIES["semivol_core"]


def spec(**params):
    return normalize_spec({"family": "semivol_core", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def rows(xs):
    return {"BTC-EUR": bars([(x, x * 1.01, x * 0.99, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(3)
    ok = 0
    for _ in range(60):
        p = FAM.sample(r)
        if FAM.validate({"params": p}) is None:
            ok += 1
    assert ok > 20
    ex = FAM.explain(spec(trendSma=50, combine="or"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_share():
    c = np.array([100.0, 110.0, 99.0, 108.9])   # +10 %, -10 %, +10 %
    s = upside_share(c, 2)
    assert np.isnan(s[1])
    u, d = np.log(1.1) ** 2, np.log(0.9) ** 2
    assert abs(s[2] - u / (u + d)) < 1e-12 and s[2] < 0.5


def test_buys_rally_sells_crash():
    xs = [100.0 * 1.01 ** i for i in range(20)] + [120.0, 100.0, 85.0, 80.0]
    w = FAM.targets(rows(xs), spec(lookback=5, enter=0.6, gap=0.1))["BTC-EUR"].to_numpy()
    assert np.isnan(w[4]) and w[10] == 1.0
    assert w[-1] == 0.0


def test_sma_and_or():
    xs = list(np.linspace(200, 100, 40)) + [100 * 1.02 ** i for i in range(8)]
    a = FAM.targets(rows(xs), spec(lookback=5, enter=0.6, gap=0.1, trendSma=30, combine="and"))["BTC-EUR"].to_numpy()
    o = FAM.targets(rows(xs), spec(lookback=5, enter=0.6, gap=0.1, trendSma=30, combine="or"))["BTC-EUR"].to_numpy()
    assert a[-1] == 0.0 and o[-1] == 1.0   # rally under the falling SMA: only "or" buys


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(lookback=20, enter=0.55, gap=0.05, trendSma=50, combine="and"),
              spec(lookback=60, enter=0.5, gap=0.0, trendSma=0)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (120, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
