"""Chart every buy and sell of one strategy: price with trade markers sized by EUR, equity vs buy and hold, exposure,
a full trade table and round trips, as one self-contained HTML file (plus a CSV of the trades).

    .venv/Scripts/python tools/trade_chart.py '{"family":"ema_cross","markets":["BTC-EUR"],"interval":"1d"}'
    .venv/Scripts/python tools/trade_chart.py spec.json --start 2023-01-01 --out out/charts/ema.html
    .venv/Scripts/python tools/trade_chart.py 3f2a9c1b07          # an experiment hash from the registry
    .venv/Scripts/python tools/trade_chart.py 3f2a9c1b07 --holdout  # only its last-365-days holdout window

Writes to out/charts/<family>_<market>_<interval>.html unless --out is given; --open opens it in the browser.
"""
from __future__ import annotations

import argparse
import json
import sys
import webbrowser
from pathlib import Path

LAB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_DIR))

from stonks_lab import backtest as bt  # noqa: E402
from stonks_lab import data, tradechart  # noqa: E402
from stonks_lab.families import get_family, normalize_spec  # noqa: E402

HOLDOUT_DAYS = 365


def load_spec(src: str) -> tuple[dict, str]:
    """(spec, hypothesis) from a JSON file, inline JSON or a registry hash (prefix)."""
    p = Path(src)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8")), ""
    if src.lstrip().startswith("{"):
        return json.loads(src), ""
    from stonks_lab import registry as reg
    e = reg.Registry().get(src)
    if not e:
        sys.exit(f"{src!r} is not a file, JSON or a known experiment hash")
    return e["spec"], e.get("hypothesis") or ""


def chart(spec: dict, *, start=None, end=None, out: str | Path | None = None, title: str | None = None,
          hypothesis: str = "") -> tuple[Path, bt.BacktestResult, bt.BacktestResult]:
    """Backtest ``spec`` between ``start`` and ``end`` (ms or date strings), write the chart, return
    (path, result, buy-and-hold result)."""
    fam = get_family(spec["family"])
    spec = normalize_spec(spec, fam)
    if spec.get("universe"):
        raise SystemExit("universe specs (top10_pit) are not supported by trade_chart yet; pass explicit markets")
    markets = fam.markets_needed(spec)
    candles = data.load_many(markets, spec["interval"])
    s, e = data.to_ms(start), data.to_ms(end)
    targets = None
    if fam.anchored and s is not None:
        targets = fam.targets(candles, spec, start_time=bt.anchor_time(candles, spec, s))
    if targets is None:
        targets = fam.targets(candles, spec)
    index = targets.index.to_numpy()
    bh = bt.buy_and_hold(spec["markets"], candles, start=s, end=e, interval=spec["interval"], index=index)
    res = bt.run(spec, candles, start=s, end=e, targets=targets, bh_equity=bh.equity)
    mk = "+".join(m.split("-")[0] for m in spec["markets"])
    out = Path(out) if out else LAB_DIR / "out" / "charts" / f"{spec['family']}_{mk}_{spec['interval']}.html"
    title = title or f"{fam.title} · {mk} · {spec['interval']}"
    path = tradechart.write(out, res, bh, candles, title=title, hypothesis=hypothesis, explain=fam.explain(spec))
    return path, res, bh


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", help="spec JSON file, inline JSON, or an experiment hash")
    ap.add_argument("--start", help="first bar (date or ms), default: all history")
    ap.add_argument("--end", help="end (exclusive)")
    ap.add_argument("--holdout", action="store_true", help=f"only the last {HOLDOUT_DAYS} days")
    ap.add_argument("--out", help="output .html path")
    ap.add_argument("--open", action="store_true", help="open the chart in the browser")
    a = ap.parse_args(argv)
    spec, hyp = load_spec(a.spec)
    start = a.start
    if a.holdout:
        start = data.now_ms() - HOLDOUT_DAYS * 86_400_000
    path, res, bh = chart(spec, start=start, end=a.end, out=a.out, hypothesis=hyp)
    m, b = res.metrics, bh.metrics
    print(f"{path}\n  return {m['returnPct']:+.1f} % (buy & hold {b['returnPct']:+.1f} %), max drawdown "
          f"{m['maxDrawdownPct']:.1f} %, {m['buys']} buys / {m['sells']} sells, fees EUR {m['feesEur']:.2f}")
    if a.open:
        webbrowser.open(path.as_uri())


if __name__ == "__main__":
    main()
