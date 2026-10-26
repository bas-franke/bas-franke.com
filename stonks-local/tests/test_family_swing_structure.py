import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["swing_structure"]


def spec(markets=("BTC-EUR",), **params):
    p = {"kEntry": 1, "kExit": 1, "exitBand": 0.0, "trendSma": 0, "useWicks": False, **params}
    return normalize_spec({"family": "swing_structure", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(7)
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
    for extra in ({"exitBand": 0.05, "trendSma": 50, "useWicks": True}, {}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_break_of_structure():
    c = [10, 12, 11, 13, 12, 9, 10, 14]
    w = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    # swing high 12 (j1) known at i2, 13 (j3) at i4; swing low 11 (j2) known at i3, 9 (j5) at i6.
    # i3 13 > 12 -> buy; i4 hold; i5 9 < 11 -> sell; i6 10 < 13 -> out; i7 14 > 13 -> buy.
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == [1, 1, 0, 0, 1]
    # 20 % band: 9 is not below 11 * 0.8, so it holds throughout
    w2 = FAM.targets({"BTC-EUR": closes(c)}, spec(exitBand=0.2))["BTC-EUR"].to_numpy()
    assert list(w2[3:]) == [1, 1, 1, 1, 1]


def test_no_lookahead_in_pivots():
    c = [10, 12, 11, 13, 12, 9, 10, 14]
    full = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    for t in range(4, len(c)):
        part = FAM.targets({"BTC-EUR": closes(c[: t + 1])}, spec())["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(part, full[: t + 1])


def test_multi_market_split():
    up = closes([10, 12, 11, 13, 14, 15])
    flat = closes([10, 10, 10, 10, 10, 10])
    df = FAM.targets({"BTC-EUR": up, "ETH-EUR": flat}, spec(["BTC-EUR", "ETH-EUR"]))
    assert list(df["BTC-EUR"].to_numpy()[3:]) == [0.5, 0.5, 0.5]
    assert (df["ETH-EUR"].to_numpy()[3:] == 0).all()
