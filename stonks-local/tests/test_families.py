import random
import types

import numpy as np
import pandas as pd
import pytest

from _engine_util import H4, T0, bars, synth
from stonks_lab.families import FAMILIES, V1_FAMILIES, normalize_spec, register_family


def spec_for(name, markets=None, **params):
    fam = FAMILIES[name]
    ms = markets or (["BTC-EUR", "ETH-EUR", "SOL-EUR"] if fam.multi_market else ["BTC-EUR"])
    return normalize_spec({"family": name, "markets": ms, "interval": "4h", "params": params}, fam)


def candles3(n=800):
    return {"BTC-EUR": synth(n, 1), "ETH-EUR": synth(n, 2, price=1500), "SOL-EUR": synth(n, 3, price=100)}


def test_registry_v1_bot_ready():
    for name in V1_FAMILIES:
        assert name in FAMILIES and FAMILIES[name].bot_ready and FAMILIES[name].version == 1
    assert FAMILIES["rotation_momentum"].multi_market and FAMILIES["dca_dip"].anchored


def test_register_new_family_not_bot_ready():
    mod = types.SimpleNamespace(NAME="test_new_family", default_params=lambda: {}, param_space=lambda: {},
                                explain=lambda s: {"summary": "x"}, targets=lambda c, s, start_time=None: None)
    fam = register_family(mod)
    assert FAMILIES["test_new_family"] is fam and not fam.bot_ready
    del FAMILIES["test_new_family"]


@pytest.mark.parametrize("name", V1_FAMILIES)
def test_family_contract(name):
    fam = FAMILIES[name]
    assert fam.validate({"params": fam.default_params()}) is None
    rng = random.Random(1)
    for _ in range(20):
        p = fam.sample(rng)
        assert fam.validate({"params": p}) is None, p
    cd = candles3()
    for mw in (1.0, 0.6):
        spec = spec_for(name)
        spec["risk"]["maxWeight"] = mw
        t = fam.targets(cd, spec)
        assert list(t.columns) == spec["markets"]
        assert t.index.dtype == np.int64
        v = t.to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        assert rows.any()
        first = int(np.argmax(rows))
        assert not np.isnan(v[first:]).any(), "NaN after the first decision"
        assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= mw + 1e-12).all()
    ex = fam.explain(spec_for(name))
    assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]


@pytest.mark.parametrize("name", V1_FAMILIES)
def test_no_lookahead(name):
    fam = FAMILIES[name]
    cd = candles3(900)
    spec = spec_for(name)
    if name == "rotation_momentum":
        spec["params"]["regimeSma"] = 50
    full = fam.targets(cd, spec).to_numpy()
    rng = np.random.default_rng(5)
    for k in (300, 650):
        trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
        t = fam.targets(trunc, spec).to_numpy()
        np.testing.assert_array_equal(t, full[: k + 1])
        pert = {}
        for m, df in cd.items():
            d = df.copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            pert[m] = d
        np.testing.assert_array_equal(fam.targets(pert, spec).to_numpy()[: k + 1], full[: k + 1])


def closes_frame(closes, highs=None):
    c = np.asarray(closes, float)
    h = c if highs is None else np.asarray(highs, float)
    return bars([(x, hh, x, x) for x, hh in zip(c, h)])


def test_ema_cross_hand():
    cd = {"BTC-EUR": closes_frame([1, 1, 1, 5, 5, 1, 1, 1])}
    w = FAMILIES["ema_cross"].targets(cd, spec_for("ema_cross", fast=1, slow=3))["BTC-EUR"].to_numpy()
    # ema1 = close; ema3 seeded 1 at i=2 then .5*x+.5*prev: 3, 4, 2.5, 1.75, 1.375
    assert np.isnan(w[:2]).all()
    assert list(w[2:]) == [0, 1, 1, 0, 0, 0]


def test_donchian_hand():
    hi = [10, 11, 12, 11, 10, 13, 12, 11, 9, 9]
    c = [9, 10, 11, 10, 9, 12.5, 11, 10, 8, 8.5]
    df = bars([(x, h, x - 1, x) for x, h in zip(c, hi)])
    w = FAMILIES["donchian_breakout"].targets({"BTC-EUR": df}, spec_for("donchian_breakout", entry=3, exit=2))
    w = w["BTC-EUR"].to_numpy()
    # i=5: close 12.5 > max(high[2..4]) = 12 -> in; lows = close-1; i=8: close 8 < min(low[6..7]) = 9 -> out
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == [0, 0, 1, 1, 1, 0, 0]


def test_rsi_dip_hand():
    c = [10, 9, 8, 7, 8, 9, 10, 11, 10]
    w = FAMILIES["rsi_dip"].targets({"BTC-EUR": closes_frame(c)},
                                    spec_for("rsi_dip", period=2, buyBelow=30, sellAbove=70, trendSma=0))
    w = w["BTC-EUR"].to_numpy()
    # rsi: i2=0 (buy), i3=0, i4=50, i5=83.3 (sell)
    assert list(w[2:]) == [1, 1, 1, 0, 0, 0, 0]
    w2 = FAMILIES["rsi_dip"].targets({"BTC-EUR": closes_frame(c)},
                                     spec_for("rsi_dip", period=2, buyBelow=30, sellAbove=70, trendSma=3))
    assert (w2["BTC-EUR"].to_numpy()[2:] == 0).all()  # downtrend: close < SMA(3), never buys


def test_bollinger_hand():
    c = [10, 10, 10, 10, 7, 9, 10.5, 11]
    w = FAMILIES["bollinger_reversion"].targets({"BTC-EUR": closes_frame(c)},
                                                spec_for("bollinger_reversion", period=4, stdDev=1.0))
    w = w["BTC-EUR"].to_numpy()
    # i4: window 10,10,10,7 mid 9.25 sd 1.299 lower 7.95 -> 7 < lower: in; i5: mid 9 -> 9 not > 9; i6: 10.5 > 9.125
    assert list(w[3:]) == [0, 1, 1, 0, 0]


def test_dca_dip_hand():
    c = [100, 100, 85, 84, 100, 160, 160]
    spec = spec_for("dca_dip", everyBars=100, tranches=4, dipPct=0.1, lookback=3, takeProfitPct=0.5,
                    sellFraction=0.5)
    w = FAMILIES["dca_dip"].targets({"BTC-EUR": closes_frame(c)}, spec)["BTC-EUR"].to_numpy()
    coins = 0.25 / 100
    assert w[0] == pytest.approx(0.25) and w[1] == pytest.approx(0.25)
    coins += 0.25 / 85                                     # dip: 85 <= 100*0.9, armed
    assert w[2] == pytest.approx(coins * 85 / (0.5 + coins * 85), abs=1e-15)
    assert w[3] == pytest.approx(coins * 84 / (0.5 + coins * 84), abs=1e-15)  # still in the dip: not re-armed
    assert w[4] == pytest.approx(coins * 100 / (0.5 + coins * 100), abs=1e-15)
    # avg entry 0.5/coins = 91.9; 160 >= 137.8 -> sell half
    cash = 0.5 + coins / 2 * 160
    coins /= 2
    assert w[5] == pytest.approx(coins * 160 / (cash + coins * 160), abs=1e-15)
    cash += coins / 2 * 160                                # avg unchanged -> sells half again
    coins /= 2
    assert w[6] == pytest.approx(coins * 160 / (cash + coins * 160), abs=1e-15)
    # anchored: nothing before start_time, schedule restarts there
    w2 = FAMILIES["dca_dip"].targets({"BTC-EUR": closes_frame(c)}, spec, start_time=T0 + 4 * H4)["BTC-EUR"]
    assert np.isnan(w2.to_numpy()[:4]).all() and w2.to_numpy()[4] == pytest.approx(0.25)


def test_rotation_hand():
    a = closes_frame([100, 110, 120, 130, 120])
    b = closes_frame([100, 120, 120, 125, 125])
    c = closes_frame([100, 90, 95, 100, 105])
    cd = {"AAA-EUR": a, "BBB-EUR": b, "CCC-EUR": c}
    spec = spec_for("rotation_momentum", markets=["AAA-EUR", "BBB-EUR", "CCC-EUR"], lookback=1, top=2,
                    regimeSma=0)
    t = FAMILIES["rotation_momentum"].targets(cd, spec)
    v = t.to_numpy()
    assert np.isnan(v[0]).all()
    # i1: rets .1 .2 -.1 -> B, A ; i2: .0909 0 .0556 -> A, C ; i3: .083 .0417 .0526 -> A, C ; i4: -.077 0 .05 -> C
    np.testing.assert_allclose(v[1:], [[.5, .5, 0], [.5, 0, .5], [.5, 0, .5], [0, 0, .5]])
    # ties broken by market name
    d = {"BBB-EUR": closes_frame([100, 110]), "AAA-EUR": closes_frame([100, 110])}
    s = spec_for("rotation_momentum", markets=["BBB-EUR", "AAA-EUR"], lookback=1, top=1, regimeSma=0)
    assert list(FAMILIES["rotation_momentum"].targets(d, s).to_numpy()[1]) == [0, 1]
    # regime filter: BTC under its SMA -> all cash
    cd2 = {**cd, "BTC-EUR": closes_frame([100, 90, 80, 70, 60])}
    s2 = spec_for("rotation_momentum", markets=["AAA-EUR", "BBB-EUR", "CCC-EUR"], lookback=1, top=2,
                  regimeSma=2)
    assert FAMILIES["rotation_momentum"].markets_needed(s2)[-1] == "BTC-EUR"
    np.testing.assert_array_equal(FAMILIES["rotation_momentum"].targets(cd2, s2).to_numpy()[1:], 0)


def test_rotation_missing_bars_use_own_series():
    a = closes_frame([100, 110, 120, 130])
    b = closes_frame([100, 120, 130]).iloc[[0, 2]]  # BBB has no candle at bar 1
    b.index = a.index[[0, 2]]
    spec = spec_for("rotation_momentum", markets=["AAA-EUR", "BBB-EUR"], lookback=1, top=1, regimeSma=0)
    v = FAMILIES["rotation_momentum"].targets({"AAA-EUR": a, "BBB-EUR": b}, spec).to_numpy()
    # bar 2: BBB's previous own candle is bar 0 -> ret 0.3 beats AAA's 0.0909
    np.testing.assert_allclose(v[1:], [[1, 0], [0, 1], [1, 0]])
