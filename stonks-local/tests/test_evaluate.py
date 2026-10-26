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

    def res(final, dd_path=None, expo=1.0):
        eq = np.array(dd_path if dd_path is not None else [1000.0, 1000.0, final], dtype=float)
        return bt.BacktestResult(spec={}, markets=[], ts=ts, equity=eq, cash=eq, exposure=eq * 0 + expo,
                                 trades=[{}] * 5, start_eur=1000.0)

    folds = [(res(1100, [1000, 800, 1100]), res(1000)), (res(1210), res(1100)), (res(900), res(1000))]
    score, parts = ev.compute_score(folds)
    xs = [math.log(1.1), math.log(1.21 / 1.1), math.log(0.9)]
    dds = [0.2, 0.0, 0.1]
    kept = sorted(xs)[:-1]                                   # the best fold is dropped
    expected = 100 * (np.mean(kept) - 0.5 * np.median(dds)) - 10 * (1 - 15 / 20)
    assert score == pytest.approx(expected, abs=1e-4)
    assert parts["testTrades"] == 15 and parts["foldsBeatBuyHold"] == 2
    assert parts["eligible"] and parts["medianExposurePct"] == 100.0 and parts["evalVersion"] == ev.EVAL_VERSION
    assert ev.compute_score(folds[:2])[0] is None


def test_near_cash_spec_is_ineligible_and_loses_its_bear_fold_edge():
    ts = np.arange(3)

    def res(final, expo):
        eq = np.array([1000.0, 1000.0, final])
        return bt.BacktestResult(spec={}, markets=[], ts=ts, equity=eq, cash=eq, exposure=eq * 0 + expo,
                                 trades=[{}] * 4, start_eur=1000.0)

    # in cash through 4 bear folds (+7..+20 % "excess" just by not holding), lags badly in 2 bull folds
    folds = [(res(1000, 0.0), res(800, 1)), (res(1000, 0.0), res(900, 1)), (res(1000, 0.0), res(850, 1)),
             (res(1000, 0.0), res(930, 1)), (res(1100, 0.6), res(2000, 1)), (res(1200, 0.7), res(1800, 1))]
    score, parts = ev.compute_score(folds)
    assert parts["medianExcessLogPct"] > 5                   # the old (median) score called this a winner
    assert score < 0 and not parts["eligible"] and "cash" in parts["ineligibleReason"]


def test_eval_version_is_shared():
    from stonks_lab import registry as reg
    assert ev.EVAL_VERSION == reg.EVAL_VERSION


def _warm_targets(candles, spec, start_time=None):
    import pandas as pd
    df = candles[spec["markets"][0]]
    arr = np.full(len(df), 1.0)
    arr[: spec["params"]["warm"]] = np.nan
    return pd.DataFrame({spec["markets"][0]: arr}, index=pd.Index(np.asarray(df.index, dtype=np.int64), name="ts"))


def test_fold_boundaries_do_not_depend_on_warm_up():
    import types
    from stonks_lab.families import register_family
    register_family(types.SimpleNamespace(
        NAME="test_warm", VERSION=1, TITLE="warm-up test", MULTI_MARKET=False,
        default_params=lambda: {"warm": 10}, param_space=lambda: {"warm": {"type": "int", "min": 0, "max": 5000}},
        explain=lambda spec: {"summary": "test"}, targets=_warm_targets))
    cd = {"BTC-EUR": daily(seed=7)}
    runs = {w: ev.evaluate({"family": "test_warm", "markets": ["BTC-EUR"], "interval": "1d", "params": {"warm": w}},
                           candles=cd, with_benchmarks=False) for w in (10, 200, 600)}
    periods = {w: {f["fold"]: f["testPeriod"] for f in r["folds"]} for w, r in runs.items()}
    assert len(periods[10]) == 6 and periods[200] == periods[10]
    # the long warm-up loses the folds it is not warm for instead of having all folds moved later
    assert sorted(periods[600]) == [3, 4, 5, 6]
    assert all(periods[600][k] == periods[10][k] for k in periods[600])
    assert [f["fold"] for f in runs[600]["scoreParts"]["skippedFolds"]] == [1, 2]
    assert runs[600]["holdoutStart"] == runs[10]["holdoutStart"]
    # always in the market: the same windows give the same per-fold result whatever the warm-up
    assert runs[600]["folds"][0]["test"] == runs[10]["folds"][2]["test"]
    assert all(r["evalVersion"] == ev.EVAL_VERSION for r in runs.values())
    # too long to be warm for 3 folds -> no score
    r = ev.evaluate({"family": "test_warm", "markets": ["BTC-EUR"], "interval": "1d", "params": {"warm": 1100}},
                    candles=cd, with_benchmarks=False)
    assert r["score"] is None
