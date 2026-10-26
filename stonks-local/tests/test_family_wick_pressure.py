import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["wick_pressure"]

UPPER = (10, 12, 9.9, 10)    # imbalance (2 - 0.1) / 2.1 = +0.905: rally sold off
LOWER = (10, 10.1, 8, 10)    # (0.1 - 2) / 2.1 = -0.905: dip bought
FLAT = (10, 10, 10, 10)      # 0


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), "look": 2, "exitAbove": 0.5, "reenter": -0.5, **params}
    return normalize_spec({"family": "wick_pressure", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "exitAbove": 0.0, "reenter": 0.05}})
    rng = random.Random(8)
    cd = {"BTC-EUR": synth(800, 2), "ETH-EUR": synth(800, 3)}
    for _ in range(10):
        p = FAM.sample(rng)
        df = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p))
        v = df.to_numpy()
        ok = np.isfinite(v).all(axis=1)
        assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
        assert (v[np.isfinite(v)] <= 0.5 + 1e-12).all()
    ex = FAM.explain(spec(coreLen=20))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3
    assert "BTC-EUR" in FAM.required_markets(spec(markets=("ETH-EUR",), scope="btc"))


def test_sells_on_upper_wicks_and_buys_back_on_lower_wicks():
    rows = [FLAT, FLAT, UPPER, FLAT, UPPER, UPPER, FLAT, LOWER, LOWER, FLAT]
    w = FAM.targets({"BTC-EUR": bars(rows)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[0])
    # pressure (look 2): t1 0, t2 .45, t3 .45, t4 .45, t5 .9 -> sell, t6 .45 (stay out), t7 0, t8 -.9 -> buy, t9 -.45
    assert list(w[1:]) == [1, 1, 1, 1, 0, 0, 0, 1, 1]


def test_btc_scope_and_core():
    eth = bars([FLAT] * 6)
    btc = bars([FLAT, UPPER, UPPER, UPPER, UPPER, UPPER])
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(markets=("ETH-EUR",), scope="btc"))["ETH-EUR"].to_numpy()
    assert list(w[2:]) == [0, 0, 0, 0]
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(markets=("ETH-EUR",)))["ETH-EUR"].to_numpy()
    assert list(w[2:]) == [1, 1, 1, 1]
    # OR with a core: rising closes keep it invested despite the wicks
    up = bars([(10 + i, 12 + i, 9.9 + i, 10 + i) for i in range(6)])
    w = FAM.targets({"BTC-EUR": up}, spec(coreLen=2, combine="or"))["BTC-EUR"].to_numpy()
    assert list(w[2:]) == [1, 1, 1, 1]
    w = FAM.targets({"BTC-EUR": up}, spec(coreLen=2, combine="and"))["BTC-EUR"].to_numpy()
    assert list(w[2:]) == [0, 0, 0, 0]
