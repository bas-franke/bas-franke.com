import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["vwap_reversion"]


def spec(**params):
    return normalize_spec({"family": "vwap_reversion", "markets": ["BTC-EUR"], "interval": "4h",
                           "params": params}, FAM)


def test_contract():
    assert not FAM.bot_ready and FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(2)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "entryZ": 1, "exitZ": -1.5}})
    ex = FAM.explain(spec(trendSma=100, maxHold=10))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def flat_then(drop_at, n=40, base=100.0):
    c = np.full(n, base) + np.tile([0.2, -0.2], n // 2)       # small wiggle -> nonzero spread
    c[drop_at:drop_at + 2] = base * 0.9                        # sharp dip
    c[drop_at + 2:] = np.full(n - drop_at - 2, base) + np.tile([0.2, -0.2], n)[: n - drop_at - 2]
    return bars([(x, x, x, x) for x in c])


def test_buys_dip_sells_on_return():
    df = flat_then(20)
    w = FAM.targets({"BTC-EUR": df}, spec(period=5, entryZ=1.5, exitZ=0.0))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:8]).all() and not np.isnan(w[8:]).any()
    assert (w[8:20] == 0).all()
    assert w[20] == 1                       # far below the VWAP: buys
    assert (w[22:] == 0).all()              # back above: sold


def test_trend_filter_blocks_and_time_exit():
    df = flat_then(20)
    w = FAM.targets({"BTC-EUR": df}, spec(period=5, entryZ=1.5, exitZ=0.0, trendSma=15))["BTC-EUR"].to_numpy()
    assert (w[14:] == 0).all()              # the dip is under its SMA: no buy
    w2 = FAM.targets({"BTC-EUR": df}, spec(period=5, entryZ=1.5, exitZ=1.9, maxHold=1))["BTC-EUR"].to_numpy()
    assert w2[20] == 1 and w2[21] == 0      # sold by the time limit, not re-bought inside the same dip


def test_no_lookahead():
    cd = {"BTC-EUR": synth(700, 4)}
    s = spec(period=20, entryZ=1.0, exitZ=0.0, trendSma=50, maxHold=12)
    full = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
    assert (full[~np.isnan(full)] == 1).any()
    for k in (200, 500):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s)["BTC-EUR"].to_numpy(), full[: k + 1])
        d = cd["BTC-EUR"].copy()
        for col in ("open", "high", "low", "close", "volume"):
            x = d[col].to_numpy().copy()
            x[k + 1:] *= 2.5
            d[col] = x
        np.testing.assert_array_equal(FAM.targets({"BTC-EUR": d}, s)["BTC-EUR"].to_numpy()[: k + 1], full[: k + 1])
