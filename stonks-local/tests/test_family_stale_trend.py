import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["stale_trend"]


def spec(**params):
    p = {"coreLen": 0, "hiLook": 5, "staleBars": 3, **params}
    return normalize_spec({"family": "stale_trend", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"coreLen": 0, "hiLook": 5, "staleBars": 0}})
    rng = random.Random(6)
    cd = {"BTC-EUR": synth(800, 2)}
    for _ in range(10):
        p = FAM.sample(rng)
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    ex = FAM.explain(spec(coreLen=20))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_sells_a_stale_trend_and_buys_the_next_high():
    path = list(range(10, 20)) + [18.5, 18.6, 18.7, 18.8, 18.9, 20, 21]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(hiLook=8))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:7]).all()
    assert (w[7:10] == 1).all()
    assert list(w[10:15]) == [1, 1, 1, 0, 0]   # 3 bars without a new high allowed, the 4th sells
    assert (w[15:] == 1).all()                 # new high: back in


def test_core_only_matches_sma():
    path = list(range(1, 15)) + [10, 9, 8]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(coreLen=4, staleBars=0))["BTC-EUR"].to_numpy()
    assert (w[4:14] == 1).all() and (w[15:] == 0).all()
