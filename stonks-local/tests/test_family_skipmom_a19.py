import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["skipmom_a19"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), "look": 4, "skip": 2, "band": 0.0, **params}
    return normalize_spec({"family": "skipmom_a19", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "look": 10, "skip": 10}})
    rng = random.Random(7)
    cd = {"BTC-EUR": synth(800, 2), "ETH-EUR": synth(800, 3)}
    for _ in range(10):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}):
            continue
        df = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p))
        v = df.to_numpy()
        ok = np.isfinite(v).all(axis=1)
        assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
        assert (v[np.isfinite(v)] <= 0.5 + 1e-12).all()
    assert FAM.explain(spec())["summary"]


def test_ignores_recent_candles():
    #        0   1   2   3   4   5   6   7   8
    path = [10, 11, 12, 13, 14, 8, 7, 12, 11]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all()
    # t=4: ln(c2/c0) > 0 -> in; t=5,6: c3/c1, c4/c2 > 0 -> still in despite the crash at 5-6
    assert list(w[4:7]) == [1.0, 1.0, 1.0]
    # t=7: c5/c3 = 8/13 < 0 -> out; t=8: c6/c4 = 7/14 -> out
    assert list(w[7:9]) == [0.0, 0.0]


def test_skip_zero_is_plain_momentum_and_band_holds_state():
    path = [10, 11, 12, 13, 14, 8, 7, 12, 11]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(skip=0))["BTC-EUR"].to_numpy()
    assert list(w[4:9]) == [1.0, 0.0, 0.0, 0.0, 0.0]  # 14/10, 8/11, 7/12, 12/13, 11/14
    # band 0.3: t=4 ln(1.4)=0.34 > 0.3 -> in; t=5 ln(8/11)=-0.32 < -0.3 -> out; t=7 ln(12/13) inside band -> stays out
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(skip=0, band=0.3))["BTC-EUR"].to_numpy()
    assert list(w[4:9]) == [1.0, 0.0, 0.0, 0.0, 0.0]
    path2 = [10, 10, 10, 10, 14, 12, 11, 12, 13]  # t=5 ln(12/10)=.18 inside band -> stays in
    w = FAM.targets({"BTC-EUR": closes(path2)}, spec(skip=0, band=0.3))["BTC-EUR"].to_numpy()
    assert list(w[4:6]) == [1.0, 1.0]
