import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["chop_core_a07"]


def spec(**params):
    p = {"smaLen": 2, "lookback": 4, "maxCross": 2, "mode": "hold", **params}
    return normalize_spec({"family": "chop_core_a07", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "mode": "x"}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(600, 2)}
    for _ in range(10):
        v = FAM.targets(cd, spec(**FAM.sample(rng)))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_chop_holds_then_trend_down_exits():
    # SMA2 above/below: 10,12 up; 11 (below sma 11.5); 13 above; 12 below -> 3 crosses in 4 bars = choppy
    path = [10, 12, 11, 13, 12, 13, 14, 15, 14, 13, 12, 11, 10, 9]
    above = FAM.targets({"BTC-EUR": closes(path)}, spec(maxCross=99))["BTC-EUR"].to_numpy()   # plain core
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert above[2] == 0 and above[4] == 0            # the plain core sells on those closes
    assert w[4] == 1                                  # chop (>= 2 crosses in 4 bars): held
    assert above[-1] == 0 and w[-1] == 0              # steady fall, crosses thin out: out like the core


def test_freeze_keeps_position():
    path = [10, 12, 11, 13, 12, 13, 12, 13, 12]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(mode="freeze", maxCross=2))["BTC-EUR"].to_numpy()
    core = FAM.targets({"BTC-EUR": closes(path)}, spec(maxCross=99))["BTC-EUR"].to_numpy()
    assert (np.diff(core[1:]) != 0).sum() > (np.diff(w[1:]) != 0).sum()


def test_huge_maxcross_is_plain_sma():
    c = synth(300, 7)["close"].to_numpy()
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(smaLen=20, lookback=10, maxCross=12))["BTC-EUR"].to_numpy()
    sma = np.convolve(c, np.ones(20) / 20, mode="valid")
    np.testing.assert_array_equal(w[19:], (c[19:] > sma).astype(float))
