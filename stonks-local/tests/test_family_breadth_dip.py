import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["breadth_dip"]
DIP = [10, 11, 12, 11, 10, 9, 10, 11, 12, 13]   # RSI(2) from i=2: 100, 50, 25, 12.5, 56.25, 78.1, ...


def spec(markets=("BTC-EUR",), **params):
    p = {"rsiPeriod": 2, "rsiBelow": 30, "breadthMin": 0.6, "sellAbove": 70, "maxHold": 0, "coreSma": 0, **params}
    return normalize_spec({"family": "breadth_dip", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "rsiBelow": 40, "sellAbove": 40}})
    rng = random.Random(5)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR"])}
    for _ in range(15):
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
    assert set(FAM.markets_needed(spec())) >= {"BTC-EUR", "ETH-EUR", "AVAX-EUR"}
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], maxHold=10, coreSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_buys_market_wide_dip_and_sells_after_rebound():
    cd = {m: closes(DIP) for m in ["BTC-EUR", "ETH-EUR", "SOL-EUR"]}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    assert list(w[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]


def test_lonely_dip_is_ignored():
    cd = {"BTC-EUR": closes(DIP), "ETH-EUR": closes([10] * 10), "SOL-EUR": closes([10] * 10)}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert (w[2:] == 0).all()   # only 1 of 3 coins oversold
    w2 = FAM.targets(cd, spec(breadthMin=0.3))["BTC-EUR"].to_numpy()
    assert list(w2[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]


def test_max_hold_and_split():
    cd = {m: closes(DIP) for m in ["BTC-EUR", "ETH-EUR", "SOL-EUR"]}
    w = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], maxHold=1)).to_numpy()
    # buys at i4, held 1 bar at i5 -> out; i5 is itself a capitulation bar but the exit happens there
    np.testing.assert_allclose(w[2:, 0], [0, 0, .5, 0, 0, 0, 0, 0])
    np.testing.assert_allclose(w[2:, 1], w[2:, 0])


def test_core_trend_holds_outside_dips():
    up = list(range(1, 11))
    cd = {"BTC-EUR": closes(up), "ETH-EUR": closes(up), "SOL-EUR": closes(up)}
    w = FAM.targets(cd, spec(coreSma=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all() and (w[2:] == 1).all()
    w0 = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert (w0[2:] == 0).all()
