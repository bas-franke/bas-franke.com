"""Parity fixtures (SPEC §6): real candles + the Python family's target weights, replayed by the TypeScript bot.

    python -m stonks_lab.parity            # export all v1 families
    python -m stonks_lab.parity ema_cross  # just one

Each fixture is ``stonks/backend/test/fixtures/parity/<family>.json``:

    { "spec": {...full strategy spec...},
      "candles": { "<market>": [[t, o, h, l, c, v], ...] },
      "targets": [[t, { "<market>": weight }], ...] }

``targets`` starts at the first bar where the Python family makes a decision (indicators warm) and covers every
bar after it; the TypeScript side must match each weight to 1e-9. Candles are ~600 real 4h Bitvavo candles that end
at a fixed date, so re-exporting gives the same file unless a family changes.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from .families import FAMILIES, V1_FAMILIES, normalize_spec

REPO = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO / "stonks" / "backend" / "test" / "fixtures" / "parity"
INTERVAL = "4h"
N_CANDLES = 600
END_MS = 1_790_812_800_000  # 2026-10-01T00:00:00Z (exclusive): fixed so fixtures are reproducible

# Params chosen so each family changes its mind often within ~600 candles (and exercises its options).
FIXTURE_SPECS: dict[str, dict] = {
    "ema_cross": {"markets": ["BTC-EUR"], "params": {"fast": 9, "slow": 30}},
    "macd_trend": {"markets": ["BTC-EUR"], "params": {"fast": 12, "slow": 26, "signal": 9, "requirePositive": True}},
    "donchian_breakout": {"markets": ["BTC-EUR"], "params": {"entry": 20, "exit": 10}},
    "rsi_dip": {"markets": ["BTC-EUR"], "params": {"period": 14, "buyBelow": 40, "sellAbove": 65, "trendSma": 100}},
    "bollinger_reversion": {"markets": ["BTC-EUR"], "params": {"period": 20, "stdDev": 1.8, "exitAt": "middle"}},
    "dca_dip": {"markets": ["BTC-EUR"], "risk": {"maxWeight": 0.8},
                "params": {"everyBars": 12, "tranches": 20, "dipPct": 0.06, "lookback": 30, "takeProfitPct": 0.08,
                           "sellFraction": 0.3}},
    "rotation_momentum": {"markets": ["BTC-EUR", "ETH-EUR"], "risk": {"maxWeight": 0.9},
                          "params": {"lookback": 24, "top": 1, "regimeSma": 100}},
}


def _load(market: str) -> pd.DataFrame:
    from . import data
    df = data.load_candles(market, INTERVAL, end=END_MS)
    return df.iloc[-N_CANDLES:]


def fixture_spec(family: str) -> dict:
    fam = FAMILIES[family]
    base = FIXTURE_SPECS[family]
    spec = {
        "id": f"{family}-parity",
        "name": f"{fam.title} (parity fixture)",
        "family": family,
        "familyVersion": fam.version,
        "markets": base["markets"],
        "interval": INTERVAL,
        "params": base["params"],
        "risk": base.get("risk", {}),
        "execution": {},
    }
    s = normalize_spec(spec, fam)
    return {k: s[k] for k in ("id", "name", "family", "familyVersion", "markets", "interval", "params", "risk",
                              "execution")}


def _num(x):
    x = float(x)
    return int(x) if x.is_integer() and abs(x) < 2**53 else x


def build_fixture(family: str, candles: dict[str, pd.DataFrame] | None = None) -> dict:
    fam = FAMILIES[family]
    spec = fixture_spec(family)
    markets = fam.markets_needed(spec)
    if candles is None:
        candles = {m: _load(m) for m in markets}
    t = fam.targets(candles, spec)
    v = t.to_numpy(np.float64)
    valid = ~np.isnan(v).all(axis=1)
    if not valid.any():
        raise ValueError(f"{family}: no decisions in the fixture candles")
    first = int(np.argmax(valid))
    if np.isnan(v[first:]).any():
        raise ValueError(f"{family}: NaN weights after the first decision")
    cols = list(t.columns)
    targets = [[int(ts), {m: float(v[i, j]) for j, m in enumerate(cols)}]
               for i, ts in enumerate(t.index.to_numpy()) if i >= first]
    out_c = {}
    for m in markets:
        df = candles[m]
        rows = np.column_stack([df.index.to_numpy(np.int64).astype(np.float64),
                                df[["open", "high", "low", "close", "volume"]].to_numpy(np.float64)])
        out_c[m] = [[int(r[0])] + [_num(x) for x in r[1:]] for r in rows]
    return {"spec": spec, "candles": out_c, "targets": targets}


def summarize(fx: dict) -> str:
    ms = list(fx["targets"][0][1])
    w = np.array([[row[1][m] for m in ms] for row in fx["targets"]])
    changes = int((np.abs(np.diff(w, axis=0)) > 1e-12).any(axis=1).sum())
    return f"{len(fx['targets'])} target rows, {changes} changes, mean weight {w.sum(axis=1).mean():.3f}"


def export_fixture(family: str, out_dir: Path | str | None = None, candles=None) -> Path:
    fx = build_fixture(family, candles)
    d = Path(out_dir) if out_dir else FIXTURE_DIR
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{family}.json"
    for row in fx["targets"]:
        for m, x in row[1].items():
            assert math.isfinite(x)
    p.write_text(json.dumps(fx, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    return p


def export_all(out_dir=None) -> list[Path]:
    return [export_fixture(f, out_dir) for f in V1_FAMILIES]


def main(argv: list[str]) -> int:
    fams = argv or V1_FAMILIES
    for f in fams:
        p = export_fixture(f)
        print(f"{f:20s} -> {p.relative_to(REPO)}  ({summarize(json.loads(p.read_text()))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
