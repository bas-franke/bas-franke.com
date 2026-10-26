import math

import numpy as np
import pytest

from _engine_util import synth
from stonks_lab import backtest as bt
from stonks_lab import evaluate as ev

DAY = 86_400_000


def daily(n=5 * 365, seed=1, price=20000.0):
    return synth(n, seed, start=1_500_000_000_000 - 1_500_000_000_000 % DAY, step=DAY, drift=0.0008, vol=0.035,
                 price=price)


def test_spec_hash_canonical():
    a = {"family": "ema_cross", "markets": ["BTC-EUR"], "interval": "4h", "params": {"fast": 12, "slow": 48}}
    b = {"interval": "4h", "params": {"slow": 48.0, "fast": 12}, "markets": ["BTC-EUR"], "family": "ema_cross",
         "risk": {"maxWeight": 1}, "id": "whatever", "name": "other name"}
    assert ev.spec_hash(a) == ev.spec_hash(b)
    assert len(ev.spec_hash(a)) == 64
    c = dict(a, params={"fast": 12, "slow": 49})
    assert ev.spec_hash(a) != ev.spec_hash(c)
    d = dict(a, execution={"orderType": "market"})
    assert ev.spec_hash(a) != ev.spec_hash(d)


@pytest.mark.parametrize("family", ["ema_cross", "dca_dip", "rotation_momentum"])
def test_walk_forward_splits_and_payload(family):
    cd = {"BTC-EUR": daily(seed=1), "ETH-EUR": daily(seed=2, price=1500)}
    markets = ["BTC-EUR", "ETH-EUR"] if family == "rotation_momentum" else ["BTC-EUR"]
    spec = {"family": family, "markets": markets, "interval": "1d", "params": {}}
    r = ev.evaluate(spec, candles=cd, with_benchmarks=False)
    assert r["score"] is not None and math.isfinite(r["score"])
    assert len(r["folds"]) == 6
    hold = r["holdout"]
    h0 = hold["testPeriod"][0]
    assert h0 == r["holdoutStart"]
    prev_end = None
    for f in r["folds"]:
        a, b = f["testPeriod"]
        assert a <= b < h0                                  # test windows never touch the holdout
        assert f["trainPeriod"][1] < a                      # train strictly before test
        if prev_end is not None:
            assert a > prev_end                             # folds do not overlap
        prev_end = b
    assert 360 <= hold["bars"] <= 366
    assert len(r["equity"]) <= 400 and len(r["equity"]) == len(r["buyHoldEquity"])
    assert [p[0] for p in r["equity"]] == [p[0] for p in r["buyHoldEquity"]]
    assert r["equity"][-1][0] == int(cd["BTC-EUR"].index[-1])
    assert set(r["explanation"]) >= {"summary", "howItWorks", "whenItWins", "whenItLoses", "vsBuyHold"}
    assert r["explanation"]["vsBuyHold"]
    assert "vsBuyHoldPct" in hold and "trainReturnPct" in hold
    assert r["validation"]["folds"] == 6 and r["train"]["inSample"]["bars"] > 0
    assert r["spec_hash"] == ev.spec_hash(spec) and len(r["fingerprint"]) == 16


def test_holdout_data_cannot_change_the_score():
    cd = {"BTC-EUR": daily(seed=4)}
    spec = {"family": "macd_trend", "markets": ["BTC-EUR"], "interval": "1d", "params": {}}
    r1 = ev.evaluate(spec, candles=cd, with_benchmarks=False)
    df = cd["BTC-EUR"].copy()
    h = int(np.searchsorted(df.index.to_numpy(), r1["holdout"]["bars"] and
                            int(df.index[-r1["holdout"]["bars"]])))
    for col in ("open", "high", "low", "close"):
        v = df[col].to_numpy().copy()
        v[h:] *= 0.3
        df[col] = v
    r2 = ev.evaluate(spec, candles={"BTC-EUR": df}, with_benchmarks=False)
    assert r2["score"] == r1["score"]
    assert r2["folds"] == r1["folds"]
    assert r2["holdout"]["returnPct"] != r1["holdout"]["returnPct"]


def test_score_formula():
    ts = np.arange(3)

    def res(final, dd_path=None):
        eq = np.array(dd_path if dd_path is not None else [1000.0, 1000.0, final])
        return bt.BacktestResult(spec={}, markets=[], ts=ts, equity=eq, cash=eq, exposure=eq * 0,
                                 trades=[{}] * 5, start_eur=1000.0)

    folds = [(res(1100, [1000, 800, 1100]), res(1000)), (res(1210), res(1100)), (res(900), res(1000))]
    score, parts = ev.compute_score(folds)
    xs = [math.log(1.1), math.log(1.21 / 1.1), math.log(0.9)]
    dds = [0.2, 0.0, 0.1]
    expected = 100 * (np.median(xs) - 0.5 * np.median(dds)) - 10 * (1 - 15 / 20)
    assert score == pytest.approx(expected, abs=1e-4)
    assert parts["testTrades"] == 15 and parts["foldsBeatBuyHold"] == 2
    assert ev.compute_score(folds[:2])[0] is None
