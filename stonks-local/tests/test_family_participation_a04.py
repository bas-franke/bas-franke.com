import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["participation_a04"]


def spec(**params):
    p = {"volShort": 5, "volLong": 20, "exitV": -0.3, "enterV": 0.0, "combine": "none", "coreLen": 10, **params}
    return normalize_spec({"family": "participation_a04", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def candles(close, volume):
    df = bars([(x, x, x, x) for x in close])
    df["volume"] = np.asarray(volume, dtype=np.float64)
    return {"BTC-EUR": df}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enterV": -0.5, "exitV": 0.0}})
    assert FAM.validate({"params": {**FAM.default_params(), "volShort": 100, "volLong": 90}})
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(800, 3)}
    cd["BTC-EUR"]["volume"] = np.random.default_rng(1).lognormal(0, 0.5, 800)
    for _ in range(10):
        p = FAM.sample(rng)
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    assert len(FAM.explain(spec(combine="and"))["howItWorks"]) >= 3


def test_steps_aside_when_volume_dries_up_and_returns_when_it_comes_back():
    vol = [10.0] * 30 + [2.0] * 15 + [30.0] * 15
    c = [100.0] * 60
    w = FAM.targets(candles(c, vol), spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:19]).all()
    assert (w[19:30] == 1).all()                 # flat volume: ratio 0 > exit
    assert w[34] == 0 and w[44] == 0             # 5-day volume 2 vs ~10 long: ln < -0.3
    assert w[-1] == 1                            # heavy volume again


def test_and_core_blocks_when_under_sma():
    path = list(np.linspace(100, 200, 40)) + list(np.linspace(200, 120, 20))
    vol = [10.0] * 60
    w_none = FAM.targets(candles(path, vol), spec())["BTC-EUR"].to_numpy()
    w_and = FAM.targets(candles(path, vol), spec(combine="and"))["BTC-EUR"].to_numpy()
    assert w_none[-1] == 1 and w_and[-1] == 0
