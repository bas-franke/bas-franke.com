"""Registry + leaderboard tests: temp DB, cross-process claim atomicity, duplicates, near-duplicates, diversity,
payload shape."""
import json
import multiprocessing as mp
import sys
from pathlib import Path

import pytest

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))

from stonks_lab import leaderboard  # noqa: E402
from stonks_lab import registry as reg  # noqa: E402


def spec(family="ema_cross", interval="4h", markets=("BTC-EUR",), **params):
    p = params or {"fast": 12, "slow": 48}
    return {"id": f"{family}-x", "name": f"{family} test", "family": family, "familyVersion": 1,
            "markets": list(markets), "interval": interval, "params": p}


def result(score, ret=10.0, bh=20.0, n=600):
    eq = [[1_700_000_000_000 + i * 3_600_000, 1000 * (1 + ret / 100 * i / (n - 1))] for i in range(n)]
    bheq = [[t, 1000 * (1 + bh / 100 * i / (n - 1))] for i, (t, _) in enumerate(eq)]
    return {"score": score, "folds": [{"returnPct": 30.0}, {"returnPct": 10.0}],
            "holdout": {"finalEur": eq[-1][1], "returnPct": ret, "cagrPct": 5.0, "maxDrawdownPct": 12.0,
                        "sharpe": 1.1, "trades": 40, "winRatePct": 50.0, "feesEur": 9.0, "exposurePct": 45.0,
                        "vsBuyHoldPct": ret - bh, "testPeriod": ["2024-07-01", "2026-10-25"]},
            "equity": eq, "buyHoldEquity": bheq, "spec_hash": "x", "fingerprint": "fp1",
            "evalVersion": reg.EVAL_VERSION,
            "benchmarks": {"BTC-EUR": {"name": "Buy and hold BTC", "returnPct": 50.0, "maxDrawdownPct": 30.0,
                                       "equity": bheq},
                           "ETH-EUR": {"returnPct": 40.0, "equity": bheq},
                           "top10": {"returnPct": 35.0, "maxDrawdownPct": 40.0, "equity": bheq}}}


@pytest.fixture
def r(tmp_path):
    return reg.Registry(tmp_path / "lab.sqlite")


def test_spec_hash_ignores_id_name_and_defaults():
    a = spec()
    b = dict(spec(), id="other", name="Other", markets=["BTC-EUR"],
             risk={"maxWeight": 1.0}, execution={"orderType": "limit"})
    assert reg.spec_hash(a) == reg.spec_hash(b)
    assert reg.spec_hash(a) != reg.spec_hash(spec(fast=12, slow=50))
    assert reg.spec_hash(spec(fast=12.0, slow=48)) == reg.spec_hash(spec(fast=12, slow=48))


def test_claim_refuses_duplicates_and_records(r):
    s = spec()
    assert r.claim(s, agent="a1", round=1, hypothesis="h")
    assert not r.claim(s, agent="a2", round=1)          # running and fresh
    assert r.seen(s)
    r.record(s, result(1.5), agent="a1", round=1)
    assert not r.claim(s, agent="a2", round=2)          # done
    e = r.get(reg.spec_hash(s))
    assert e["status"] == "done" and e["score"] == 1.5 and e["agent"] == "a1"
    assert len(e["curves"]["equity"]) == 400            # downsampled
    assert e["curves"]["equity"][0] == result(0)["equity"][0]
    assert e["curves"]["equity"][-1] == result(0)["equity"][-1]
    assert r.stats()["done"] == 1


def test_stale_running_and_failed(r):
    s = spec()
    assert r.claim(s, agent="a1", round=1)
    assert r.claim(s, agent="a2", round=1, stale_s=-1)  # stale -> taken over
    r.record(s, None, error="boom")
    assert r.get(reg.spec_hash(s))["status"] == "failed"
    assert not r.claim(s, agent="a3", round=1)
    assert r.claim(s, agent="a3", round=1, retry_failed=True)
    r.release(s)
    assert not r.seen(s)


def _claim_worker(args):
    db, worker = args
    rr = reg.Registry(db)
    won = []
    for i in range(25):
        if rr.claim(spec(fast=i + 2, slow=100), agent=f"w{worker}", round=1):
            won.append(i)
    return won


def test_claim_atomic_across_processes(tmp_path):
    db = str(tmp_path / "lab.sqlite")
    reg.Registry(db)
    ctx = mp.get_context("spawn")
    with ctx.Pool(6) as pool:
        results = pool.map(_claim_worker, [(db, w) for w in range(6)])
    flat = [i for won in results for i in won]
    assert sorted(flat) == list(range(25))              # every spec claimed exactly once
    assert reg.Registry(db).stats()["running"] == 25


def test_near_duplicates(r):
    base = spec(fast=12, slow=48)
    r.claim(base)
    r.record(base, result(1.0))
    near = r.near_duplicates(spec(fast=12, slow=50), tolerance=0.05)
    assert [n["spec_hash"] for n in near] == [reg.spec_hash(base)]
    assert r.near_duplicates(spec(fast=14, slow=48), tolerance=0.05) == []        # 14 vs 12 is 14 %
    assert r.near_duplicates(spec(fast=12, slow=48, interval="1h"), tolerance=0.5) == []
    assert r.near_duplicates(spec(markets=("ETH-EUR",), fast=12, slow=48), tolerance=0.5) == []
    other_exec = dict(spec(fast=12, slow=48), execution={"orderType": "market"})
    assert r.near_duplicates(other_exec, tolerance=0.5) == []                       # non-numeric knob differs
    pit = dict(spec(fast=12, slow=48), universe="top10_pit")
    assert reg.spec_hash(pit) != reg.spec_hash(base)
    assert r.near_duplicates(pit, tolerance=0.5) == []                              # other universe
    bumped = dict(spec(fast=12, slow=48), familyVersion=2)
    assert reg.spec_hash(bumped) != reg.spec_hash(base)
    assert r.near_duplicates(bumped, tolerance=0.5) == []                           # new family version (#346)


def test_findings_lanes_coverage(r):
    s = spec()
    r.claim(s, agent="a1", round=3)
    r.record(s, result(0.7), agent="a1", round=3)
    fid = r.add_finding("EMA 4h beats nothing", lane="trend", agent="a1", round=3, tags="dead-end,fees",
                        evidence=[reg.spec_hash(s)])
    r.add_finding("other", lane="dip", agent="a2", round=3)
    assert fid > 0
    assert [f["text"] for f in r.findings(lane="trend")] == ["EMA 4h beats nothing"]
    assert r.findings(tag="dead-end")[0]["evidence"] == [reg.spec_hash(s)]
    assert len(r.findings()) == 2
    assert r.claim_lane("trend", "a1", 3, max_agents=1)
    assert not r.claim_lane("trend", "a2", 3, max_agents=1)
    assert r.claim_lane("trend", "a1", 4, max_agents=1)                            # refresh own claim
    r.release_lane("trend", "a1", "done")
    assert r.claim_lane("trend", "a2", 3, max_agents=1)
    cov = r.coverage(families=["ema_cross", "rsi_dip"], intervals=["4h", "1d"], market_sets=["BTC-EUR"])
    assert cov["cells"][0]["best"] == 0.7
    assert {(u["family"], u["interval"]) for u in cov["untried"]} == {("ema_cross", "1d"), ("rsi_dip", "4h"),
                                                                      ("rsi_dip", "1d")}
    st = r.stats()
    assert st["findings"] == 2 and st["rounds"] == 1


def _fill(r):
    # 4 ema variants (two near-identical), 3 rsi, 1 macd, 1 buy_hold (benchmark, never a candidate)
    rows = [(spec(fast=12, slow=48), 3.0), (spec(fast=12, slow=49), 2.9), (spec(fast=20, slow=100), 2.8),
            (spec(fast=5, slow=200), 2.7),
            (spec("rsi_dip", period=14, buyBelow=30), 2.6), (spec("rsi_dip", period=7, buyBelow=20), 2.5),
            (spec("rsi_dip", period=3, buyBelow=10), 2.4),
            (spec("buy_hold"), 9.9), (spec("macd_trend", fast=12, slow=26, signal=9), 1.0)]
    for i, (s, sc) in enumerate(rows):
        r.claim(s, agent=f"agent-{i:02d}", round=i)
        r.record(s, result(sc, ret=sc * 10), agent=f"agent-{i:02d}", round=i, bot_ready=True)


def test_leaderboard_diversity(r):
    _fill(r)
    top = leaderboard.rank(r, n=5)
    fams = [e["family"] for e in top]
    assert fams.count("ema_cross") == 2 and fams.count("rsi_dip") == 2 and "buy_hold" not in fams
    assert [e["score"] for e in top] == [3.0, 2.8, 2.6, 2.5, 1.0]                   # 2.9 is a near-copy of 3.0


def test_payload_matches_spec_shape(r):
    _fill(r)
    p = leaderboard.build_payload(r)
    assert leaderboard.validate_payload(p) == []
    assert len(p["top"]) == 5 and [t["rank"] for t in p["top"]] == [1, 2, 3, 4, 5]
    t = p["top"][0]
    assert t["metrics"]["returnPct"] == 30.0 and t["metrics"]["vsBuyHoldPct"] == 10.0
    assert t["metrics"]["trainReturnPct"] == 20.0
    assert len(t["equity"]) <= 400 and len(t["equity"]) == len(t["buyHoldEquity"])
    assert [a[0] for a in t["equity"]] == [b[0] for b in t["buyHoldEquity"]]
    assert p["benchmark"]["name"] == "Buy and hold BTC"
    assert {b["name"] for b in p["benchmarks"]} == {"Buy and hold ETH", "Equal-weight top-10 basket"}
    assert p["summary"]["experiments"] == 9
    assert t["lineage"]["experimentId"] and t["lineage"]["agent"] == "agent-00"
    # 10 % vs 20 % buy and hold on the last one -> the sentence must say it lost
    last = p["top"][-1]
    assert last["explanation"]["vsBuyHold"].startswith("It lost to buy and hold")
    assert "better" in t["explanation"]["vsBuyHold"]
    json.dumps(p)


def test_placebo_is_a_luck_line_not_a_candidate(r):
    _fill(r)
    for seed, sc in ((1, 2.95), (2, -5.0), (3, 0.5)):
        s = spec("placebo_timing", seed=seed, meanIn=60, meanOut=30, coreSma=0)
        r.claim(s)
        r.record(s, result(sc))
    top = leaderboard.rank(r, n=5)
    assert "placebo_timing" not in [e["family"] for e in top]
    p = leaderboard.build_payload(r)
    assert "Luck line" in p["summary"]["notes"] and "best of 3 = 3.0" in p["summary"]["notes"]
    t = p["top"][0]                                          # ema 3.0 on BTC 4h beats the best placebo (2.95)
    assert t["luck"]["n"] == 3 and t["luck"]["bestScore"] == 2.95 and t["luck"]["sameCell"] and t["luck"]["beatsLuck"]
    assert "Luck check: the best of 3" in t["explanation"]["vsLuck"] and "beats luck" in t["explanation"]["vsBuyHold"]
    assert not p["top"][1]["luck"]["beatsLuck"]              # 2.8 < 2.95
    assert leaderboard.validate_payload(p) == []


def test_diagnostic_and_superseded_rows_are_not_ranked(r):
    from stonks_lab.families import FAMILIES
    _fill(r)
    s = spec("phase_shift", preset="sma130", hour=7)
    r.claim(s)
    r.record(s, result(50.0))
    assert "phase_shift" not in [e["family"] for e in leaderboard.rank(r, n=5)]      # hour rerun (#673)
    fam = FAMILIES["ema_cross"]
    old = fam.invalid_below
    fam.invalid_below = 2                                    # ema_cross v1 rows had a (pretend) look-ahead bug
    try:
        assert "ema_cross" not in [e["family"] for e in leaderboard.rank(r, n=5)]
    finally:
        fam.invalid_below = old
    assert "ema_cross" in [e["family"] for e in leaderboard.rank(r, n=5)]
    v1 = spec(fast=12, slow=48)
    assert [x["spec_hash"] for x in r.older_family_versions("ema_cross", 2)][:1] == [reg.spec_hash(v1)]
    assert r.stale_versions(family="rsi_dip") == []


def test_vs_buy_hold_sentence_honest():
    m = {"returnPct": -5.0, "maxDrawdownPct": 10.0, "testPeriod": ["2024-01-01", "2025-01-01"]}
    s = leaderboard.vs_buy_hold_sentence(m, 40.0, 50.0, ["BTC-EUR"])
    assert "lost to buy and hold and lost money" in s and "45.0 percentage points worse" in s and "calmer" in s
    s = leaderboard.vs_buy_hold_sentence({**m, "returnPct": 40.5}, 40.0, 50.0, ["ETH-EUR"])
    assert "about the same" in s and "ETH" in s


def test_empty_payload_is_valid(r):
    p = leaderboard.build_payload(r)
    assert p["top"] == [] and leaderboard.validate_payload(p) == []


def test_rank_skips_specs_that_never_trade(r):
    _fill(r)
    s = spec("rsi_dip", period=40, buyBelow=5)
    res = result(99.0)
    res["scoreParts"] = {"testTrades": 2}
    r.claim(s)
    r.record(s, res)
    assert all(e["score"] != 99.0 for e in leaderboard.rank(r, n=5))


def test_no_trade_sentence():
    m = {"returnPct": 0.0, "maxDrawdownPct": 0.0, "trades": 0, "testPeriod": ["2025-01-01", "2026-01-01"]}
    s = leaderboard.vs_buy_hold_sentence(m, -30.0, 50.0, ["BTC-EUR"])
    assert "no trades" in s and "avoided" in s


def test_rank_skips_near_cash_and_old_eval_versions(r):
    _fill(r)
    s1 = spec("rsi_dip", period=40, buyBelow=5)
    res = result(99.0)
    res["scoreParts"] = {"testTrades": 30, "eligible": False, "ineligibleReason": "median fold exposure 0.0 %"}
    r.record(s1, res)
    s2 = spec("macd_trend", fast=3, slow=90, signal=4)
    old = result(98.0)
    old.pop("evalVersion")                                   # recorded by the old method (NULL = version 1)
    r.record(s2, old)
    top = leaderboard.rank(r, n=5)
    assert all(e["score"] < 90 for e in top)
    assert leaderboard.ineligible_reason(r.get(reg.spec_hash(s1))).startswith("median fold exposure")
    assert 98.0 not in [e["score"] for e in r.top(20)]           # old version: not compared
    assert 98.0 in [e["score"] for e in r.top(20, version=None)]
    assert r.stats()["staleEval"] == 1 and r.stats()["bestScore"] == 99.0


def test_rescore_in_place_is_idempotent(r):
    s = spec()
    r.claim(s, agent="a1", round=2, hypothesis="h")
    old = result(4.0)
    old.pop("evalVersion")
    old["scoreParts"] = {"testTrades": 30}
    r.record(s, old, agent="a1", round=2)
    stale = r.stale_versions()
    assert [x["spec_hash"] for x in stale] == [reg.spec_hash(s)] and stale[0]["spec"]["family"] == "ema_cross"
    new = result(-1.5)
    assert r.rescore(reg.spec_hash(s), new)
    assert not r.rescore(reg.spec_hash(s), new)              # second run: nothing to do
    assert r.stale_versions() == []
    e = r.get(reg.spec_hash(s))
    assert e["score"] == -1.5 and e["eval_version"] == reg.EVAL_VERSION and e["agent"] == "a1" and e["round"] == 2
    assert e["metrics"]["history"] == [{"evalVersion": 1, "score": 4.0, "scoreParts": {"testTrades": 30},
                                        "rescoredAt": e["metrics"]["history"][0]["rescoredAt"]}]


def test_rank_drops_specs_that_trade_identically(r):
    _fill(r)
    s1, s2 = spec("rsi_dip", period=14, buyBelow=30, extra=0), spec("rsi_dip", period=14, buyBelow=30, extra=9)
    for s, sc in ((s1, 5.0), (s2, 4.9)):
        res = result(sc, ret=25.0)
        res["folds"] = [{"fold": i, "test": {"returnPct": 3.0 * i, "trades": 4}} for i in range(1, 7)]
        r.record(s, res)
    top = leaderboard.rank(r, n=5)
    assert [e["score"] for e in top][:2] == [5.0, 3.0] and 4.9 not in [e["score"] for e in top]
    assert leaderboard.same_outcome(r.get(reg.spec_hash(s1)), r.get(reg.spec_hash(s2)))
    assert not leaderboard.same_outcome(r.get(reg.spec_hash(s1)), r.get(reg.spec_hash(spec())))
