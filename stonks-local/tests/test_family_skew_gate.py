import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["skew_gate"]


def spec(**params):
    p = {"skewLen": 20, "exitSkew": 1.0, "enterSkew": 0.0, "combine": "none", "coreLen": 10, **params}
    return normalize_spec({"family": "skew_gate", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enterSkew": 2.0, "exitSkew": 1.0}})
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(800, 3)}
    for _ in range(10):
        p = FAM.sample(rng)
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    assert len(FAM.explain(spec(combine="and"))["howItWorks"]) >= 3


def test_steps_aside_after_a_lottery_spike_and_returns_after_a_crash():
    rng = np.random.default_rng(0)
    r = list(rng.normal(0, 0.01, 40))            # calm: skew ~0, held
    r += [0.25] + list(rng.normal(0, 0.01, 10))  # one huge up day: strongly right-skewed -> out
    r += [-0.25] + list(rng.normal(0, 0.01, 30))  # one huge down day: skew drops -> back in
    c = 100 * np.exp(np.cumsum([0.0] + r))
    w = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:20]).all()
    assert (w[21:41] == 1).all()
    assert (w[42:51] == 0).all()
    assert (w[53:] == 1).all()


def test_and_core_blocks_when_under_sma():
    path = list(np.linspace(100, 200, 40)) + list(np.linspace(200, 120, 20))
    w_none = FAM.targets({"BTC-EUR": closes(path)}, spec(exitSkew=3.0))["BTC-EUR"].to_numpy()
    w_and = FAM.targets({"BTC-EUR": closes(path)}, spec(exitSkew=3.0, combine="and"))["BTC-EUR"].to_numpy()
    assert w_none[-1] == 1 and w_and[-1] == 0
