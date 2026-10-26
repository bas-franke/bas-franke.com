"""Ranks experiments and builds the dashboard's research payload (stonks/SPEC.md section 7).

Ranking is by the out-of-sample ``score`` computed by ``stonks_lab.evaluate`` (walk-forward folds; the holdout is
reported, never tuned on). The top list is diversified: at most ``per_family`` (2) entries per family, and a
candidate within ``near_tolerance`` relative parameter distance of an already chosen one (same family, interval,
markets) is skipped, and so is one that trades the same as a chosen one (same trades, same fold returns / holdout
curve), so the top 5 isn't five variants of one idea. Only results of the current evaluation version
(registry.EVAL_VERSION) are compared, and specs that sit in cash (median fold exposure < 10 %, evaluate's
``eligible``) or barely trade are never ranked. Buy and hold is a benchmark, never a candidate.
"""
from __future__ import annotations

import datetime as dt
import math
from pathlib import Path
from typing import Any

from . import registry as reg

EXCLUDED_FAMILIES = {"buy_hold", "buy_and_hold", "hold", "benchmark"}
MARKET_NAMES = {"BTC-EUR": "BTC", "ETH-EUR": "ETH"}

METRIC_KEYS = ["finalEur", "returnPct", "cagrPct", "maxDrawdownPct", "sharpe", "trades", "winRatePct", "feesEur",
               "exposurePct", "vsBuyHoldPct", "trainReturnPct", "testPeriod"]
_ALIASES = {
    "finalEur": ["final_eur", "final", "endEur", "finalEquity"],
    "returnPct": ["return_pct", "totalReturnPct", "ret_pct"],
    "cagrPct": ["cagr_pct", "cagr"],
    "maxDrawdownPct": ["max_drawdown_pct", "maxDD", "mddPct", "maxDdPct"],
    "sharpe": ["sharpeRatio", "sharpe_ratio"],
    "trades": ["numTrades", "n_trades", "tradeCount"],
    "winRatePct": ["win_rate_pct", "winRate"],
    "feesEur": ["fees_eur", "fees"],
    "exposurePct": ["exposure_pct", "exposure"],
    "vsBuyHoldPct": ["vs_buy_hold_pct"],
    "trainReturnPct": ["train_return_pct"],
    "testPeriod": ["test_period", "period"],
}


# --------------------------------------------------------------------------------------------- ranking

def test_trades(e: dict) -> int | None:
    """Fills summed over the walk-forward test folds (evaluate's scoreParts.testTrades), None if unknown."""
    parts = (e.get("metrics") or {}).get("scoreParts") or {}
    v = parts.get("testTrades")
    return int(v) if isinstance(v, (int, float)) else None


def ineligible_reason(e: dict, min_test_trades: int = 5) -> str | None:
    """Why an experiment may not be ranked (None = it may). Sitting in cash is not a strategy: evaluate marks a
    spec ineligible when its median fold exposure is under 10 %; fewer than ``min_test_trades`` fills in the test
    folds is the same thing in disguise. Buy and hold is the benchmark, never a candidate."""
    if e["family"] in EXCLUDED_FAMILIES:
        return "benchmark family"
    if e.get("score") is None or not math.isfinite(e["score"]):
        return "no score"
    parts = (e.get("metrics") or {}).get("scoreParts") or {}
    if parts.get("eligible") is False:
        return parts.get("ineligibleReason") or "not eligible"
    tt = test_trades(e)
    if tt is not None and tt < min_test_trades:
        return f"only {tt} test-fold trades"
    return None


def _fold_returns(e: dict) -> list | None:
    folds = (e.get("metrics") or {}).get("folds")
    if not isinstance(folds, list) or not folds:
        return None
    out = []
    for f in folds:
        t = f.get("test") if isinstance(f, dict) else None
        if not isinstance(t, dict) or t.get("returnPct") is None:
            return None
        out.append((f.get("fold"), round(float(t["returnPct"]), 2), t.get("trades")))
    return out


def _curve_returns(e: dict):
    eq = (e.get("curves") or {}).get("equity") or []
    if len(eq) < 3:
        return None, None
    ts = [p[0] for p in eq]
    v = [float(p[1]) for p in eq]
    return ts, [(v[i + 1] / v[i] - 1.0) if v[i] else 0.0 for i in range(len(v) - 1)]


def same_outcome(a: dict, b: dict, min_corr: float = 0.995) -> bool:
    """True when two experiments trade (nearly) identically even if their params differ, e.g. a knob that never
    binds: same interval and markets, same number of trades in the test folds and the holdout, and the same fold
    returns (within 0.5 points or 2 %, same trades per fold), about the same holdout return, and holdout equity curves whose bar returns correlate
    above ``min_corr``."""
    if a["interval"] != b["interval"] or a["markets"] != b["markets"]:
        return False
    if test_trades(a) != test_trades(b) or (a.get("holdout") or {}).get("trades") != (b.get("holdout") or {}).get("trades"):
        return False
    ha, hb = (a.get("holdout") or {}).get("returnPct"), (b.get("holdout") or {}).get("returnPct")
    if ha is not None and hb is not None and abs(ha - hb) > max(0.5, 0.02 * max(abs(ha), abs(hb))):
        return False
    fa, fb = _fold_returns(a), _fold_returns(b)
    if fa is not None and fb is not None:
        if len(fa) != len(fb) or any(x[0] != y[0] or x[2] != y[2] or abs(x[1] - y[1]) > max(0.5, 0.02 * max(abs(x[1]), abs(y[1])))
                                    for x, y in zip(fa, fb)):
            return False
    ta, ra = _curve_returns(a)
    tb, rb = _curve_returns(b)
    if ra is None or rb is None or ta != tb:
        return fa is not None and fb is not None       # folds identical, no comparable curve: same
    sa, sb = max(ra) - min(ra), max(rb) - min(rb)
    if sa == 0 or sb == 0:
        return sa == sb and (fa is not None and fb is not None)
    import numpy as np
    return float(np.corrcoef(ra, rb)[0, 1]) > min_corr


PIT = "top10_pit"


def survivorship_biased(e: dict) -> bool:
    """A fixed list of more than two coins chosen today (e.g. today's top 10) knows which coins survived."""
    return (e.get("spec") or {}).get("universe") != PIT and len(e.get("markets") or []) > 2


def pit_twin_spec(spec: dict) -> dict:
    """The same strategy on the point-in-time top-10 universe (stonks_lab/universe.py)."""
    from .universe import pit_pool
    twin = {k: v for k, v in spec.items() if k not in ("id", "name")}
    twin["markets"] = pit_pool()
    twin["universe"] = PIT
    return twin


def pit_check(registry: reg.Registry, e: dict, twin: dict | None = None, looked_up: bool = False) -> dict | None:
    """For a survivorship-biased experiment: its point-in-time twin's verdict, or None when the twin has not been
    evaluated (with the current method) yet. ``passed`` = the twin is eligible and beat buy and hold of the
    point-in-time members (mean fold excess > 0)."""
    t = twin
    if not looked_up:
        try:
            t = registry.get_exact(reg.spec_hash(pit_twin_spec(e["spec"])))
        except Exception:  # noqa: BLE001 - missing universe module/data
            return None
    if not t or t.get("status") != "done" or t.get("eval_version") != reg.EVAL_VERSION:
        return None
    parts = (t.get("metrics") or {}).get("scoreParts") or {}
    mx = parts.get("meanExcessLogPct")
    return {"hash": t["spec_hash"], "score": t.get("score"), "meanExcessLogPct": mx,
            "passed": bool(t.get("score") is not None and parts.get("eligible") and mx is not None and mx > 0)}


def rank(registry: reg.Registry, n: int = 5, per_family: int = 2, near_tolerance: float = 0.25,
         bot_ready_only: bool = False, pool: int = 3000, min_test_trades: int = 5) -> list[dict]:
    """The best ``n`` diverse done experiments of the current evaluation version, best first. Skips ineligible
    specs (:func:`ineligible_reason`), more than ``per_family`` per family, parameter near-duplicates of a chosen
    one, and specs that trade the same as a chosen one (:func:`same_outcome`), so only the best-scoring copy stays.
    A survivorship-biased spec (today's top-10 list) is ranked only when its point-in-time twin (``lab.py
    pit-twins``) also beat buy and hold, by min(own score, twin score) (``rawScore`` keeps its own), and the twin is
    not listed separately; the payload says so."""
    cands: list[dict] = []
    twins: set[str] = set()
    rows = [e for e in registry.top(pool, bot_ready_only=bot_ready_only) if not ineligible_reason(e, min_test_trades)]
    twin_of: dict[str, str] = {}
    for e in rows:
        if survivorship_biased(e):
            try:
                twin_of[e["spec_hash"]] = reg.spec_hash(pit_twin_spec(e["spec"]))
            except Exception:  # noqa: BLE001
                pass
    found = registry.get_many(list(set(twin_of.values())))
    for e in rows:
        if survivorship_biased(e):             # ranked only when it also wins on the point-in-time universe,
            th = twin_of.get(e["spec_hash"])   # and then by the honest (point-in-time) score
            chk = pit_check(registry, e, found.get(th), looked_up=True) if th else None
            if not chk or not chk["passed"]:
                continue
            twins.add(chk["hash"])
            e = dict(e, pitCheck=chk, rawScore=e["score"], score=min(e["score"], chk["score"]))
        cands.append(e)
    cands = [e for e in cands if e["spec_hash"] not in twins]      # represented by the spec they verify
    cands.sort(key=lambda e: e["score"], reverse=True)
    chosen: list[dict] = []
    per: dict[str, int] = {}
    for e in cands:
        fam = e["family"]
        if per.get(fam, 0) >= per_family:
            continue
        if any(c["family"] == fam and c["interval"] == e["interval"] and c["markets"] == e["markets"]
               and reg.param_distance(c["spec"], e["spec"]) <= near_tolerance for c in chosen):
            continue
        if any(same_outcome(c, e) for c in chosen):
            continue
        chosen.append(e)
        per[fam] = per.get(fam, 0) + 1
        if len(chosen) >= n:
            break
    return chosen


# --------------------------------------------------------------------------------------------- metrics

def _num(x: Any) -> Any:
    if x is None:
        return None
    if hasattr(x, "item"):
        x = x.item()
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        if isinstance(x, float) and not math.isfinite(x):
            return None
        return round(x, 4) if isinstance(x, float) else x
    return x


def _pick(d: dict, key: str) -> Any:
    if not isinstance(d, dict):
        return None
    if key in d:
        return d[key]
    for a in _ALIASES.get(key, []):
        if a in d:
            return d[a]
    return None


def curve_stats(equity: list) -> dict:
    if not equity or len(equity) < 2:
        return {"returnPct": None, "maxDrawdownPct": None}
    vals = [float(p[1]) for p in equity]
    peak, mdd = vals[0], 0.0
    for v in vals:
        peak = max(peak, v)
        if peak > 0:
            mdd = max(mdd, (peak - v) / peak)
    return {"returnPct": round((vals[-1] / vals[0] - 1) * 100, 2) if vals[0] else None,
            "maxDrawdownPct": round(mdd * 100, 2)}


def _iso_day(t: Any) -> str | None:
    if t is None:
        return None
    if isinstance(t, str):
        return t[:10]
    try:
        t = float(t)
        if t > 1e11:  # ms
            t /= 1000
        return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return str(t)


def metrics_for(e: dict) -> dict:
    """SPEC section 7 metrics of an experiment, out-of-sample (holdout)."""
    h = e.get("holdout") or {}
    m = e.get("metrics") or {}
    curves = e.get("curves") or {}
    out: dict[str, Any] = {}
    for k in METRIC_KEYS:
        v = _pick(h, k)
        if v is None and k in ("trainReturnPct", "vsBuyHoldPct"):
            v = _pick(m, k)
        out[k] = v
    eq = curves.get("equity") or []
    bh = curves.get("buyHoldEquity") or []
    if out["returnPct"] is None and eq:
        out["returnPct"] = curve_stats(eq)["returnPct"]
    if out["maxDrawdownPct"] is None and eq:
        out["maxDrawdownPct"] = curve_stats(eq)["maxDrawdownPct"]
    if out["finalEur"] is None and eq:
        out["finalEur"] = float(eq[-1][1])
    if out["vsBuyHoldPct"] is None:
        vb = m.get("vsBuyHold")
        if isinstance(vb, (int, float)):
            out["vsBuyHoldPct"] = vb
        elif isinstance(vb, dict) and _pick(vb, "vsBuyHoldPct") is not None:
            out["vsBuyHoldPct"] = _pick(vb, "vsBuyHoldPct")
        elif out["returnPct"] is not None and bh:
            bret = curve_stats(bh)["returnPct"]
            if bret is not None:
                out["vsBuyHoldPct"] = out["returnPct"] - bret
    if out["trainReturnPct"] is None:
        folds = m.get("folds")
        if isinstance(folds, list) and folds:
            rets = [_pick(f, "returnPct") for f in folds if isinstance(f, dict)]
            rets = [r for r in rets if isinstance(r, (int, float))]
            if rets:
                out["trainReturnPct"] = sum(rets) / len(rets)
    tp = out["testPeriod"]
    if not tp and eq:
        tp = [_iso_day(eq[0][0]), _iso_day(eq[-1][0])]
    out["testPeriod"] = [_iso_day(x) for x in tp] if tp else None
    return {k: (_num(v) if k != "testPeriod" else v) for k, v in out.items()}


# --------------------------------------------------------------------------------------------- explanation

def _fmt(x: float | None, signed: bool = False) -> str:
    if x is None:
        return "?"
    s = f"{x:+.1f}" if signed else f"{x:.1f}"
    return s + " %"


def holding_name(markets: list[str]) -> str:
    if len(markets) == 1:
        return MARKET_NAMES.get(markets[0], markets[0].split("-")[0])
    if len(markets) == 2 and set(markets) == {"BTC-EUR", "ETH-EUR"}:
        return "BTC and ETH (50/50)"
    return f"an equal-weight basket of its {len(markets)} markets"


def vs_buy_hold_sentence(metrics: dict, bh_return: float | None, bh_mdd: float | None, markets: list[str]) -> str:
    """Honest one/two-sentence comparison with buy and hold of the same market(s) over the test period."""
    r, d = metrics.get("returnPct"), metrics.get("maxDrawdownPct")
    tp = metrics.get("testPeriod") or [None, None]
    what = holding_name(markets)
    period = f"from {tp[0]} to {tp[1]}" if tp and tp[0] else "over the test period"
    if r is None or bh_return is None:
        return f"No buy-and-hold comparison is available for {what} {period}."
    diff = r - bh_return
    if metrics.get("trades") == 0:
        verb = "avoided" if bh_return < 0 else "missed"
        return (f"It made no trades {period} and stayed in euros, so it simply {verb} the {_fmt(bh_return)} of "
                f"buying and holding {what}; that says little about how it trades.")
    risk = ""
    if d is not None and bh_mdd is not None:
        if d < bh_mdd - 1:
            risk = f" Its worst drop was {_fmt(d)} against {_fmt(bh_mdd)} for holding, so it was the calmer ride."
        elif d > bh_mdd + 1:
            risk = f" It also fell harder at its worst ({_fmt(d)} against {_fmt(bh_mdd)} for holding)."
        else:
            risk = f" Its worst drop ({_fmt(d)}) was about the same as holding ({_fmt(bh_mdd)})."
    if abs(diff) < 1:
        return f"{period.capitalize()} it returned {_fmt(r)}, about the same as simply buying and holding {what} ({_fmt(bh_return)}).{risk}"
    if diff > 0:
        return (f"{period.capitalize()} it returned {_fmt(r)} while simply buying and holding {what} returned "
                f"{_fmt(bh_return)}: {abs(diff):.1f} percentage points better.{risk}")
    lost = " and lost money" if r < 0 else ""
    return (f"It lost to buy and hold{lost}: {_fmt(r)} {period} against {_fmt(bh_return)} for just holding {what}, "
            f"{abs(diff):.1f} percentage points worse.{risk}")


def family_explain(family: str, spec: dict) -> dict:
    try:
        from .families import FAMILIES  # type: ignore
        fam = FAMILIES.get(family) if hasattr(FAMILIES, "get") else None
        fn = getattr(fam, "explain", None) if fam is not None else None
        if fn is None and isinstance(fam, dict):
            fn = fam.get("explain")
        if fn is not None:
            ex = fn(spec)
            if isinstance(ex, dict):
                return ex
            if isinstance(ex, str):
                return {"summary": ex}
    except Exception:  # noqa: BLE001 - explanation is best effort
        pass
    return {"summary": f"{family} strategy on {', '.join(spec.get('markets', []))} ({spec.get('interval')}).",
            "howItWorks": [f"Parameters: {spec.get('params')}"], "whenItWins": "", "whenItLoses": ""}


def family_bot_ready(family: str, fallback: Any = None) -> bool:
    try:
        from .families import FAMILIES  # type: ignore
        fam = FAMILIES.get(family)
        if fam is not None:
            v = getattr(fam, "bot_ready", None)
            if v is None and isinstance(fam, dict):
                v = fam.get("bot_ready")
            if v is not None:
                return bool(v)
    except Exception:  # noqa: BLE001
        pass
    return bool(fallback)


def explanation_for(e: dict, metrics: dict) -> dict:
    ex = dict(family_explain(e["family"], e["spec"]))
    bh = (e.get("curves") or {}).get("buyHoldEquity") or []
    h = e.get("holdout") or {}
    bh_ret = h.get("buyHoldReturnPct")
    bh_mdd = h.get("buyHoldMaxDrawdownPct")
    if bh:
        cs = curve_stats(bh)
        bh_ret = cs["returnPct"] if bh_ret is None else bh_ret
        bh_mdd = cs["maxDrawdownPct"] if bh_mdd is None else bh_mdd
    elif bh_ret is None and metrics.get("returnPct") is not None and metrics.get("vsBuyHoldPct") is not None:
        bh_ret = metrics["returnPct"] - metrics["vsBuyHoldPct"]
    vs = vs_buy_hold_sentence(metrics, bh_ret, bh_mdd, e["markets"])
    chk = e.get("pitCheck")
    if chk:
        vs += (f" Caution: it trades today's top-10 coins, which flatters any backtest (it 'knows' which coins "
               f"survived). Re-run on the coins that were the top 10 at each moment, it still beat buy and hold "
               f"(by {chk['meanExcessLogPct']:+.1f} log-points per test period on average).")
    out = {
        "summary": ex.get("summary") or "",
        "howItWorks": list(ex.get("howItWorks") or []),
        "whenItWins": ex.get("whenItWins") or "",
        "whenItLoses": ex.get("whenItLoses") or "",
        "vsBuyHold": vs,
    }
    return out


# --------------------------------------------------------------------------------------------- benchmarks

def _bench_list(raw: Any) -> list[dict]:
    if raw is None:
        return []
    items = list(raw.items()) if isinstance(raw, dict) else [(None, x) for x in raw]
    out = []
    for key, b in items:
        if not isinstance(b, dict):
            continue
        eq = reg.downsample(b.get("equity") or [])
        cs = curve_stats(eq)
        name = b.get("name") or _bench_name(key)
        out.append({"name": name,
                    "returnPct": _num(_pick(b, "returnPct") if _pick(b, "returnPct") is not None else cs["returnPct"]),
                    "maxDrawdownPct": _num(_pick(b, "maxDrawdownPct") if _pick(b, "maxDrawdownPct") is not None
                                           else cs["maxDrawdownPct"]),
                    "equity": eq})
    return out


def _bench_name(key: Any) -> str:
    k = str(key or "")
    if k.upper().startswith("BTC"):
        return "Buy and hold BTC"
    if k.upper().startswith("ETH"):
        return "Buy and hold ETH"
    if "top" in k.lower() or "basket" in k.lower():
        return "Equal-weight top-10 basket"
    return k or "Benchmark"


def benchmarks_for(entries: list[dict]) -> tuple[dict, list[dict]]:
    """(benchmark = buy and hold BTC, [buy and hold ETH, equal-weight top-10]) from the stored holdout curves."""
    bench: list[dict] = []
    for e in entries:
        bench = _bench_list((e.get("curves") or {}).get("benchmarks"))
        if bench:
            break
    if not bench:  # fall back to the single-market buy-and-hold curves of the entries themselves
        seen = set()
        for e in entries:
            if len(e["markets"]) == 1 and e["markets"][0] not in seen:
                eq = (e.get("curves") or {}).get("buyHoldEquity") or []
                if eq:
                    seen.add(e["markets"][0])
                    cs = curve_stats(eq)
                    bench.append({"name": _bench_name(e["markets"][0]), "equity": eq, **cs})
    btc = next((b for b in bench if "BTC" in b["name"]), None)
    rest = [b for b in bench if b is not btc]
    if btc is None:
        btc = {"name": "Buy and hold BTC", "returnPct": None, "maxDrawdownPct": None, "equity": []}
    return btc, rest


# --------------------------------------------------------------------------------------------- payload

def data_range(entries: list[dict]) -> list[str | None]:
    try:
        from . import data  # type: ignore
        # [(market, interval, first_ts, last_ts, rows), ...]; the range of the markets the top strategies use
        used = {m for e in entries for m in e["markets"]} or {"BTC-EUR", "ETH-EUR"}
        rows = [x for x in data.available() if x[0] in used and x[4]]
        if rows:
            return [_iso_day(min(x[2] for x in rows)), _iso_day(max(x[3] for x in rows))]
    except Exception:  # noqa: BLE001
        pass
    tps = [metrics_for(e).get("testPeriod") for e in entries]
    tps = [t for t in tps if t]
    return [min(t[0] for t in tps), max(t[1] for t in tps)] if tps else [None, None]


def notes(registry: reg.Registry, entries: list[dict], max_chars: int = 600) -> str:
    st = registry.stats()
    parts = [f"{st['done']} experiments finished by {st['agents']} agent{'s' if st['agents'] != 1 else ''} over "
             f"{st['rounds']} round{'s' if st['rounds'] != 1 else ''}."]
    if entries:
        m = metrics_for(entries[0])
        vb = m.get("vsBuyHoldPct")
        lead = f"Best so far: {entries[0]['spec'].get('name') or entries[0]['family']}"
        if m.get("returnPct") is not None:
            lead += f", {m['returnPct']:.1f} % in the test period"
        if vb is not None:
            lead += f" ({vb:+.1f} points vs buy and hold)"
        parts.append(lead + ".")
    parts.append("Cross-coin strategies are tested on the coins that were the top 10 at each moment (no "
                 "hindsight; coins Bitvavo has delisted, like EOS, are missing, so a little survivorship remains); "
                 "ones built on today's top-10 list are only shown when they also win that way, with that score.")
    lessons = [f["text"] for f in registry.findings(limit=3)]
    if lessons:
        parts.append("Latest lessons: " + " / ".join(lessons))
    s = " ".join(parts)
    return s if len(s) <= max_chars else s[: max_chars - 1] + "…"


def entry_payload(rank_no: int, e: dict) -> dict:
    metrics = metrics_for(e)
    curves = e.get("curves") or {}
    spec = dict(e["spec"])
    return {
        "rank": rank_no,
        "spec": spec,
        "botReady": family_bot_ready(e["family"], e.get("bot_ready")),
        "metrics": metrics,
        "equity": reg.downsample(curves.get("equity") or []),
        "buyHoldEquity": reg.downsample(curves.get("buyHoldEquity") or []),
        "explanation": explanation_for(e, metrics),
        "lineage": {"experimentId": e["spec_hash"], "agent": e.get("agent"), "round": e.get("round"),
                    "parent": e.get("parent")},
        "score": _num(e.get("score")),
    }


def build_payload(registry: reg.Registry | None = None, n: int = 5) -> dict:
    registry = registry or reg.default()
    entries = rank(registry, n=n)
    st = registry.stats()
    btc, others = benchmarks_for(entries)
    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": {"experiments": st["experiments"], "families": st["families"], "rounds": st["rounds"],
                    "dataRange": data_range(entries), "notes": notes(registry, entries)},
        "benchmark": btc,
        "benchmarks": others,
        "top": [entry_payload(i + 1, e) for i, e in enumerate(entries)],
    }


def validate_payload(p: dict) -> list[str]:
    """Shape problems against SPEC section 7 (empty list = valid)."""
    errs: list[str] = []
    for k in ("generatedAt", "summary", "benchmark", "benchmarks", "top"):
        if k not in p:
            errs.append(f"missing {k}")
    s = p.get("summary") or {}
    for k in ("experiments", "families", "rounds", "dataRange", "notes"):
        if k not in s:
            errs.append(f"summary.{k} missing")
    for b in [p.get("benchmark")] + list(p.get("benchmarks") or []):
        if not isinstance(b, dict) or not {"name", "returnPct", "maxDrawdownPct", "equity"} <= set(b):
            errs.append(f"bad benchmark {b if not isinstance(b, dict) else b.get('name')}")
        elif len(b["equity"]) > 400:
            errs.append(f"benchmark {b['name']} has {len(b['equity'])} points")
    top = p.get("top") or []
    if len(top) > 5:
        errs.append("top has more than 5 entries")
    for i, t in enumerate(top):
        if t.get("rank") != i + 1:
            errs.append(f"top[{i}].rank should be {i + 1}")
        for k in ("spec", "botReady", "metrics", "equity", "buyHoldEquity", "explanation", "lineage"):
            if k not in t:
                errs.append(f"top[{i}].{k} missing")
        spec = t.get("spec") or {}
        for k in ("id", "name", "family", "markets", "interval", "params"):
            if k not in spec:
                errs.append(f"top[{i}].spec.{k} missing")
        for k in METRIC_KEYS:
            if k not in (t.get("metrics") or {}):
                errs.append(f"top[{i}].metrics.{k} missing")
        for k in ("summary", "howItWorks", "whenItWins", "whenItLoses", "vsBuyHold"):
            if k not in (t.get("explanation") or {}):
                errs.append(f"top[{i}].explanation.{k} missing")
        if len(t.get("equity") or []) > 400:
            errs.append(f"top[{i}].equity has more than 400 points")
    return errs


def write_json(payload: dict, path: Path) -> Path:
    import json
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1, default=reg._default), encoding="utf-8")
    return path
