import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["asym_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"maType": "sma", "enterLen": 2, "exitLen": 4, "exitBand": 0.0, **params}
    return normalize_spec({"family": "asym_core", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(20):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    for extra in ({"exitBand": 0.05, "maType": "ema"}, {}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_fast_in_slow_out():
    c = [10, 10, 10, 11, 10.6, 10.2, 9, 8, 8.5, 9.6, 10]
    w = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all()
    # i3 11 > SMA2 10.5, SMA4 10.25 -> in. i4 10.6 < SMA2 10.8 but >= SMA4 10.4 -> still in (slow exit).
    # i5 10.2 < SMA4 10.45 -> out. i6/i7 below. i8 8.5 > SMA2 8.25 but < SMA4 8.925 -> no buy.
    # i9 9.6 > SMA2 9.05 and >= SMA4 8.775 -> in. i10 in.
    assert list(w[3:]) == [1, 1, 0, 0, 0, 0, 1, 1]
    # with a 5 % exit band i5 (10.2 vs 10.45 * 0.95 = 9.93) stays in; i6 9 < SMA4 10.2 * 0.95 -> out; i8 8.5 >= 8.925 * 0.95 and > SMA2 -> back in
    w2 = FAM.targets({"BTC-EUR": closes(c)}, spec(exitBand=0.05))["BTC-EUR"].to_numpy()
    assert list(w2[3:]) == [1, 1, 1, 0, 0, 1, 1, 1]


def test_multi_market_split():
    up = closes([10, 10, 10, 11, 12, 13])
    flat = closes([10, 10, 10, 10, 10, 10])
    df = FAM.targets({"BTC-EUR": up, "ETH-EUR": flat}, spec(["BTC-EUR", "ETH-EUR"]))
    assert list(df["BTC-EUR"].to_numpy()[3:]) == [0.5, 0.5, 0.5]
    assert (df["ETH-EUR"].to_numpy()[3:] == 0).all()
