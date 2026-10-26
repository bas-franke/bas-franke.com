import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["persist_core"]


def spec(**params):
    p = {"smaLen": 3, "enterBars": 2, "exitBars": 2, **params}
    return normalize_spec({"family": "persist_core", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"smaLen": 5, "enterBars": 0, "exitBars": 1}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(600, 2)}
    for _ in range(10):
        v = FAM.targets(cd, spec(**FAM.sample(rng)))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_one_close_below_does_not_sell_two_do():
    path = [10, 11, 12, 13, 14, 15, 12, 16, 17, 18, 13, 12, 11]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    assert (w[2:10] == 1).all()          # bar 6 (12 < sma 14) is a single close below: still held
    assert w[10] == 1 and w[11] == 0     # two closes in a row below: out


def test_needs_two_closes_above_to_buy():
    path = [20, 19, 18, 17, 16, 18, 15, 14, 16, 17, 18]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert (w[2:9] == 0).all()           # bar 5 (18 > sma 17) alone does not buy
    assert w[9] == 1 and w[10] == 1      # bars 8 and 9 above: in at bar 9


def test_one_one_is_plain_sma():
    c = synth(300, 7)["close"].to_numpy()
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(smaLen=20, enterBars=1, exitBars=1))["BTC-EUR"].to_numpy()
    sma = np.convolve(c, np.ones(20) / 20, mode="valid")
    np.testing.assert_array_equal(w[19:], (c[19:] > sma).astype(float))
