import random

import numpy as np
import pytest

from _engine_util import H4, T0, bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["dca_gate"]
BASE = {"everyBars": 1, "tranches": 2, "trendSma": 0, "exitOnGate": False, "exitBand": 0.0, "dipPct": 0.0,
        "lookback": 3, "dipIgnoresGate": False}


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "dca_gate", "markets": list(markets), "interval": "1d",
                           "params": {**BASE, **params}}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_no_lookahead():
    assert FAM.anchored and FAM.multi_market and not FAM.bot_ready
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert "trendSma" in FAM.validate({"params": {**BASE, "exitOnGate": True}})
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2, price=1500)}
    for _ in range(15):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s, start_time=T0 + 400 * H4).to_numpy()
        assert np.isnan(v[:400]).all() and not np.isnan(v[400:]).any()
        assert (v[400:] >= 0).all() and (v[400:].sum(axis=1) <= 0.6 + 1e-12).all()
    s = spec(["BTC-EUR", "ETH-EUR"], everyBars=5, tranches=6, trendSma=50, exitOnGate=True, exitBand=0.02,
             dipPct=0.1, lookback=20)
    full = FAM.targets(cd, s, start_time=T0 + 200 * H4).to_numpy()
    for k in (300, 650):
        trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
        np.testing.assert_array_equal(FAM.targets(trunc, s, start_time=T0 + 200 * H4).to_numpy(), full[: k + 1])
    ex = FAM.explain(s)
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_plain_dca_two_markets():
    a = closes([100, 100, 200, 200])
    b = closes([10, 10, 10, 10])
    w = FAM.targets({"AAA-EUR": a, "BBB-EUR": b}, spec(["AAA-EUR", "BBB-EUR"], tranches=2)).to_numpy()
    # each sleeve 0.5, tranche 0.25: bar0 buys .25 of each, bar1 the rest -> fully in
    np.testing.assert_allclose(w[0], [0.25, 0.25])
    np.testing.assert_allclose(w[1], [0.5, 0.5])
    # bar2: A doubled: values A 1.0, B 0.5
    np.testing.assert_allclose(w[2], [1 / 1.5, 0.5 / 1.5])


def test_gate_postpones_and_exit_restarts():
    c = [10, 10, 10, 8, 7, 12, 13, 14, 6, 6]
    s = spec(trendSma=3, exitOnGate=True, everyBars=1, tranches=2)
    w = FAM.targets({"BTC-EUR": closes(c)}, s, start_time=T0 + 2 * H4)["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    # i2: sma 10, 10 > 10 false -> owed; i3, i4 below -> nothing held, no exit
    assert list(w[2:5]) == [0, 0, 0]
    # i5: sma(8,7,12)=9 -> 12 > 9 buys first slice (0.5 at 12); i6: buys the second -> fully in
    assert w[5] == pytest.approx(0.5)
    assert w[6] == pytest.approx(1.0)
    assert w[7] == pytest.approx(1.0)
    # i8: sma(13,14,6)=11 -> 6 < 11: sell everything
    assert w[8] == 0 and w[9] == 0


def test_dip_buy_only_in_uptrend_unless_ignored():
    c = [100, 100, 100, 85, 85, 100]
    p = dict(everyBars=100, tranches=4, dipPct=0.1, lookback=3)
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(**p))["BTC-EUR"].to_numpy()
    assert w[0] == pytest.approx(0.25) and w[2] == pytest.approx(0.25)
    coins = 0.25 / 100 + 0.25 / 85  # dip at i3, not again at i4 (still in the dip)
    assert w[3] == pytest.approx(coins * 85 / (0.5 + coins * 85))
    assert w[4] == pytest.approx(coins * 85 / (0.5 + coins * 85))
    gated = dict(p, trendSma=2)
    w2 = FAM.targets({"BTC-EUR": closes(c)}, spec(**gated))["BTC-EUR"].to_numpy()
    # sma2 undefined at i0 -> scheduled buy waits; i1: 100 > 100 no; i3 dip but below trend -> no buy
    assert np.all(w2[:5] == 0) and w2[5] == pytest.approx(0.25)
    w3 = FAM.targets({"BTC-EUR": closes(c)}, spec(**gated, dipIgnoresGate=True))["BTC-EUR"].to_numpy()
    assert w3[3] == pytest.approx(0.25)
