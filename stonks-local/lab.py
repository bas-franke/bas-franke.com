#!/usr/bin/env python
"""Stonks research lab CLI. Run with the lab's venv:

    stonks-local/.venv/Scripts/python stonks-local/lab.py <command> [...]

Commands: status, coverage, findings, top, show, check, families, lanes, lane, run, sweep, finding, publish, digest.
See RESEARCH.md for the protocol the research agents follow.
"""
from __future__ import annotations

import argparse
import datetime as dt
import itertools
import json
import math
import os
import random
import sys
import threading
import time
import traceback
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from pathlib import Path

LAB_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(LAB_DIR))

from stonks_lab import leaderboard  # noqa: E402
from stonks_lab import registry as reg  # noqa: E402

STOP_FILE = LAB_DIR / "STOP"
FINDINGS_FILE = LAB_DIR / "FINDINGS.md"

LANES = {
    "dca": "DCA variants: schedules, tranche sizes, dip add-ons, take-profit",
    "dip": "Buy the dip: RSI/drawdown/z-score entries, trend-filtered dips",
    "trend": "Trend following: EMA/SMA crosses, MACD, ADX, time-series momentum",
    "breakout": "Breakouts: Donchian, range/volatility breakouts, new highs",
    "reversion": "Mean reversion: Bollinger, z-score, RSI-2, short-term reversal",
    "rotation": "Cross-asset rotation and relative strength vs the top-10 cryptos",
    "regime": "Regime filters: BTC trend, volatility, breadth of the top-10",
    "multi-tf": "Multi-timeframe: slow filter + fast entries",
    "scalp": "Minute-level (1m-15m) scalping with full fees",
    "long": "Weekly / long-horizon (1d, 1W) allocation",
    "ensemble": "Combinations and ensembles of families",
    "risk": "Risk overlays: stops, trailing stops, take-profit, position sizing, maxWeight",
    "execution": "Execution: limit offsets, timeouts, market fallback (maker vs taker)",
    "invent": "New family invention",
}


# --------------------------------------------------------------------------------------------- engine access

def families() -> dict:
    from stonks_lab.families import FAMILIES  # type: ignore
    return FAMILIES


def fam_attr(fam, name, default=None):
    if isinstance(fam, dict):
        return fam.get(name, default)
    v = getattr(fam, name, default)
    return v


def fam_call(fam, name, *args):
    fn = fam_attr(fam, name)
    if fn is None:
        return None
    return fn(*args) if callable(fn) else fn


def is_multi_market(fam) -> bool:
    v = fam_attr(fam, "multi_market")
    if v is None:
        v = fam_attr(fam, "multiMarket")
    return bool(v)


def top10() -> list[str]:
    from stonks_lab.universe import top10 as t10  # type: ignore
    return list(t10())


def resolve_markets(tokens: list[str] | None, fam=None) -> list[str]:
    if not tokens:
        return top10() if fam is not None and is_multi_market(fam) else ["BTC-EUR"]
    out: list[str] = []
    for t in tokens:
        for part in t.split(","):
            p = part.strip()
            if not p:
                continue
            if p.lower() in ("top10", "universe"):
                out.extend(top10())
            else:
                p = p.upper()
                out.append(p if "-" in p else f"{p}-EUR")
    return sorted(dict.fromkeys(out))


def markets_label(markets: list[str]) -> str:
    try:
        if len(markets) > 2 and set(markets) == set(top10()):
            return "top10"
    except Exception:  # noqa: BLE001
        pass
    if len(markets) > 3:
        return f"{len(markets)}mkts"
    return "-".join(m.split("-")[0].lower() for m in markets)


def make_spec(family: str, interval: str, markets: list[str], params: dict, risk: dict | None = None,
              execution: dict | None = None, family_version: int | None = None) -> dict:
    fam = families().get(family)
    fv = family_version or (fam_attr(fam, "version") or fam_attr(fam, "familyVersion") or 1 if fam else 1)
    spec = {"family": family, "familyVersion": int(fv), "markets": sorted(markets), "interval": interval,
            "params": params, "risk": {**reg.DEFAULT_RISK, **(risk or {})},
            "execution": {**reg.DEFAULT_EXECUTION, **(execution or {})}}
    return complete_spec(spec)


def complete_spec(spec: dict) -> dict:
    spec = dict(spec)
    spec["markets"] = sorted(spec.get("markets") or [])
    spec["risk"] = {**reg.DEFAULT_RISK, **(spec.get("risk") or {})}
    spec["execution"] = {**reg.DEFAULT_EXECUTION, **(spec.get("execution") or {})}
    fam = families().get(spec["family"]) if _families_ok() else None
    if fam is not None:  # fill the family's defaults so {"fast": 12} and the full param set hash the same
        spec["params"] = {**(fam_call(fam, "default_params") or {}), **(spec.get("params") or {})}
        if "familyVersion" not in spec or spec["familyVersion"] is None:
            spec["familyVersion"] = fam_attr(fam, "version") or 1
    h = reg.spec_hash(spec)
    label = markets_label(spec["markets"])
    spec.setdefault("id", f"{spec['family']}-{label}-{spec['interval']}-{h[:6]}")
    spec.setdefault("familyVersion", 1)
    if "name" not in spec:
        title = (fam_attr(fam, "title") or fam_attr(fam, "label")) if fam is not None else None
        title = title or spec["family"].replace("_", " ").capitalize()
        mk = label.upper() if label != "top10" else "top-10"
        spec["name"] = f"{title}, {mk} {spec['interval']}"
    return spec


def _families_ok() -> bool:
    try:
        families()
        return True
    except Exception:  # noqa: BLE001
        return False


def grid_values(d: dict, n: int = 5) -> list:
    """A handful of values for one param-space descriptor (see stonks_lab/families/_base.py)."""
    t = d.get("type")
    if t == "bool":
        return [False, True]
    if t == "choice":
        return list(d["values"])
    lo, hi = d["min"], d["max"]
    if d.get("log") and lo > 0:
        vals = [math.exp(math.log(lo) + (math.log(hi) - math.log(lo)) * i / (n - 1)) for i in range(n)]
    else:
        vals = [lo + (hi - lo) * i / (n - 1) for i in range(n)]
    vals = [int(round(v)) for v in vals] if t == "int" else [round(v, 4) for v in vals]
    if d.get("zero"):
        vals = [0] + vals
    return sorted(dict.fromkeys(vals))


def param_error(fam, params: dict) -> str | None:
    fn = fam_attr(fam, "validate")
    if callable(fn):
        try:
            return fn({"params": params})
        except Exception as e:  # noqa: BLE001
            return f"{e.__class__.__name__}: {e}"
    return None


# --------------------------------------------------------------------------------------------- evaluation

def _heartbeat_loop(db: str, h: str, stop: threading.Event) -> None:
    r = reg.Registry(db)
    while not stop.wait(600):
        try:
            r.heartbeat(h)
        except Exception:  # noqa: BLE001
            pass


def evaluate_and_record(spec: dict, db: str, agent: str, round_: int, hypothesis: str | None,
                        parent: str | None) -> dict:
    """Runs in a worker process: evaluate an already claimed spec and record the outcome."""
    r = reg.Registry(db)
    h = reg.spec_hash(spec)
    stop = threading.Event()
    threading.Thread(target=_heartbeat_loop, args=(db, h, stop), daemon=True).start()
    t0 = time.time()
    try:
        from stonks_lab.evaluate import evaluate  # type: ignore
        result = evaluate(spec)
        bot_ready = leaderboard.family_bot_ready(spec["family"])
        r.record(spec, result, agent=agent, round=round_, hypothesis=hypothesis, parent=parent, bot_ready=bot_ready)
        return {"hash": h, "ok": True, "score": result.get("score"), "holdout": _short_holdout(result),
                "seconds": round(time.time() - t0, 1)}
    except BaseException as e:  # noqa: BLE001
        err = f"{e.__class__.__name__}: {e}\n{traceback.format_exc(limit=6)}"
        try:
            r.record(spec, None, agent=agent, round=round_, hypothesis=hypothesis, parent=parent, error=err[:4000])
        except Exception:  # noqa: BLE001
            pass
        return {"hash": h, "ok": False, "error": f"{e.__class__.__name__}: {e}", "seconds": round(time.time() - t0, 1)}
    finally:
        stop.set()


def _short_holdout(result: dict) -> dict:
    h = result.get("holdout") or {}
    keys = ("returnPct", "vsBuyHoldPct", "maxDrawdownPct", "sharpe", "trades")
    return {k: h.get(k) for k in keys if k in h}


# --------------------------------------------------------------------------------------------- output helpers

def out(obj, as_json: bool) -> None:
    if as_json:
        print(json.dumps(obj, indent=1, default=reg._default))
    else:
        print(obj)


def fnum(x, nd=2, signed=False):
    if x is None:
        return "-"
    try:
        return f"{x:+.{nd}f}" if signed else f"{x:.{nd}f}"
    except (TypeError, ValueError):
        return str(x)


def table(rows: list[list], headers: list[str]) -> str:
    rows = [[("" if c is None else str(c)) for c in r] for r in rows]
    w = [max([len(h)] + [len(r[i]) for r in rows]) for i, h in enumerate(headers)]
    lines = ["  ".join(h.ljust(w[i]) for i, h in enumerate(headers)), "  ".join("-" * x for x in w)]
    lines += ["  ".join(c.ljust(w[i]) for i, c in enumerate(r)) for r in rows]
    return "\n".join(lines)


def exp_row(e: dict) -> list:
    m = leaderboard.metrics_for(e)
    return [e["spec_hash"][:10], e["family"], e["interval"], markets_label(e["markets"]), fnum(e.get("score"), 3),
            fnum(m.get("returnPct"), 1), fnum(m.get("vsBuyHoldPct"), 1, True), fnum(m.get("maxDrawdownPct"), 1),
            m.get("trades") if m.get("trades") is not None else "-", e.get("agent") or "-",
            json.dumps(e["spec"].get("params"), separators=(",", ":"))[:60]]


EXP_HEAD = ["hash", "family", "iv", "mkts", "score", "test%", "vsBH", "maxDD", "trades", "agent", "params"]


def market_sets_for(fam) -> list[str]:
    return ["top10"] if is_multi_market(fam) else ["BTC-EUR", "ETH-EUR"]


def coverage_data(r: reg.Registry) -> dict:
    fams = {}
    try:
        fams = families()
    except Exception:  # noqa: BLE001
        pass
    cov = r.coverage()
    # map rotation/top-10 market sets to the label "top10" for untried-cell bookkeeping
    tried = {(c["family"], c["interval"], markets_label(c["markets"].split(",")) if c["markets"].count(",") > 1
              else c["markets"]) for c in cov["cells"] if c["done"]}
    have = set()
    try:
        from stonks_lab import data  # type: ignore
        have = {(x[0], x[1]) for x in data.available() if x[4]}
    except Exception:  # noqa: BLE001
        pass
    untried = []
    for name, fam in fams.items():
        for iv in reg.INTERVALS:
            for ms in market_sets_for(fam):
                if (name, iv, ms) not in tried:
                    has = (ms if ms != "top10" else "BTC-EUR", iv) in have
                    untried.append({"family": name, "interval": iv, "markets": ms, "data": has})
    cov["untried"] = untried
    return cov


# --------------------------------------------------------------------------------------------- commands

def cmd_status(a, r: reg.Registry):
    st = r.stats()
    cov = coverage_data(r)
    lanes = r.lanes()
    top = leaderboard.rank(r, n=5)
    if a.json:
        return out({"stats": st, "stop": STOP_FILE.exists(), "lanes": lanes, "cells": len(cov["cells"]),
                    "untried": len(cov["untried"]), "top": [exp_row(e) for e in top]}, True)
    print(f"experiments {st['experiments']} (done {st['done']}, failed {st['failed']}, running {st['running']}), "
          f"families {st['families']}, findings {st['findings']}, rounds {st['rounds']} (max {st['maxRound']}), "
          f"agents {st['agents']}, cpu {st['cpuHours']} h")
    print(f"coverage: {len(cov['cells'])} family x interval x markets cells tried, {len(cov['untried'])} untried")
    print("STOP file present: research must stop." if STOP_FILE.exists() else "STOP file absent: keep researching.")
    if lanes:
        print("\nactive lanes:")
        print(table([[l["lane"], l["agent"], l["round"], l["note"] or "",
                      f"{(time.time() - l['heartbeat_at']) / 60:.0f} min ago"] for l in lanes],
                    ["lane", "agent", "round", "note", "heartbeat"]))
    if top:
        print("\ntop 5 (diverse, by out-of-sample score):")
        print(table([exp_row(e) for e in top], EXP_HEAD))


def cmd_coverage(a, r):
    cov = coverage_data(r)
    cells = [c for c in cov["cells"] if not a.family or c["family"] == a.family]
    untried = [c for c in cov["untried"] if not a.family or c["family"] == a.family]
    if a.json:
        return out({"cells": cells, "untried": untried}, True)
    if not a.untried:
        print(table([[c["family"], c["interval"], markets_label(c["markets"].split(",")), c["done"], c["failed"],
                      c["running"], fnum(c["best"], 3)] for c in cells],
                    ["family", "iv", "mkts", "done", "failed", "running", "best"]))
    print(f"\nuntried cells ({len(untried)}):")
    by_fam: dict[str, list[str]] = {}
    for u in untried:
        by_fam.setdefault(f"{u['family']} [{u['markets']}]", []).append(u["interval"] + ("" if u["data"] else "*"))
    for k, ivs in by_fam.items():
        print(f"  {k}: {' '.join(ivs)}")
    if any(not u["data"] for u in untried):
        print("  * no candles downloaded yet: tools/download.py --markets <m> --intervals <iv> first")


def cmd_findings(a, r):
    fs = r.findings(lane=a.lane, limit=a.limit, agent=a.agent, tag=a.tag)
    if a.json:
        return out(fs, True)
    for f in reversed(fs):
        when = dt.datetime.fromtimestamp(f["created_at"]).strftime("%m-%d %H:%M")
        tags = f" [{','.join(f['tags'])}]" if f["tags"] else ""
        ev = f" (evidence {', '.join(h[:10] for h in f['evidence'])})" if f["evidence"] else ""
        print(f"#{f['id']} {when} {f['lane'] or '-'} {f['agent'] or '-'} r{f['round']}{tags}: {f['text']}{ev}")


def cmd_top(a, r):
    rows = (leaderboard.rank(r, n=a.n) if a.diverse else r.top(a.n, bot_ready_only=a.bot_ready, family=a.family))
    if a.json:
        return out([{"hash": e["spec_hash"], "score": e["score"], "spec": e["spec"],
                     "metrics": leaderboard.metrics_for(e)} for e in rows], True)
    print(table([exp_row(e) for e in rows], EXP_HEAD))


def cmd_show(a, r):
    e = r.get(a.hash)
    if not e:
        sys.exit(f"no experiment {a.hash}")
    e = dict(e)
    if e.get("curves"):
        e["curves"] = {k: (f"{len(v)} points" if isinstance(v, list) else v) for k, v in e["curves"].items()
                       if k != "benchmarks"}
    out(e, True)


def load_spec_arg(src: str) -> dict:
    text = sys.stdin.read() if src == "-" else (Path(src).read_text(encoding="utf-8") if Path(src).exists() else src)
    return complete_spec(json.loads(text))


def cmd_check(a, r):
    spec = load_spec_arg(a.spec)
    h = reg.spec_hash(spec)
    near = r.near_duplicates(spec, a.tolerance)
    out({"hash": h, "seen": r.seen(spec), "nearDuplicates": near, "spec": spec}, True)


def cmd_families(a, r):
    fams = families()
    rows = []
    for name, fam in fams.items():
        try:
            space = fam_call(fam, "param_space")
            default = fam_call(fam, "default_params")
        except Exception as e:  # noqa: BLE001
            space, default = f"error {e}", None
        rows.append({"family": name, "botReady": bool(fam_attr(fam, "bot_ready")), "multiMarket": is_multi_market(fam),
                     "version": fam_attr(fam, "version") or fam_attr(fam, "familyVersion") or 1,
                     "defaults": default, "space": space})
    if a.json:
        return out(rows, True)
    for x in rows:
        print(f"{x['family']} v{x['version']}  bot_ready={x['botReady']}  multi_market={x['multiMarket']}")
        print(f"   defaults: {json.dumps(x['defaults'], default=str)}")
        print(f"   space:    {json.dumps(x['space'], default=str)}")


def cmd_lanes(a, r):
    lanes = r.lanes()
    if a.json:
        return out({"lanes": LANES, "active": lanes}, True)
    held: dict[str, list[str]] = {}
    for l in lanes:
        held.setdefault(l["lane"], []).append(f"{l['agent']} (r{l['round']})")
    for k, v in LANES.items():
        print(f"{k:10} {', '.join(held.get(k, [])) or 'free':28} {v}")
    for k in held:
        if k not in LANES:
            print(f"{k:10} {', '.join(held[k]):28} (custom lane)")


def cmd_lane(a, r):
    if a.action == "claim":
        ok = r.claim_lane(a.lane, a.agent, a.round, a.note, max_agents=a.max_agents)
        print(f"lane {a.lane} claimed by {a.agent}" if ok else
              f"lane {a.lane} is full ({a.max_agents} agents hold it): pick another (lab.py lanes)")
        sys.exit(0 if ok else 3)
    if a.action == "release":
        r.release_lane(a.lane, a.agent, a.note)
        print(f"lane {a.lane} released by {a.agent}")


def _print_run(res: dict, spec: dict) -> None:
    if res["ok"]:
        print(f"done {res['hash']} {spec['id']}: score {fnum(res['score'], 3)} holdout {json.dumps(res['holdout'])} "
              f"({res['seconds']} s)")
    else:
        print(f"FAILED {res['hash']} {spec['id']}: {res['error']} ({res['seconds']} s)")


def cmd_run(a, r):
    spec = load_spec_arg(a.spec)
    fam = families().get(spec["family"])
    if fam is None:
        sys.exit(f"unknown family {spec['family']}; known: {', '.join(families())}")
    err = param_error(fam, spec["params"])
    if err:
        sys.exit(f"invalid params: {err}")
    near = [n for n in r.near_duplicates(spec, a.tolerance) if n["spec_hash"] != reg.spec_hash(spec)]
    if near and not a.allow_near:
        print(f"refused: near-duplicate of {', '.join(n['spec_hash'][:10] for n in near[:5])} "
              f"(within {a.tolerance:.0%}); change the idea or pass --allow-near with a reason in --hypothesis")
        sys.exit(3)
    if not r.claim(spec, agent=a.agent, round=a.round, hypothesis=a.hypothesis, parent=a.parent,
                   retry_failed=a.retry_failed):
        e = r.get(reg.spec_hash(spec))
        print(f"refused: {reg.spec_hash(spec)} already {e['status'] if e else 'claimed'}"
              f"{' with score ' + fnum(e['score'], 3) if e and e.get('score') is not None else ''} "
              f"(by {e.get('agent') if e else '?'}); lab.py show {reg.spec_hash(spec)[:10]}")
        sys.exit(3)
    res = evaluate_and_record(spec, str(r.path), a.agent, a.round, a.hypothesis, a.parent)
    if a.json:
        return out(res, True)
    _print_run(res, spec)
    sys.exit(0 if res["ok"] else 1)


def candidates(fam, family: str, interval: str, markets: list[str], fixed: dict, risk: dict, execution: dict,
               samples: int, grid: bool, seed: int | None):
    space = dict(fam_call(fam, "param_space") or {})
    base = dict(fam_call(fam, "default_params") or {})
    for k in fixed:
        space.pop(k, None)
    rng = random.Random(seed)
    if grid:
        keys = list(space)
        combos = list(itertools.product(*[grid_values(space[k]) for k in keys]))
        rng.shuffle(combos)
        stream = ({**base, **dict(zip(keys, combo)), **fixed} for combo in combos)
    else:
        from stonks_lab.families import sample_params  # type: ignore
        stream = ({**base, **sample_params(space, rng), **fixed} for _ in range(samples * 30))
    for params in stream:
        if param_error(fam, params) is None:
            yield make_spec(family, interval, markets, params, risk, execution)


def cmd_sweep(a, r):
    fams = families()
    if a.family not in fams:
        sys.exit(f"unknown family {a.family}; known: {', '.join(fams)}")
    fam = fams[a.family]
    markets = resolve_markets(a.markets, fam)
    fixed = json.loads(a.params) if a.params else {}
    risk = json.loads(a.risk) if a.risk else {}
    execution = json.loads(a.execution) if a.execution else {}
    workers = max(1, min(a.workers, 6))
    db = str(r.path)
    submitted, skipped_seen, skipped_near, results = 0, 0, 0, []
    gen = candidates(fam, a.family, a.interval, markets, fixed, risk, execution, a.samples, a.grid, a.seed)
    inflight: dict = {}
    print(f"sweep {a.family} {a.interval} {markets_label(markets)}: up to {a.samples} new specs, {workers} workers")
    try:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            while True:
                while len(inflight) < workers * 2 and submitted < a.samples and not STOP_FILE.exists():
                    spec = next(gen, None)
                    if spec is None:
                        break
                    if r.seen(spec):
                        skipped_seen += 1
                        continue
                    if a.tolerance > 0 and r.near_duplicates(spec, a.tolerance, limit=1):
                        skipped_near += 1
                        continue
                    if not r.claim(spec, agent=a.agent, round=a.round, hypothesis=a.hypothesis, parent=a.parent):
                        skipped_seen += 1
                        continue
                    fut = pool.submit(evaluate_and_record, spec, db, a.agent, a.round, a.hypothesis, a.parent)
                    inflight[fut] = spec
                    submitted += 1
                if not inflight:
                    break
                done, _ = wait(list(inflight), return_when=FIRST_COMPLETED)
                for fut in done:
                    spec = inflight.pop(fut)
                    try:
                        res = fut.result()
                    except Exception as e:  # noqa: BLE001 - worker crashed hard
                        r.record(spec, None, agent=a.agent, round=a.round, error=f"worker crashed: {e}")
                        res = {"hash": reg.spec_hash(spec), "ok": False, "error": str(e), "seconds": 0}
                    results.append((res, spec))
                    if not a.quiet:
                        _print_run(res, spec)
    except KeyboardInterrupt:
        for spec in inflight.values():
            r.release(spec)
        print("interrupted; unfinished claims released")
        raise
    ok = [x for x in results if x[0]["ok"] and x[0].get("score") is not None]
    ok.sort(key=lambda x: x[0]["score"], reverse=True)
    print(f"\nsweep finished: {len(results)} evaluated ({len(results) - len(ok)} failed/no score), "
          f"{skipped_seen} already seen, {skipped_near} near-duplicates skipped"
          f"{', STOP file present' if STOP_FILE.exists() else ''}")
    for res, spec in ok[:5]:
        print(f"  {res['hash'][:10]} score {fnum(res['score'], 3)} {json.dumps(spec['params'], separators=(',', ':'))} "
              f"holdout {json.dumps(res['holdout'])}")


def cmd_finding(a, r):
    if len(a.text) > 400:
        sys.exit("a finding is a short lesson (<= 400 chars); split it")
    ev = [h.strip() for h in (a.evidence or "").split(",") if h.strip()]
    full = []
    for h in ev:
        e = r.get(h)
        if e is None:
            sys.exit(f"evidence {h} is not a known experiment hash")
        full.append(e["spec_hash"])
    fid = r.add_finding(a.text, lane=a.lane, agent=a.agent, round=a.round, tags=a.tags, evidence=full)
    print(f"finding #{fid} recorded")


def cmd_publish(a, r):
    from stonks_lab import publish
    res = publish.publish(r, dry_run=a.dry_run)
    print(json.dumps(res, indent=1, default=reg._default))
    if not res["ok"]:
        print(f"publish did not reach the dashboard: {res.get('error')} (payload kept in {res['file']}; "
              "carry on researching)", file=sys.stderr)
        sys.exit(2)


def cmd_digest(a, r):
    text = digest_text(r)
    FINDINGS_FILE.write_text(text, encoding="utf-8")
    print(f"wrote {FINDINGS_FILE} ({len(text.splitlines())} lines)")


def digest_text(r: reg.Registry) -> str:
    st = r.stats()
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    L = ["# Stonks research findings", "",
         f"Generated by `lab.py digest` on {now}. Do not edit by hand: add findings with `lab.py finding`.", "",
         f"{st['done']} experiments done ({st['failed']} failed), {st['families']} families, {st['findings']} findings, "
         f"{st['rounds']} rounds, {st['agents']} agents, {st['cpuHours']} CPU hours.", "",
         "## Top 10 (diverse, out-of-sample score)", ""]
    top = leaderboard.rank(r, n=10, per_family=3)
    if top:
        L.append("| # | hash | family | iv | markets | score | test % | vs B&H | max DD | trades | params |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|")
        for i, e in enumerate(top, 1):
            m = leaderboard.metrics_for(e)
            L.append(f"| {i} | `{e['spec_hash'][:10]}` | {e['family']} | {e['interval']} | "
                     f"{markets_label(e['markets'])} | {fnum(e['score'], 3)} | {fnum(m.get('returnPct'), 1)} | "
                     f"{fnum(m.get('vsBuyHoldPct'), 1, True)} | {fnum(m.get('maxDrawdownPct'), 1)} | "
                     f"{m.get('trades') if m.get('trades') is not None else '-'} | "
                     f"`{json.dumps(e['spec'].get('params'), separators=(',', ':'))[:70]}` |")
    else:
        L.append("Nothing finished yet.")
    fs = r.findings(limit=None)
    dead = [f for f in fs if "dead-end" in f["tags"]]
    by_lane: dict[str, list[dict]] = {}
    for f in fs:
        if "dead-end" not in f["tags"]:
            by_lane.setdefault(f["lane"] or "general", []).append(f)
    L += ["", "## Lessons per lane (newest first, at most 8 each)", ""]
    for lane in sorted(by_lane):
        L.append(f"### {lane}")
        for f in by_lane[lane][:8]:
            ev = f" ({', '.join('`' + h[:10] + '`' for h in f['evidence'][:3])})" if f["evidence"] else ""
            L.append(f"- {f['text']}{ev} ({f['agent'] or '?'}, r{f['round']})")
        if len(by_lane[lane]) > 8:
            L.append(f"- ... {len(by_lane[lane]) - 8} older: `lab.py findings --lane {lane}`")
        L.append("")
    L += ["## Dead ends (don't retry without a new angle)", ""]
    L += [f"- [{f['lane'] or '-'}] {f['text']}" for f in dead[:30]] or ["None recorded yet."]
    L += ["", "## Coverage (best score per family x interval; blank = untried)", ""]
    cov = r.coverage()["cells"]
    fams = sorted({c["family"] for c in cov})
    if fams:
        grid: dict = {}
        for c in cov:
            k = (c["family"], c["interval"])
            g = grid.setdefault(k, [0, None])
            g[0] += c["done"] or 0
            if c["best"] is not None and (g[1] is None or c["best"] > g[1]):
                g[1] = c["best"]
        ivs = [iv for iv in reg.INTERVALS if any((f, iv) in grid for f in fams)]
        L.append("| family | " + " | ".join(ivs) + " |")
        L.append("|---|" + "---|" * len(ivs))
        for f in fams:
            cells = []
            for iv in ivs:
                g = grid.get((f, iv))
                cells.append("" if not g or not g[0] else f"{fnum(g[1], 2)} ({g[0]})")
            L.append(f"| {f} | " + " | ".join(cells) + " |")
    else:
        L.append("Nothing tried yet.")
    return "\n".join(L) + "\n"


# --------------------------------------------------------------------------------------------- main

def main(argv=None):
    p = argparse.ArgumentParser(prog="lab.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", help="registry path (default stonks-local/data/lab.sqlite or $STONKS_LAB_DB)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_):
        sp = sub.add_parser(name, help=help_)
        sp.set_defaults(fn=fn)
        sp.add_argument("--json", action="store_true", help="machine-readable output")
        return sp

    def who(sp, required=True):
        sp.add_argument("--agent", required=required)
        sp.add_argument("--round", type=int, required=required)

    add("status", cmd_status, "stats, active lanes, coverage summary, top 5")
    sp = add("coverage", cmd_coverage, "tried cells per family x interval x markets, untried cells")
    sp.add_argument("--family")
    sp.add_argument("--untried", action="store_true", help="only list untried cells")
    sp = add("findings", cmd_findings, "shared lessons")
    sp.add_argument("--lane")
    sp.add_argument("--agent")
    sp.add_argument("--tag")
    sp.add_argument("--limit", type=int, default=40)
    sp = add("top", cmd_top, "best experiments by out-of-sample score")
    sp.add_argument("-n", type=int, default=10)
    sp.add_argument("--diverse", action="store_true", help="max 2 per family, no near-identical (as published)")
    sp.add_argument("--bot-ready", action="store_true")
    sp.add_argument("--family")
    sp = add("show", cmd_show, "one experiment in full (hash prefix ok)")
    sp.add_argument("hash")
    sp = add("check", cmd_check, "is a spec already seen / near-duplicate? (doesn't run it)")
    sp.add_argument("spec", help="spec.json path, '-' for stdin, or inline JSON")
    sp.add_argument("--tolerance", type=float, default=0.05)
    add("families", cmd_families, "families with defaults and param spaces")
    add("lanes", cmd_lanes, "lanes and who holds them")
    sp = add("lane", cmd_lane, "claim or release a lane")
    sp.add_argument("action", choices=["claim", "release"])
    sp.add_argument("lane")
    sp.add_argument("--agent", required=True)
    sp.add_argument("--round", type=int)
    sp.add_argument("--note", help="claim: what you'll try; release: one-line summary")
    sp.add_argument("--max-agents", type=int, default=2)
    sp = add("run", cmd_run, "claim -> evaluate -> record one spec")
    sp.add_argument("spec", help="spec.json path, '-' for stdin, or inline JSON")
    who(sp)
    sp.add_argument("--hypothesis", required=True)
    sp.add_argument("--parent")
    sp.add_argument("--tolerance", type=float, default=0.05)
    sp.add_argument("--allow-near", action="store_true")
    sp.add_argument("--retry-failed", action="store_true", help="re-run a spec that failed (after a bug fix)")
    sp = add("sweep", cmd_sweep, "random/grid search over a family's param_space")
    sp.add_argument("--family", required=True)
    sp.add_argument("--interval", required=True, choices=reg.INTERVALS)
    sp.add_argument("--markets", nargs="*", help="BTC-EUR ETH-EUR | BTC,ETH | top10 (default BTC-EUR, top10 for "
                                                 "multi-market families)")
    sp.add_argument("--samples", type=int, default=20, help="new specs to evaluate")
    sp.add_argument("--grid", action="store_true", help="enumerate the grid (shuffled) instead of random sampling")
    sp.add_argument("--params", help="JSON of params to hold fixed")
    sp.add_argument("--risk", help='JSON risk overrides, e.g. {"stopLossPct":0.08}')
    sp.add_argument("--execution", help='JSON execution overrides, e.g. {"orderType":"market"}')
    sp.add_argument("--workers", type=int, default=2, help="parallel processes (max 6; 20 agents share 12 cores)")
    sp.add_argument("--tolerance", type=float, default=0.05, help="near-duplicate distance to skip (0 = off)")
    sp.add_argument("--seed", type=int)
    sp.add_argument("--hypothesis", required=True)
    sp.add_argument("--parent")
    sp.add_argument("--quiet", action="store_true")
    who(sp)
    sp = add("finding", cmd_finding, "record a short lesson")
    sp.add_argument("text")
    sp.add_argument("--lane", required=True)
    who(sp)
    sp.add_argument("--evidence", help="comma-separated experiment hashes (prefixes ok)")
    sp.add_argument("--tags", help="comma-separated, e.g. dead-end,fees,1m")
    sp = add("publish", cmd_publish, "upload the top 5 to the dashboard")
    sp.add_argument("--dry-run", action="store_true", help="only write out/research.json")
    add("digest", cmd_digest, "regenerate FINDINGS.md")

    a = p.parse_args(argv)
    r = reg.Registry(a.db) if a.db else reg.Registry()
    a.fn(a, r)


if __name__ == "__main__":
    main()
