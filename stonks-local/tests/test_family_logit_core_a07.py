import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["logit_core_a07"]


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "logit_core_a07", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enter": 0.5, "exit": 0.55}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(900, 2)}
    for _ in range(5):
        v = FAM.targets(cd, spec(**FAM.sample(rng)))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 1.0}
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_learns_steady_uptrend_and_holds():
    c = 100 * np.exp(0.01 * np.arange(700) + 0.002 * np.sin(np.arange(700)))
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(horizon=10, refit=10))["BTC-EUR"].to_numpy()
    ok = np.isfinite(w)
    assert ok.sum() > 100 and (w[ok] == 1).all()


def test_learns_trend_sign_and_sells_in_a_downtrend():
    # up/down regimes of 120 bars: positive 60-bar return predicts more rise, negative predicts fall
    seg = np.r_[np.full(120, 0.01), np.full(120, -0.01)]
    r = np.tile(seg, 6) + 0.001 * np.cos(np.arange(1440))
    c = 100 * np.exp(np.cumsum(r))
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(horizon=5, refit=5, features="trend", l2=0.1))["BTC-EUR"].to_numpy()
    late = np.arange(1440) >= 900
    ups = late & (r > 0)
    dns = late & (r < 0)
    assert np.nanmean(w[ups]) > 0.7 and np.nanmean(w[dns]) < 0.3


def test_no_lookahead_in_probabilities():
    c = synth(800, 5)["close"].to_numpy()
    p = FAM.module.probabilities(c, spec()["params"])
    q = FAM.module.probabilities(c[:600], spec()["params"])
    np.testing.assert_allclose(p[:600], q, equal_nan=True)
