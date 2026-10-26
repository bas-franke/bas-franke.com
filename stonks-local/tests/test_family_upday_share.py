import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["upday_share"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), "look": 4, "enter": 0.75, "exit": 0.5, **params}
    return normalize_spec({"family": "upday_share", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enter": 0.5, "exit": 0.6}})
    rng = random.Random(7)
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


def test_buys_on_many_up_candles_and_sells_when_they_fade():
    #        0   1   2   3   4   5   6   7   8   9  10  11
    path = [10, 11, 12, 11, 12, 13, 14, 13, 12, 11, 12, 11]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all()
    # share over 4 flags: t4 3/4 -> buy; t5 3/4; t6 4/4; t7 3/4; t8 2/4 (>= exit 0.5, keep); t9 1/4 -> sell
    assert list(w[4:10]) == [1, 1, 1, 1, 1, 0]
    assert list(w[10:]) == [0, 0]


def test_btc_scope_and_or_core():
    up = list(range(10, 30))
    down = list(range(30, 10, -1))
    cd = {"BTC-EUR": closes(up), "ETH-EUR": closes(down)}
    w = FAM.targets(cd, spec(markets=("ETH-EUR",), scope="btc"))["ETH-EUR"].to_numpy()
    assert (w[5:] == 1).all()                      # BTC rises every day: ETH held on BTC's signal
    w = FAM.targets(cd, spec(markets=("ETH-EUR",), scope="own"))["ETH-EUR"].to_numpy()
    assert (w[5:] == 0).all()
    w = FAM.targets(cd, spec(markets=("ETH-EUR",), scope="btc", coreLen=3, combine="and"))["ETH-EUR"].to_numpy()
    assert (w[5:] == 0).all()                      # ETH below its SMA: AND says no
    w = FAM.targets(cd, spec(markets=("ETH-EUR",), scope="own", coreLen=3, combine="or"))["ETH-EUR"].to_numpy()
    assert (w[5:] == 0).all()
    w = FAM.targets(cd, spec(markets=("BTC-EUR",), scope="own", coreLen=3, combine="or",
                             enter=0.7, exit=0.7))["BTC-EUR"].to_numpy()
    assert (w[5:] == 1).all()


def test_btc_scope_on_eth_alone_needs_btc_data():
    s = spec(markets=("ETH-EUR",), scope="btc")
    assert "BTC-EUR" in FAM.required_markets(s)
    assert FAM.required_markets(spec(markets=("ETH-EUR",))) == ["ETH-EUR"]
