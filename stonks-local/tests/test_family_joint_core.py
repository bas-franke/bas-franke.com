import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["joint_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"ownSma": 3, "peerSma": 3, "mode": "or", **params}
    return normalize_spec({"family": "joint_core", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(11)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(20):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        for mk in (["BTC-EUR"], ["ETH-EUR"], ["BTC-EUR", "ETH-EUR"]):
            s = spec(mk, **p)
            s["risk"]["maxWeight"] = 0.6
            v = FAM.targets(cd, s).to_numpy()
            rows = ~np.isnan(v).all(axis=1)
            if rows.any():
                first = int(np.argmax(rows))
                assert not np.isnan(v[first:]).any()
                assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    for mode in ("or", "and", "own"):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], mode=mode))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_modes():
    btc = closes([10, 10, 10, 11, 12, 9, 8, 8, 8])     # own above SMA3 at i3, i4; below from i5
    eth = closes([10, 10, 10, 11, 12, 13, 14, 10, 9])  # peer above SMA3 i3..i6, below from i7
    cd = {"BTC-EUR": btc, "ETH-EUR": eth}
    own = FAM.targets(cd, spec(mode="own"))["BTC-EUR"].to_numpy()
    orr = FAM.targets(cd, spec(mode="or"))["BTC-EUR"].to_numpy()
    andd = FAM.targets(cd, spec(mode="and"))["BTC-EUR"].to_numpy()
    assert np.isnan(own[:2]).all()
    assert list(own[2:]) == [0, 1, 1, 0, 0, 0, 0]
    assert list(orr[2:]) == [0, 1, 1, 1, 1, 0, 0]
    assert list(andd[2:]) == [0, 1, 1, 0, 0, 0, 0]
    # ETH traded with BTC as peer, and mode: ETH up i3..i6 but BTC only i3..i4
    e_and = FAM.targets(cd, spec(["ETH-EUR"], mode="and"))["ETH-EUR"].to_numpy()
    assert list(e_and[2:]) == [0, 1, 1, 0, 0, 0, 0]


def test_pair_split():
    up = closes([10, 10, 10, 11, 12, 13])
    flat = closes([10, 10, 10, 10, 10, 10])
    df = FAM.targets({"BTC-EUR": up, "ETH-EUR": flat}, spec(["BTC-EUR", "ETH-EUR"], mode="or"))
    # or: ETH is held too because its peer BTC trends up
    assert list(df["BTC-EUR"].to_numpy()[3:]) == [0.5, 0.5, 0.5]
    assert list(df["ETH-EUR"].to_numpy()[3:]) == [0.5, 0.5, 0.5]
