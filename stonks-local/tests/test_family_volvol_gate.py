import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["volvol_gate"]


def spec(**params):
    p = {"coreLen": 0, "measure": "vol", "volLen": 3, "vvLen": 5, "rankLen": 50, "pctMax": 0.9,
         "downOnly": True, **params}
    return normalize_spec({"family": "volvol_gate", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


CALM = [100 * (1.01 if i % 2 else 1.0) for i in range(80)]  # steady +-1 % wiggle


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(2500, 1)}
    for _ in range(10):
        p = FAM.sample(rng)
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        if ok.any():
            assert not np.isnan(v[int(np.argmax(ok)):]).any()
            assert set(np.unique(v[ok])) <= {0.0, 1.0}
    for meas in ("vol", "volvol"):
        ex = FAM.explain(spec(coreLen=50, measure=meas))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_steps_aside_in_a_falling_storm():
    path = CALM + [95, 85, 90, 78, 84, 70, 75, 62]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:52]).all()
    assert (w[53:80] == 1).all()
    assert (w[81:88] == 0).all()


def test_rising_storm_allowed_with_down_only():
    path = CALM + [105, 115, 108, 120, 112, 125, 126, 127]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert (w[80:84] == 1).all()
    w2 = FAM.targets({"BTC-EUR": closes(path)}, spec(downOnly=False))["BTC-EUR"].to_numpy()
    assert (w2[81:84] == 0).all()


def test_core_blocks_downtrend():
    path = [200 - i for i in range(120)]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(coreLen=10))["BTC-EUR"].to_numpy()
    assert (w[np.isfinite(w)] == 0).all()
