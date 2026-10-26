import random

import numpy as np
import pytest

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["breadth_trend"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "breadth_trend", "markets": list(markets), "interval": "1d",
                           "params": {**FAM.default_params(), **params}}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert "exitAt" in FAM.validate({"params": {**FAM.default_params(), "enterAt": 0.5, "exitAt": 0.6}})
    assert "graded" in FAM.validate({"params": {**FAM.default_params(), "signal": "basket", "sizing": "graded"}})
    rng = random.Random(7)
    cd = {"BTC-EUR": synth(700, 1), "ETH-EUR": synth(700, 2, price=1500), "SOL-EUR": synth(700, 3, price=100),
          "XRP-EUR": synth(700, 4, price=0.5)}
    for _ in range(20):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.8
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.8 + 1e-12).all()
    for sig in ("sma", "mom", "basket"):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], signal=sig, trendSma=50, basketBand=0.02))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_hysteresis_breadth_sma():
    # 4 coins, SMA2. coin is "up" when close > previous close (sma2 of rising pair < close).
    a = closes([1, 2, 3, 4, 5, 6, 7, 8])          # always up
    b = closes([1, 2, 3, 4, 3, 2, 3, 4])          # up, up, up, down, down, up, up
    c = closes([1, 2, 3, 2, 1, 2, 1, 2])          # up, up, down, down, up, down, up
    d = closes([5, 4, 3, 2, 1, 2, 1, 0.5])        # down, down, down, down, up, down, down
    cd = {"BTC-EUR": a, "ETH-EUR": b, "XRP-EUR": c, "SOL-EUR": d}
    # breadth from i1: .75 .75 .5 .25 .75 .5 .75
    s = spec(["BTC-EUR"], signal="sma", length=2, enterAt=0.75, exitAt=0.5)
    w = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
    assert np.isnan(w[0])
    assert list(w[1:]) == [1, 1, 1, 0, 1, 1, 1]      # stays on at .5 (not < .5), off at .25, back on at .75
    s2 = spec(["BTC-EUR"], signal="sma", length=2, enterAt=0.75, exitAt=0.75)
    assert list(FAM.targets(cd, s2)["BTC-EUR"].to_numpy()[1:]) == [1, 1, 0, 0, 1, 0, 1]
    g = spec(["BTC-EUR"], signal="sma", length=2, enterAt=0.5, exitAt=0.25, sizing="graded")
    assert list(FAM.targets(cd, g)["BTC-EUR"].to_numpy()[1:]) == [.75, .75, .5, .25, .75, .5, .75]


def test_mom_signal_and_trend_filter():
    up = closes([1, 2, 3, 4, 5, 6])
    down = closes([6, 5, 4, 3, 2, 1])
    cd = {"BTC-EUR": up, "ETH-EUR": down, "XRP-EUR": up, "SOL-EUR": up}
    s = spec(["BTC-EUR", "ETH-EUR"], signal="mom", length=2, enterAt=0.75, exitAt=0.5)
    w = FAM.targets(cd, s).to_numpy()
    assert np.isnan(w[:2]).all()
    np.testing.assert_allclose(w[2:], [[.5, .5]] * 4)
    s2 = spec(["BTC-EUR", "ETH-EUR"], signal="mom", length=2, enterAt=0.75, exitAt=0.5, trendSma=2)
    np.testing.assert_allclose(FAM.targets(cd, s2).to_numpy()[2:], [[.5, 0]] * 4)
    # only 2 coins: undefined
    assert np.isnan(FAM.targets({"BTC-EUR": up, "ETH-EUR": up}, spec(signal="mom", length=2)).to_numpy()).all()


def test_basket_signal():
    rise = [100 * 1.02 ** i for i in range(20)]
    fall = [rise[-1] * 0.97 ** i for i in range(1, 15)]
    cd = {m: closes(rise + fall) for m in ("BTC-EUR", "ETH-EUR", "XRP-EUR")}
    w = FAM.targets(cd, spec(signal="basket", length=5, basketBand=0.0))["BTC-EUR"].to_numpy()
    assert (w[6:20] == 1).all()
    assert (w[22:] == 0).all()
    wb = FAM.targets(cd, spec(signal="basket", length=5, basketBand=0.05))["BTC-EUR"].to_numpy()
    # band 5 %: 2 %/candle drift puts the level ~4 % over SMA5 -> never switches on
    assert np.nansum(wb) == 0


@pytest.mark.parametrize("params", [
    {"signal": "sma", "length": 30, "enterAt": 0.7, "exitAt": 0.4},
    {"signal": "mom", "length": 20, "enterAt": 0.6, "exitAt": 0.3, "sizing": "graded", "trendSma": 50},
    {"signal": "basket", "length": 40, "basketBand": 0.02},
])
def test_no_lookahead(params):
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2, price=1500), "SOL-EUR": synth(900, 3, price=100),
          "XRP-EUR": synth(900, 4, price=0.5)}
    s = spec(["BTC-EUR", "ETH-EUR"], **params)
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
