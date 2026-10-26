import random

import numpy as np
import pytest

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["regime_gate"]
OFF = {"trendSma": 0, "btcSma": 0, "volRatioMax": 0, "breadthMin": 0}


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "regime_gate", "markets": list(markets), "interval": "4h",
                           "params": {**OFF, **params}}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert "at least one gate" in FAM.validate({"params": {**FAM.default_params(), **OFF}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2, price=1500), "SOL-EUR": synth(900, 3, price=100)}
    for _ in range(15):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["ETH-EUR", "SOL-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], btcSma=50, volRatioMax=1.2, breadthMin=0.6, trendSma=20))
    assert ex["summary"] and len(ex["howItWorks"]) >= 5


def test_btc_gate_controls_eth():
    btc = closes([10, 10, 10, 12, 13, 9, 8, 11])
    eth = closes([5] * 8)
    s = spec(["ETH-EUR"], btcSma=3)
    assert FAM.markets_needed(s) == ["ETH-EUR", "BTC-EUR"]
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, s)["ETH-EUR"].to_numpy()
    # sma3: i2 10 (10>10 no), i3 10.67 yes, i4 11.67 yes, i5 11.33 no, i6 10 no, i7 9.33 yes
    assert np.isnan(w[:2]).all()
    assert list(w[2:]) == [0, 1, 1, 0, 0, 1]


def test_own_trend_and_split():
    a = closes([1, 2, 3, 4, 3, 2])
    b = closes([4, 3, 2, 1, 2, 3])
    w = FAM.targets({"AAA-EUR": a, "BBB-EUR": b}, spec(["AAA-EUR", "BBB-EUR"], trendSma=2)).to_numpy()
    np.testing.assert_allclose(w[1:], [[.5, 0], [.5, 0], [.5, 0], [0, .5], [0, .5]])


def test_low_vol_gate():
    calm = [100 * (1.01 if i % 2 else 1.0) for i in range(60)]
    wild = [calm[-1] * (1.1 if i % 2 else 0.9) for i in range(10)]
    w = FAM.targets({"BTC-EUR": closes(calm + wild)},
                    spec(volWindow=5, volLong=20, volRatioMax=1.5))["BTC-EUR"].to_numpy()
    first = int(np.argmax(np.isfinite(w)))
    assert first == 5 + 20 - 1
    assert (w[first:60] == 1).all()   # steady +-1 % swings: ratio 1
    assert (w[62:] == 0).all()        # swings blow up the short-term vol


def test_breadth_gate():
    up = closes([1, 2, 3, 4, 5, 6])
    down = closes([6, 5, 4, 3, 2, 1])
    cd = {"BTC-EUR": up, "ETH-EUR": up, "XRP-EUR": down, "SOL-EUR": down}
    s = spec(["BTC-EUR"], breadthSma=2, breadthMin=0.5)
    assert set(FAM.markets_needed(s)) >= {"ETH-EUR", "AVAX-EUR"}
    assert list(FAM.targets(cd, s)["BTC-EUR"].to_numpy()[1:]) == [1] * 5     # 2 of 4 above
    s2 = spec(["BTC-EUR"], breadthSma=2, breadthMin=0.75)
    assert list(FAM.targets(cd, s2)["BTC-EUR"].to_numpy()[1:]) == [0] * 5
    # fewer than 3 coins with history: undefined
    assert np.isnan(FAM.targets({"BTC-EUR": up, "ETH-EUR": up}, s)["BTC-EUR"].to_numpy()).all()


@pytest.mark.parametrize("params", [
    {"btcSma": 50, "trendSma": 20},
    {"volRatioMax": 1.1, "volWindow": 10, "volLong": 100},
    {"breadthMin": 0.5, "breadthSma": 30, "btcSma": 40},
])
def test_no_lookahead(params):
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2, price=1500), "SOL-EUR": synth(900, 3, price=100),
          "XRP-EUR": synth(900, 4, price=0.5)}
    s = spec(["ETH-EUR", "SOL-EUR"], **params)
    full = FAM.targets(cd, s).to_numpy()
    rng = np.random.default_rng(5)
    for k in (300, 650):
        trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
        pert = {}
        for m, df in cd.items():
            d = df.copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            pert[m] = d
        np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])
