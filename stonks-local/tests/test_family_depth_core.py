import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["depth_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"slowLen": 4, "fastLen": 2, "ddShallow": 0.1, "ddDeep": 0.3, "athLook": 0, "exitBand": 0.0, **params}
    return normalize_spec({"family": "depth_core", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(7)
    cd = {m: synth(900, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(20):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.7
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.7 + 1e-12).all()
    for extra in ({"exitBand": 0.05, "athLook": 200}, {}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_level_length_follows_drawdown():
    from stonks_lab.families.depth_core import levels
    c = np.array([10, 10, 10, 10, 9.5, 6, 6.5], dtype=float)
    lv = levels(c, spec()["params"])
    assert np.isnan(lv[:3]).all()
    assert lv[3] == 10                      # dd 0 -> SMA4
    assert abs(lv[4] - np.mean(c[1:5])) < 1e-12   # dd 5 % < 10 % -> SMA4
    assert abs(lv[5] - np.mean(c[4:6])) < 1e-12   # dd 40 % >= 30 % -> SMA2
    assert abs(lv[6] - np.mean(c[5:7])) < 1e-12   # dd 35 % -> SMA2


def test_fast_reentry_deep_slow_exit_near_high():
    c = [10, 10, 10, 11, 10.6, 7, 6, 6.5, 7.2]
    w = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all()
    # i3 11 > SMA4 10.25 -> in. i4 10.6 (dd 3.6 %) vs SMA4 10.4 -> in. i5 7 (dd 36 %) vs SMA2 8.8 -> out.
    # i6 6 < SMA2 6.5 -> out. i7 6.5 > SMA2 6.25 (dd 41 %) -> in (plain SMA4 7.525 would stay out). i8 7.2 > 6.85 in.
    assert list(w[3:]) == [1, 1, 0, 0, 1, 1]
    plain = FAM.targets({"BTC-EUR": closes(c)}, spec(fastLen=4))["BTC-EUR"].to_numpy()
    assert list(plain[3:]) == [1, 1, 0, 0, 0, 1]   # plain SMA4 re-enters one bar later


def test_multi_market_split():
    up = closes([10, 10, 10, 11, 12, 13])
    flat = closes([10, 10, 10, 10, 10, 10])
    df = FAM.targets({"BTC-EUR": up, "ETH-EUR": flat}, spec(["BTC-EUR", "ETH-EUR"]))
    assert list(df["BTC-EUR"].to_numpy()[3:]) == [0.5, 0.5, 0.5]
    assert (df["ETH-EUR"].to_numpy()[3:] == 0).all()
