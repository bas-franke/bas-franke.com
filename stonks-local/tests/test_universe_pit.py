"""Point-in-time universe (top10_pit): membership uses only past volume, weights outside it are dropped, and the
leaderboard ranks today's-top-10 specs only when their point-in-time twin also beats buy and hold."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _engine_util import synth  # noqa: E402
from stonks_lab import evaluate as ev  # noqa: E402
from stonks_lab import leaderboard  # noqa: E402
from stonks_lab import registry as reg  # noqa: E402
from stonks_lab import universe as u  # noqa: E402

DAY = 86_400_000
START = 1_500_000_000_000 - 1_500_000_000_000 % DAY


@pytest.fixture(autouse=True)
def all_eligible(monkeypatch):
    monkeypatch.setattr(u, "_TEST_ALL_ELIGIBLE", True)


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


def test_apply_pit_turns_non_member_weight_into_cash():
    t = pd.DataFrame({"A": [np.nan, 0.5, 0.25], "B": [np.nan, 0.5, 0.25], "C": [np.nan, 0.0, 0.5]})
    mem = np.array([[True, True, True], [True, False, True], [False, False, False]])
    out = u.apply_pit(t, mem).to_numpy()
    assert np.isnan(out[0]).all()
    assert np.allclose(out[1], [0.5, 0.0, 0.0]) and np.allclose(out[2], [0.0, 0.0, 0.0])


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


def test_biased_spec_ranks_below_every_honest_spec(tmp_path, monkeypatch):
    r = reg.Registry(tmp_path / "lab.sqlite")
    biased = {"family": "rotation_momentum", "familyVersion": 1, "markets": [f"{b}-EUR" for b in u.DEFAULT_TOP10],
              "interval": "1d", "params": {"lookback": 30}}
    r.record(biased, _result(20.0, {"meanExcessLogPct": 25.0}))
    r.record(leaderboard.pit_twin_spec(biased), _result(9.0, {"meanExcessLogPct": 4.0}))
    honest = {"family": "ema_cross", "familyVersion": 1, "markets": ["BTC-EUR"], "interval": "1d", "params": {}}
    r.record(honest, _result(1.0, {"meanExcessLogPct": 1.0}))
    monkeypatch.setattr(leaderboard, "same_outcome", lambda a, b: False)      # the fake curves are all alike
    top = leaderboard.rank(r)
    # 9.0 (biased, capped by its twin) still comes after the honest 1.0
    assert [leaderboard.survivorship_biased(e) for e in top] == [False, False, True]
    assert top[-1]["score"] == 9.0 and top[1]["score"] == 1.0


def test_today_top10_spec_needs_a_winning_pit_twin(tmp_path, monkeypatch):
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
    monkeypatch.setattr(leaderboard, "same_outcome", lambda a, b: False)      # the fake curves are all alike
    top = leaderboard.rank(r2)
    # the twin competes in its own right; the biased one comes after it, with the honest (point-in-time) score
    assert [e["spec_hash"] for e in top] == [reg.spec_hash(twin), reg.spec_hash(biased)]
    assert top[1]["score"] == 2.0 and top[1]["rawScore"] == 20.0 and top[1]["pitCheck"]["passed"]
    p = leaderboard.build_payload(r2)
    assert "today's top-10" in p["top"][1]["explanation"]["vsBuyHold"]
    assert "top 10 at each moment" in p["summary"]["notes"]


def test_eligibility_follows_the_snapshots(monkeypatch):
    monkeypatch.setattr(u, "_TEST_ALL_ELIGIBLE", False)
    day = lambda d: int(pd.Timestamp(d, tz="UTC").value // 1_000_000)  # noqa: E731
    ms = ["SOL-EUR", "SUI-EUR", "HBAR-EUR", "BTC-EUR", "LUNA-EUR", "MIOTA-EUR", "POL-EUR"]
    el = u.pit_eligible([day("2021-06-01"), day("2021-07-05"), day("2022-03-01"), day("2024-06-01"),
                         day("2025-03-01"), day("2019-03-08")], ms)
    col = {m: el[:, j].tolist() for j, m in enumerate(ms)}
    assert col["SOL-EUR"] == [False, True, True, True, True, False]     # top 15 from the 2021-07-04 snapshot
    assert col["SUI-EUR"] == [False, False, False, False, True, False]  # only from 2025-01
    assert not any(col["HBAR-EUR"][:5])                                 # never top 15 before 2025-07
    assert col["LUNA-EUR"] == [False, False, True, False, False, False] # 2022-01 snapshot only
    assert col["MIOTA-EUR"][5] and col["POL-EUR"][2] and col["BTC-EUR"] == [True] * 6
    pool_ok = set().union(*[e for _, e in u.snapshot_eligible()])
    assert set(u.PIT_POOL) <= pool_ok
