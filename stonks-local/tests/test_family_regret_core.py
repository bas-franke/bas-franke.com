import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["regret_core"]


def spec(**params):
    p = {"coreLen": 4, "maType": "sma", "exitBand": 0.0, "regretPct": 0.02, "regretStop": 0.05, "maxRegrets": 1,
         **params}
    return normalize_spec({"family": "regret_core", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def run(path, **kw):
    return FAM.targets({"BTC-EUR": closes(path)}, spec(**kw))["BTC-EUR"].to_numpy()


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(800, 2)}
    for _ in range(10):
        p = FAM.sample(rng)
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_off_is_plain_sma_core():
    path = [10, 11, 12, 13, 14, 15, 11, 10.5, 11.5, 12, 9, 8]
    w = run(path, regretPct=0)
    sma = np.convolve(path, np.ones(4) / 4, "valid")
    want = (np.asarray(path[3:]) > sma).astype(float)
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == list(want)


def test_buys_back_above_exit_price_under_the_ma():
    # rally, drop under the SMA (exit at 11), bounce to 11.3 (>= 11*1.02) while still under the SMA: back in
    path = [10, 12, 14, 16, 18, 11, 11.3, 11.4]
    w = run(path)
    assert w[4] == 1 and w[5] == 0          # sold at 11
    sma6 = np.mean(path[3:7])
    assert path[6] < sma6                   # still under the average ...
    assert w[6] == 1                        # ... but back in on regret


def test_regret_stop_and_cap():
    # exit at 11, regret buy at 11.3, stop below 11*0.95=10.45, new anchor 10.4; cap of 1 blocks the next regret
    path = [10, 12, 14, 16, 18, 11, 11.3, 10.4, 10.7, 10.8]
    w = run(path)
    assert list(w[5:]) == [0, 1, 0, 0, 0]
    w2 = run(path, maxRegrets=2)
    assert list(w2[5:]) == [0, 1, 0, 1, 1]  # 10.7 >= 10.4*1.02: second regret allowed
