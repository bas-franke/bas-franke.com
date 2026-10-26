import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["relvol_gate"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "relvol_gate", "markets": list(markets), "interval": "1d", "params": params}, FAM)


def path(rets, start=100.0):
    xs = start * np.exp(np.cumsum(rets))
    return bars([(x, x, x, x) for x in xs])


def market(eth_vol_late, n=200, seed=2):
    rng = np.random.default_rng(seed)
    b = rng.normal(0.0, 0.02, n)
    e = np.concatenate([rng.normal(0.0, 0.02, n // 2), rng.normal(0.0, 0.02 * eth_vol_late, n - n // 2)])
    return {"BTC-EUR": path(b), "ETH-EUR": path(e)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "sIn": -0.2, "sOut": 0.1}}) is not None
    assert FAM.markets_needed(spec()) == ["BTC-EUR", "ETH-EUR"]
    rng = random.Random(4)
    assert sum(FAM.validate({"params": FAM.sample(rng)}) is None for _ in range(60)) > 10
    for mode in ("gate", "or_sma", "and_sma"):
        ex = FAM.explain(spec(mode=mode, minHold=3, baseLen=0))
        assert ex["summary"] and len(ex["howItWorks"]) >= 2


def test_raw_ratio_gate():
    cs = market(2.0)                                   # ETH twice as wild in the second half
    w = FAM.targets(cs, spec(volLen=20, baseLen=0, sIn=0.5, sOut=0.3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:20]).all()
    assert w[60] == 0.0                                # ratio ~1
    assert w[-1] == 1.0                                # ratio ~2
    cs2 = {"BTC-EUR": cs["BTC-EUR"], "ETH-EUR": cs["BTC-EUR"]}   # identical moves: ratio exactly 1
    w2 = FAM.targets(cs2, spec(volLen=20, baseLen=0, sIn=0.5, sOut=0.3))["BTC-EUR"].to_numpy()
    assert np.nanmax(w2) == 0.0


def test_relative_baseline_and_split():
    cs = market(0.5, n=300)                            # ETH calms down to half of BTC's volatility
    s = spec(markets=("BTC-EUR", "ETH-EUR"), volLen=20, baseLen=100, sIn=-0.2, sOut=-0.3)
    w = FAM.targets(cs, s)
    assert w["ETH-EUR"].iloc[140] == 0.5 and w["BTC-EUR"].iloc[140] == 0.5
    assert w["BTC-EUR"].iloc[175] == 0.0               # calm ETH vs a baseline that still remembers ratio ~1


def test_or_sma_holds_uptrend_without_appetite():
    n = 200
    b = np.full(n, 0.01) + np.random.default_rng(1).normal(0, 0.002, n)
    cs = {"BTC-EUR": path(b), "ETH-EUR": path(b * 1.0)}
    w = FAM.targets(cs, spec(volLen=20, baseLen=0, sIn=0.5, sOut=0.3, mode="or_sma", smaLen=30))["BTC-EUR"]
    assert w.iloc[-1] == 1.0
    w2 = FAM.targets(cs, spec(volLen=20, baseLen=0, sIn=0.5, sOut=0.3, mode="and_sma", smaLen=30))["BTC-EUR"]
    assert w2.iloc[-1] == 0.0
