"""Shared runner for theory scripts (tools/theories/tNN_*.py).

A theory is one falsifiable hypothesis, a few spec variants that test it and a verdict function. Running a theory:

1. backtests every variant over the chosen window (default: all history) next to buy and hold of the same markets,
2. writes a full trade chart per variant (every buy and sell, sized by EUR; see stonks_lab/tradechart.py) plus a
   CSV of the trades to out/theories/<theory>/<variant>.html,
3. runs the lab's walk-forward evaluation (out-of-sample score, holdout) unless --fast,
4. applies the verdict and writes out/theories/<theory>/index.html and result.json.

It never writes to the experiment registry; record a promising variant with ``lab.py run`` afterwards.
"""
from __future__ import annotations

import argparse
import html
import json
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

LAB_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(LAB_DIR))
sys.path.insert(0, str(LAB_DIR / "tools"))

from stonks_lab import evaluate as ev  # noqa: E402
from trade_chart import chart  # noqa: E402

OUT_DIR = LAB_DIR / "out" / "theories"


@dataclass
class Variant:
    label: str
    spec: dict
    note: str = ""


@dataclass
class Theory:
    name: str
    hypothesis: str
    variants: list[Variant]
    # verdict(results) -> (True = supported / False = rejected / None = inconclusive, one-line reason).
    # results: {label: {"metrics": ..., "buyHold": ..., "score": ..., "holdout": ..., "oos": ...}}
    verdict: Callable[[dict], tuple[bool | None, str]]
    start: str | None = None
    end: str | None = None
    tags: list[str] = field(default_factory=list)


def _evaluate(spec: dict) -> dict:
    r = ev.evaluate(spec, with_benchmarks=False)
    return {"score": r.get("score"), "holdout": r.get("holdout"), "validation": r.get("validation"),
            "vsBuyHold": r.get("vsBuyHold")}


def run(theory: Theory, argv=None) -> dict:
    ap = argparse.ArgumentParser(description=theory.hypothesis)
    ap.add_argument("--start", default=theory.start)
    ap.add_argument("--end", default=theory.end)
    ap.add_argument("--fast", action="store_true", help="skip the walk-forward evaluation")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    out_dir = OUT_DIR / theory.name
    out_dir.mkdir(parents=True, exist_ok=True)
    results, t0 = {}, time.perf_counter()
    for v in theory.variants:
        try:
            path, res, bh = chart(v.spec, start=a.start, end=a.end, out=out_dir / f"{v.label}.html",
                                  title=f"{theory.name} · {v.label}",
                                  hypothesis=f"{theory.hypothesis}  [{v.label}{': ' + v.note if v.note else ''}]")
            r = {"chart": path.name, "metrics": res.metrics, "buyHold": bh.metrics, "spec": res.spec}
            if not a.fast:
                r.update(_evaluate(v.spec))
        except Exception as e:  # noqa: BLE001 - one broken variant should not hide the others
            r = {"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()}
        results[v.label] = r
        if not a.quiet:
            _print_row(v.label, r)
    ok = [k for k, r in results.items() if "error" not in r]
    try:
        verdict, why = theory.verdict({k: results[k] for k in ok}) if ok else (None, "every variant failed")
    except Exception as e:  # noqa: BLE001
        verdict, why = None, f"verdict failed: {type(e).__name__}: {e}"
    summary = {"theory": theory.name, "hypothesis": theory.hypothesis, "verdict": verdict, "why": why,
               "window": [a.start, a.end], "seconds": round(time.perf_counter() - t0, 1), "variants": results,
               "tags": theory.tags}
    (out_dir / "result.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    (out_dir / "index.html").write_text(_index_html(summary), encoding="utf-8")
    word = {True: "SUPPORTED", False: "REJECTED", None: "INCONCLUSIVE"}[verdict]
    print(f"\n{theory.name}: {word} - {why}\n  charts: {out_dir / 'index.html'}")
    return summary


def _print_row(label, r):
    if "error" in r:
        print(f"  {label:<22} ERROR {r['error']}")
        return
    m, b = r["metrics"], r["buyHold"]
    sc = r.get("score")
    print(f"  {label:<22} ret {m['returnPct']:+9.1f} %  B&H {b['returnPct']:+8.1f} %  DD {m['maxDrawdownPct']:5.1f} %  "
          f"sharpe {m['sharpe'] if m['sharpe'] is not None else float('nan'):5.2f}  trades {m['trades']:5d}  "
          f"win {m['winRatePct'] if m['winRatePct'] is not None else float('nan'):5.1f} %  "
          f"score {'-' if sc is None else f'{sc:.3f}'}")


def _index_html(s: dict) -> str:
    word = {True: "Supported", False: "Rejected", None: "Inconclusive"}[s["verdict"]]
    col = {True: "#1a8a4a", False: "#c8372d", None: "#a07a00"}[s["verdict"]]
    rows = []
    for k, r in s["variants"].items():
        if "error" in r:
            rows.append(f"<tr><td>{html.escape(k)}</td><td colspan=9>error: {html.escape(r['error'])}</td></tr>")
            continue
        m, b = r["metrics"], r["buyHold"]
        f = lambda x, d=1: "–" if x is None else f"{x:,.{d}f}"  # noqa: E731
        rows.append(f"<tr><td><a href='{html.escape(r['chart'])}'>{html.escape(k)}</a></td><td>{f(m['returnPct'])} %</td>"
                    f"<td>{f(b['returnPct'])} %</td><td>{f(m['maxDrawdownPct'])} %</td><td>{f(m['sharpe'], 2)}</td>"
                    f"<td>{m['buys']} / {m['sells']}</td><td>{f(m['winRatePct'])} %</td><td>€{f(m['feesEur'], 2)}</td>"
                    f"<td>{f(r.get('score'), 3)}</td><td>{f(m['exposurePct'], 0)} %</td></tr>")
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(s['theory'])}</title><style>
:root{{--bg:#fbfaf8;--ink:#1d1d1b;--line:#e6e3dd;--muted:#6b6a66}}
@media (prefers-color-scheme:dark){{:root{{--bg:#161615;--ink:#ecebe7;--line:#34332f;--muted:#9b9992}}}}
body{{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif}}main{{max-width:1100px;margin:0 auto;padding:24px 16px}}
table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}}td,th{{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right}}
td:first-child,th:first-child{{text-align:left}}a{{color:#2f5fd0}}.v{{font-weight:700;color:{col}}}.m{{color:var(--muted)}}
.t{{overflow-x:auto}}</style></head><body><main>
<h1>{html.escape(s['theory'])}</h1><p>{html.escape(s['hypothesis'])}</p>
<p><span class="v">{word}</span> — {html.escape(s['why'])}</p>
<p class="m">window {s['window'][0] or 'all history'} → {s['window'][1] or 'now'} · {s['seconds']} s · click a variant for its full buy/sell chart</p>
<div class="t"><table><tr><th>variant</th><th>return</th><th>buy &amp; hold</th><th>max DD</th><th>sharpe</th><th>buys / sells</th>
<th>win rate</th><th>fees</th><th>OOS score</th><th>invested</th></tr>{''.join(rows)}</table></div>
</main></body></html>"""


# ------------------------------------------------------------------ small helpers for verdicts
def ret(r: dict) -> float:
    return r["metrics"]["returnPct"]


def dd(r: dict) -> float:
    return r["metrics"]["maxDrawdownPct"]


def sharpe(r: dict) -> float:
    return r["metrics"]["sharpe"] or 0.0


def trades(r: dict) -> int:
    return r["metrics"]["trades"]


def win(r: dict) -> float:
    return r["metrics"]["winRatePct"] or 0.0


def bh_ret(r: dict) -> float:
    return r["buyHold"]["returnPct"]


def bh_dd(r: dict) -> float:
    return r["buyHold"]["maxDrawdownPct"]
