import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["core_dip"]
DIP = [10, 11, 12, 11, 10, 9, 10, 11, 12, 13]   # RSI(2) from i=2: 100, 50, 25, 12.5, 56.25, 78.1, ...


def spec(markets=("BTC-EUR",), **params):
    p = {"rsiPeriod": 2, "rsiBelow": 30, "sellAbove": 70, "maxHold": 0, "coreSma": 0, "scope": "own", **params}
    return normalize_spec({"family": "core_dip", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "rsiBelow": 40, "sellAbove": 40}})
    rng = random.Random(3)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
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
    assert set(FAM.markets_needed(spec(["BTC-EUR"], scope="pair"))) == {"BTC-EUR", "ETH-EUR"}
    assert set(FAM.markets_needed(spec(["ETH-EUR"], scope="btc"))) == {"BTC-EUR", "ETH-EUR"}
    assert set(FAM.markets_needed(spec(["ETH-EUR"]))) == {"ETH-EUR"}
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], maxHold=10, coreSma=50, scope="pair"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_own_dip_buys_and_sells_after_rebound():
    w = FAM.targets({"BTC-EUR": closes(DIP)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    assert list(w[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]


def test_pair_scope_needs_both_oversold():
    flat = closes([10] * 10)
    cd = {"BTC-EUR": closes(DIP), "ETH-EUR": flat}
    w = FAM.targets(cd, spec(scope="pair"))["BTC-EUR"].to_numpy()
    assert (w[2:] == 0).all()
    cd2 = {"BTC-EUR": closes(DIP), "ETH-EUR": closes(DIP)}
    w2 = FAM.targets(cd2, spec(scope="pair"))["BTC-EUR"].to_numpy()
    assert list(w2[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]


def test_btc_scope_triggers_eth_and_max_hold():
    cd = {"BTC-EUR": closes(DIP), "ETH-EUR": closes(DIP)}
    w = FAM.targets(cd, spec(["ETH-EUR"], scope="btc", maxHold=1))["ETH-EUR"].to_numpy()
    assert list(w[2:]) == [0, 0, 1, 0, 0, 0, 0, 0]


def test_core_holds_uptrend():
    up = list(range(1, 11))
    w = FAM.targets({"BTC-EUR": closes(up)}, spec(coreSma=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all() and (w[2:] == 1).all()
    w0 = FAM.targets({"BTC-EUR": closes(up)}, spec())["BTC-EUR"].to_numpy()
    assert (w0[2:] == 0).all()
