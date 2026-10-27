"""Scripted research campaign for slice sizing and the TAAPI indicator ladder (no AI agents needed).

    .venv/Scripts/python tools/sweeps/ladder_campaign.py [--phases A,B,C] [--workers 6] [--scale 1.0] [--pause-stop]

Phase A  broad: ``ind_ladder_a24`` random search (indicator x mode x length x slice size x guards) on BTC-EUR and
         ETH-EUR, every interval 1m..1W (fewer samples on the minute intervals, they are slow and fee-bound).
Phase B  refine: the 3 best indicator+mode pairs per interval and market get a focused sweep, and the same pair
         again with the slice fixed at 10 % of the portfolio.
Phase C  the existing leads (best 4 single-market specs of different families per interval and market) wrapped
         in ``step_wrap_a24``: plain 10 % slices, and a random search over slice size, pace and drawdown guards.

Every evaluation goes through ``lab.py sweep`` (registry, duplicate checks, the STOP file). Re-running is safe: seen
specs are skipped. ``--pause-stop`` removes the STOP file for the run and puts it back afterwards. Then
``tools/sweeps/ladder_report.py`` writes LADDER.md.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(LAB))

from stonks_lab.families import FAMILIES, INTERVALS  # noqa: E402

PY = sys.executable
AGENT = "agent-24"
MARKETS = ["BTC-EUR", "ETH-EUR"]
SAMPLES_A = {"1m": 30, "5m": 80, "15m": 200, "30m": 250, "1h": 400, "2h": 400, "4h": 400, "6h": 400, "8h": 400,
             "12h": 400, "1d": 400, "1W": 200}
OWN = {"ind_ladder_a24", "step_wrap_a24"}
LOG = LAB / "out" / "ladder_campaign.log"


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf8") as f:
        f.write(line + "\n")


def sweep(family, interval, market, samples, rnd, hyp, workers, params=None, seed=None):
    cmd = [PY, "lab.py", "sweep", "--family", family, "--interval", interval, "--markets", market,
           "--samples", str(samples), "--agent", AGENT, "--round", str(rnd), "--hypothesis", hyp,
           "--workers", str(workers), "--quiet"]
    if params:
        cmd += ["--params", json.dumps(params)]
    if seed is not None:
        cmd += ["--seed", str(seed)]
    t = time.time()
    p = subprocess.run(cmd, cwd=LAB, capture_output=True, text=True)
    tail = (p.stdout.strip().splitlines() or [""])
    summary = next((ln for ln in tail if ln.startswith("sweep finished")), tail[-1])
    log(f"{family} {interval} {market} n={samples} {json.dumps(params or {})[:90]} -> {summary} "
        f"({time.time() - t:.0f}s){' ERR ' + p.stderr.strip()[-200:] if p.returncode else ''}")


def rows(sql, args=()):
    db = sqlite3.connect(LAB / "data" / "lab.sqlite")
    try:
        return db.execute(sql, args).fetchall()
    finally:
        db.close()


def phase_a(a):
    for iv in INTERVALS[::-1]:  # slow minute intervals last
        for m in MARKETS:
            sweep("ind_ladder_a24", iv, m, max(5, int(SAMPLES_A[iv] * a.scale)), 1,
                  "Broad TAAPI indicator ladder: does any normalized indicator, traded in slices with drawdown "
                  "guards, beat buy and hold out of sample on this interval?", a.workers, seed=24)


def best_pairs(iv, m, k=3):
    got = rows("select params, score from experiments where family='ind_ladder_a24' and status='done' and "
               "score is not null and interval=? and markets=?", (iv, m))
    best: dict[tuple, float] = {}
    for params, score in got:
        p = json.loads(params)
        key = (p["indicator"], p["mode"])
        best[key] = max(best.get(key, -1e9), score)
    return sorted(best, key=best.get, reverse=True)[:k]


def phase_b(a):
    for iv in INTERVALS[::-1]:
        n = max(5, int((15 if iv in ("1m", "5m") else 60) * a.scale))
        for m in MARKETS:
            for ind, mode in best_pairs(iv, m):
                fixed = {"indicator": ind, "mode": mode}
                sweep("ind_ladder_a24", iv, m, n, 2, f"Refine {ind}/{mode}: is the phase A best a plateau or a "
                      "lucky point?", a.workers, fixed, seed=242)
                sweep("ind_ladder_a24", iv, m, max(5, n // 2), 2, f"{ind}/{mode} with fixed 10 % slices: does "
                      "scaling in and out 10 % at a time keep the edge and cut drawdown?", a.workers,
                      {**fixed, "step": 0.1}, seed=243)


def leads(iv, m, k=4):
    skip = {n for n, f in FAMILIES.items() if getattr(f.module, "BENCHMARK", False)
            or getattr(f.module, "DIAGNOSTIC", False) or f.anchored} | OWN | {"floor_wrap_a07"}
    got = rows("select family, params, score, metrics from experiments where status='done' and score is not null "
               "and interval=? and markets=? order by score desc limit 400", (iv, m))
    out, fams = [], set()
    for fam, params, score, metrics in got:
        if fam in skip or fam in fams or fam not in FAMILIES:
            continue
        if not json.loads(metrics).get("scoreParts", {}).get("eligible"):
            continue
        fams.add(fam)
        out.append((fam, json.loads(params), score))
        if len(out) == k:
            break
    return out


def phase_c(a):
    for iv in ["1W", "1d", "12h", "8h", "6h", "4h", "2h", "1h", "30m", "15m"]:
        for m in MARKETS:
            for fam, params, score in leads(iv, m):
                inner = {"family": fam, "params": params}
                hyp = f"Slices on lead {fam} ({score:.1f}): does trading it 10 % at a time cut its drawdown?"
                for st in (0.1, 0.2):
                    sweep("step_wrap_a24", iv, m, 1, 3, hyp, a.workers,
                          {"inner": inner, "step": st, "every": 1, "trendSma": 0, "ddLook": 0, "ddMax": 0.2,
                           "guardExit": False})
                sweep("step_wrap_a24", iv, m, max(4, int(16 * a.scale)), 3, hyp + " Random pace and guards.",
                      a.workers, {"inner": inner}, seed=244)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phases", default="A,B,C")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--scale", type=float, default=1.0, help="multiply all sample counts")
    ap.add_argument("--pause-stop", action="store_true", help="remove STOP for the run, restore it after")
    a = ap.parse_args()
    stop = LAB / "STOP"
    had_stop = stop.exists()
    if had_stop and not a.pause_stop:
        sys.exit("STOP file present: pass --pause-stop to run anyway")
    if had_stop:
        stop.unlink()
    try:
        for ph in a.phases.split(","):
            log(f"=== phase {ph}")
            {"A": phase_a, "B": phase_b, "C": phase_c}[ph.strip()](a)
    finally:
        if had_stop:
            stop.write_text("paused by ladder_campaign\n", encoding="utf8")
    log("campaign done")


if __name__ == "__main__":
    main()
