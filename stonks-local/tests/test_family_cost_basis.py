import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["cost_basis"]


def spec(markets=("BTC-EUR",), **params):
    p = {"halfLife": 3, "weighting": "volume", "trend": True, "enterBand": 0.0, "exitBand": 0.0, "topMult": 0.0,
         "topBand": 0.0, **params}
    return normalize_spec({"family": "cost_basis", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def candles(closes, vols=None):
    df = bars([(x, x, x, x) for x in closes])
    if vols is not None:
        df["volume"] = np.asarray(vols, dtype=float)
    return df


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "trend": False, "topMult": 0.0}}) is not None
    rng = random.Random(7)
    cd = {m: synth(800, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for df in cd.values():
        df["volume"] = np.random.default_rng(3).lognormal(0, 0.8, len(df))
    for _ in range(20):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    for extra in ({}, {"weighting": "equal", "topMult": 2.0, "enterBand": 0.02, "exitBand": 0.05},
                  {"trend": False, "topMult": 3.0}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]


def test_trend_buys_above_and_sells_below_the_basis():
    c = [10, 10, 10, 10, 12, 13, 14, 9, 8, 8]
    w = FAM.targets({"BTC-EUR": candles(c)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == [0, 1, 1, 1, 0, 0, 0]


def test_volume_weighting_moves_the_basis():
    # heavy volume at 20 lifts the cost basis, so 15 is below it (sold); the plain average has decayed below 15
    c = [20, 20, 20, 20, 20, 10, 10, 10, 15, 15]
    v = [50, 50, 50, 50, 50, 1, 1, 1, 1, 1]
    vol = FAM.targets({"BTC-EUR": candles(c, v)}, spec(halfLife=2))["BTC-EUR"].to_numpy()
    eq = FAM.targets({"BTC-EUR": candles(c, v)}, spec(halfLife=2, weighting="equal"))["BTC-EUR"].to_numpy()
    assert vol[-1] == 0 and eq[-1] == 1


def test_froth_exit_and_reentry():
    c = [10, 10, 10, 10, 30, 30, 12, 11, 11, 11]
    w = FAM.targets({"BTC-EUR": candles(c)}, spec(trend=False, topMult=1.5, topBand=0.2))["BTC-EUR"].to_numpy()
    assert w[3] == 1 and w[4] == 0
    assert w[-1] == 1


def test_no_look_ahead():
    s = synth(300, 4)
    s["volume"] = np.random.default_rng(1).lognormal(0, 1, 300)
    full = FAM.targets({"BTC-EUR": s}, spec(halfLife=20, topMult=1.3))["BTC-EUR"].to_numpy()
    cut = FAM.targets({"BTC-EUR": s.iloc[:200]}, spec(halfLife=20, topMult=1.3))["BTC-EUR"].to_numpy()
    assert np.array_equal(np.nan_to_num(full[:200], nan=-1), np.nan_to_num(cut, nan=-1))
