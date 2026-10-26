"""Point-in-time universe (top10_pit): membership uses only past volume, weights outside it are dropped, and the
leaderboard ranks today's-top-10 specs only when their point-in-time twin also beats buy and hold."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _engine_util import synth  # noqa: E402
from stonks_lab import evaluate as ev  # noqa: E402
from stonks_lab import leaderboard  # noqa: E402
from stonks_lab import registry as reg  # noqa: E402
from stonks_lab import universe as u  # noqa: E402

DAY = 86_400_000
START = 1_500_000_000_000 - 1_500_000_000_000 % DAY


def daily(n, seed, vol_eur):
    df = synth(n, seed, start=START, step=DAY, drift=0.0005, vol=0.03, price=100.0)
    df["volume"] = vol_eur / df["close"]
    return df


def test_membership_uses_only_past_volume():
    cd = {f"C{i}-EUR": daily(400, i, 1000.0 * (i + 1)) for i in range(12)}
    m1 = u.pit_daily_members(cd, n=10, lookback=30)
    assert not m1.iloc[:30].any().any()                     # no member before 30 completed days
    row = m1.iloc[100]
    assert row.sum() == 10 and not row["C0-EUR"] and not row["C1-EUR"]
    # a volume spike on day 200 changes membership only from day 201 on
    cd2 = dict(cd)
    df = cd["C0-EUR"].copy()
    v = df["volume"].to_numpy().copy()
    v[200:] *= 1000
    df["volume"] = v
    cd2["C0-EUR"] = df
    m2 = u.pit_daily_members(cd2, n=10, lookback=30)
    assert m2.iloc[:201].equals(m1.iloc[:201])
    assert m2.iloc[201]["C0-EUR"] and not m1.iloc[201]["C0-EUR"]


def test_apply_pit_drops_non_members_and_keeps_the_total():
    t = pd.DataFrame({"A": [np.nan, 0.5, 0.25], "B": [np.nan, 0.5, 0.25], "C": [np.nan, 0.0, 0.5]})
    mem = np.array([[True, True, True], [True, False, True], [False, False, False]])
    out = u.apply_pit(t, mem).to_numpy()
    assert np.isnan(out[0]).all()
    assert np.allclose(out[1], [1.0, 0.0, 0.0]) and np.allclose(out[2], [0.0, 0.0, 0.0])


def test_evaluate_on_pit_universe_and_hash():
    cd = {f"C{i}-EUR": daily(5 * 365, i + 1, 1000.0 * (i + 1)) for i in range(12)}
    markets = sorted(cd)
    spec = {"family": "rotation_momentum", "markets": markets, "interval": "1d", "params": {}}
    pit = dict(spec, universe="top10_pit")
    assert reg.spec_hash(pit) != reg.spec_hash(spec) and ev.spec_hash(pit) != ev.spec_hash(spec)
    r = ev.evaluate(pit, candles=cd, with_benchmarks=False)
    assert r["scoreParts"]["universe"] == "top10_pit" and "survivorshipBiased" not in r["scoreParts"]
    r2 = ev.evaluate(spec, candles=cd, with_benchmarks=False)
    assert r2["scoreParts"]["survivorshipBiased"] is True
    assert r["score"] != r2["score"]
    assert u.is_survivorship_biased(markets) and not u.is_survivorship_biased(markets, "top10_pit")
    assert not u.is_survivorship_biased(["BTC-EUR", "ETH-EUR"])


def _result(score, parts):
    eq = [[1_700_000_000_000 + i * DAY, 1000 + i] for i in range(50)]
    return {"score": score, "scoreParts": {"testTrades": 50, "eligible": True, **parts}, "evalVersion": reg.EVAL_VERSION,
            "holdout": {"returnPct": score, "trades": 30}, "equity": eq, "buyHoldEquity": eq}


def test_today_top10_spec_needs_a_winning_pit_twin(tmp_path):
    r = reg.Registry(tmp_path / "lab.sqlite")
    biased = {"family": "rotation_momentum", "familyVersion": 1, "markets": u.DEFAULT_TOP10 and
              [f"{b}-EUR" for b in u.DEFAULT_TOP10], "interval": "1d", "params": {"lookback": 30}}
    r.record(biased, _result(20.0, {"meanExcessLogPct": 25.0}))
    assert leaderboard.rank(r) == []                         # no twin evaluated yet
    twin = leaderboard.pit_twin_spec(biased)
    r.record(twin, _result(-5.0, {"meanExcessLogPct": -3.0}))
    assert [e["score"] for e in leaderboard.rank(r)] == [-5.0]   # twin lost to buy and hold: biased one not ranked
    r.rescore(reg.spec_hash(twin), {**_result(2.0, {"meanExcessLogPct": 4.0}), "evalVersion": reg.EVAL_VERSION + 1})
    # (a twin of another eval version is not compared: the biased one is still not ranked)
    assert leaderboard.rank(r) == []
    r2 = reg.Registry(tmp_path / "lab2.sqlite")
    r2.record(biased, _result(20.0, {"meanExcessLogPct": 25.0}))
    r2.record(twin, _result(2.0, {"meanExcessLogPct": 4.0}))
    top = leaderboard.rank(r2)
    assert [e["score"] for e in top] == [20.0, 2.0] and top[0]["pitCheck"]["passed"]
    p = leaderboard.build_payload(r2)
    assert "today's top-10" in p["top"][0]["explanation"]["vsBuyHold"]
    assert "top 10 at each moment" in p["summary"]["notes"]
