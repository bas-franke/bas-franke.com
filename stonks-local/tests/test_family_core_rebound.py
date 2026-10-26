import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["core_rebound"]
DIP = [10, 11, 12, 11, 10, 9, 10, 11, 12, 13]   # RSI(2) from i=2: 100, 50, 25, 12.5, 56.25, 78.1, ...


def spec(markets=("BTC-EUR",), **params):
    p = {"coreSma": 0, "signal": "rsi", "source": "own", "rsiPeriod": 2, "rsiBelow": 30, "ddLook": 5,
         "ddMin": 0.2, "holdBars": 3, "sellAbove": 100.0, **params}
    return normalize_spec({"family": "core_rebound", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "rsiBelow": 40, "sellAbove": 40}})
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
    assert FAM.markets_needed(spec(["ETH-EUR"])) == ["ETH-EUR"]
    assert set(FAM.markets_needed(spec(["ETH-EUR"], source="both"))) == {"BTC-EUR", "ETH-EUR"}
    for extra in ({"coreSma": 50}, {"signal": "drawdown", "source": "any", "sellAbove": 70}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]


def test_rsi_rebound_buy_held_for_hold_bars():
    cd = {"BTC-EUR": closes(DIP)}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    # signal at i4 (RSI 25) -> in at i4, held i5, i6, out at i7 (held 3)
    assert list(w[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]
    w2 = FAM.targets(cd, spec(sellAbove=50))["BTC-EUR"].to_numpy()
    assert list(w2[2:]) == [0, 0, 1, 1, 0, 0, 0, 0]   # i6 RSI 56 > 50


def test_drawdown_signal():
    c = [10, 10, 10, 10, 10, 7.5, 8, 9, 10, 11, 12]
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(signal="drawdown", ddLook=5, ddMin=0.2, holdBars=2))["BTC-EUR"]
    w = w.to_numpy()
    assert np.isnan(w[:4]).all()
    assert list(w[4:]) == [0, 1, 1, 0, 0, 0, 0]


def test_shared_source_needs_both_or_any():
    flat = closes([10] * 10)
    cd = {"BTC-EUR": closes(DIP), "ETH-EUR": flat}
    both = FAM.targets(cd, spec(["ETH-EUR"], source="both"))["ETH-EUR"].to_numpy()
    assert (both[2:] == 0).all()
    anyw = FAM.targets(cd, spec(["ETH-EUR"], source="any"))["ETH-EUR"].to_numpy()
    assert list(anyw[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]   # ETH bought on BTC's panic
    own = FAM.targets(cd, spec(["ETH-EUR"]))["ETH-EUR"].to_numpy()
    assert (own[2:] == 0).all()


def test_core_trend_holds_outside_dips():
    up = list(range(1, 11))
    w = FAM.targets({"BTC-EUR": closes(up)}, spec(coreSma=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all() and (w[2:] == 1).all()
    w0 = FAM.targets({"BTC-EUR": closes(up)}, spec())["BTC-EUR"].to_numpy()
    assert (w0[2:] == 0).all()
