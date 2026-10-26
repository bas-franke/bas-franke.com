import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["trough_reentry"]


def spec(markets=("BTC-EUR",), **params):
    p = {"coreSma": 3, "band": 0.0, "rebound": 0.2, "minDrop": 0.0, "stop": 0.1, "holdBars": 0, **params}
    return normalize_spec({"family": "trough_reentry", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
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
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], band=0.02, minDrop=0.2, holdBars=10))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_core_and_early_reentry():
    c = [8, 9, 10, 11, 12, 8, 6, 7.3, 7.4, 7.5, 7.6]
    sp = spec(coreSma=5)
    w = FAM.targets({"BTC-EUR": closes(c)}, sp)["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all()
    # i4 core; i5 8 < SMA 10 out (trough 8); i6 trough 6; i7 7.3 >= 7.2 rebound in (SMA 8.86); i9 core takes over
    assert list(w[4:]) == [1, 0, 0, 1, 1, 1, 1]
    w2 = FAM.targets({"BTC-EUR": closes(c)}, spec(coreSma=5, rebound=0.5))["BTC-EUR"].to_numpy()
    assert list(w2[4:]) == [1, 0, 0, 0, 0, 1, 1]


def test_stop_and_min_drop():
    c = [16, 18, 20, 22, 24, 10, 12.1, 10.5, 10.5, 10.5]
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(coreSma=5))["BTC-EUR"].to_numpy()
    # i5 out (trough 10); i6 12.1 >= 12 in; i7 10.5 < 12.1 * 0.9 stopped, trough restarts at 10.5
    assert list(w[4:]) == [1, 0, 1, 0, 0, 0]
    # the trough (10) is 58 % under the 5-candle high (24): minDrop 0.5 allows it, 0.6 does not
    w2 = FAM.targets({"BTC-EUR": closes(c)}, spec(coreSma=5, minDrop=0.5))["BTC-EUR"].to_numpy()
    assert list(w2[4:]) == [1, 0, 1, 0, 0, 0]
    w3 = FAM.targets({"BTC-EUR": closes(c)}, spec(coreSma=5, minDrop=0.6))["BTC-EUR"].to_numpy()
    assert list(w3[4:]) == [1, 0, 0, 0, 0, 0]


def test_hold_bars_and_band():
    c = [16, 18, 20, 22, 24, 10, 12.1, 12.2, 12.3, 11, 11]
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(coreSma=5, holdBars=2))["BTC-EUR"].to_numpy()
    # in at i6, held i7 (1), i8 (2) -> out at i8; trough restarts at 12.3
    assert list(w[4:]) == [1, 0, 1, 1, 0, 0, 0]
    # band: a close just above the SMA does not enter the core
    c2 = [10, 10, 10, 10.1, 10.2, 10.3]
    w2 = FAM.targets({"BTC-EUR": closes(c2)}, spec(coreSma=3, band=0.05, rebound=0.5))["BTC-EUR"].to_numpy()
    assert (w2[2:] == 0).all()
    w3 = FAM.targets({"BTC-EUR": closes(c2)}, spec(coreSma=3, rebound=0.5))["BTC-EUR"].to_numpy()
    assert list(w3[2:]) == [0, 1, 1, 1]
