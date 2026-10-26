import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["kurt_regime"]


def spec(markets=("BTC-EUR",), **params):
    p = {"kurtLen": 5, "kurtMin": 0.0, "mode": "gate", "smaLen": 2, "minHold": 0, **params}
    return normalize_spec({"family": "kurt_regime", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


# calm +-1 % zigzag, one -30 % shock at bar 9, calm again: rolling-5 kurtosis -3.3 (bars 5-8), 4.9 (9-13), -3.3 (14-17)
R = [0.01, -0.01] * 4 + [-0.3] + [0.01, -0.01] * 4
C = list(100 * np.exp(np.concatenate([[0.0], np.cumsum(R)])))


def w(**params):
    return FAM.targets({"BTC-EUR": closes(C)}, spec(**params))["BTC-EUR"].to_numpy()


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(11)
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
    for mode in ("gate", "or_sma", "and_sma"):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], mode=mode, minHold=5))
        assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]


def test_gate_holds_only_in_shock_window():
    v = w()
    assert np.isnan(v[:5]).all()
    assert list(v[5:]) == [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0]


def test_min_hold():
    v = w(minHold=7)
    assert list(v[5:]) == [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0]


def test_sma_modes():
    # SMA2: the close is above it on every up-bar of the zigzag, below on down-bars and on the shock bar
    assert list(w(mode="or_sma")[5:]) == [1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0]
    assert list(w(mode="and_sma")[5:]) == [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0]
