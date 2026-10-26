import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["depth_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"slowLen": 4, "fastLen": 2, "depth": 0.3, "highLen": 4, "confirmBars": 1, **params}
    return normalize_spec({"family": "depth_core", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(7)
    cd = {m: synth(900, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
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
    for extra in ({"depth": 0.0}, {"confirmBars": 3}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_fast_average_after_crash():
    c = [10, 10, 10, 10, 6, 5, 5.5, 6.5, 7]
    w = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all()
    # i3 10 = SMA4 10 -> not above, out. i4 6 < 0.7*10 deep, SMA2 8 -> out. i5 5 SMA2 5.5 out.
    # i6 5.5 deep (high 10), SMA2 5.25 -> in. i7 6.5 deep (high 10, 6.5 < 7), SMA2 6 -> in. i8 7 (high 6.5..: max 7) not deep,
    # SMA4 (5,5.5,6.5,7)=6 -> in.
    assert list(w[3:]) == [0, 0, 0, 1, 1, 1]
    # without the depth switch the slow SMA4 decides: i6 5.5 < SMA4 (10,6,5,5.5)=6.625 out; i7 6.5 < 5.75? no: SMA4
    # (6,5,5.5,6.5)=5.75 -> in; i8 in.
    w0 = FAM.targets({"BTC-EUR": closes(c)}, spec(depth=0.0))["BTC-EUR"].to_numpy()
    assert list(w0[3:]) == [0, 0, 0, 0, 1, 1]


def test_confirm_bars():
    c = [10, 10, 10, 11, 12, 10.5, 12, 10, 9.9, 9]
    # depth 0: SMA4 core. i3 11 > 10.25 in, i4 in, i5 10.5 < SMA4 10.875: 1 bar below; i6 12 above;
    # i7 10 < 11.375 (1), i8 9.9 < 10.6 (2) -> out with confirmBars 2.
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(depth=0.0, confirmBars=2))["BTC-EUR"].to_numpy()
    assert list(w[3:]) == [1, 1, 1, 1, 1, 0, 0]
    w1 = FAM.targets({"BTC-EUR": closes(c)}, spec(depth=0.0, confirmBars=1))["BTC-EUR"].to_numpy()
    assert list(w1[3:]) == [1, 1, 0, 1, 0, 0, 0]


def test_multi_market_split():
    up = closes([10, 10, 10, 11, 12, 13])
    flat = closes([10, 10, 10, 10, 10, 10])
    df = FAM.targets({"BTC-EUR": up, "ETH-EUR": flat}, spec(["BTC-EUR", "ETH-EUR"], depth=0.0))
    assert list(df["BTC-EUR"].to_numpy()[3:]) == [0.5, 0.5, 0.5]
    assert (df["ETH-EUR"].to_numpy()[3:] == 0).all()
