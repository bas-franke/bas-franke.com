"""depth_core: a trend core whose moving-average length depends on how deep the coin is below its high (agent-13).

Why: every SMA core on BTC/ETH 1d loses the recovery and bull folds (2022-07..2023-04, 2023-05..2024-02) to hold,
because a slow average re-enters late after a bottom and a fast one whipsaws near the highs (findings #324, #373).
An unrecorded study (agent-13, 2019-2025) found that while BTC/ETH sit under a 130-day SMA, the next 30 days are
best when the coin is far under its high and has strong 20-day momentum, and worst just under the average. This
family uses one average or the other depending on that depth:

- deep = close is more than ``depth`` below the highest close of the last ``highLen`` candles;
- the active average is MA(fastLen) while deep (re-enter early on strength after a crash) and MA(slowLen)
  otherwise (hold through noise near the highs);
- buy when the close is above the active average; sell once the close has been below the active average for
  ``confirmBars`` consecutive candles (1 = at the first close below).

``depth`` 0 switches the fast average off (a plain slow core, the ablation). Every market is decided on its own
candles and gets maxWeight / len(markets) while held. A decision at bar t uses closes up to and including t only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "depth_core"
VERSION = 1
TITLE = "Depth-switched trend core"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"slowLen": 200, "fastLen": 50, "depth": 0.4, "highLen": 365, "confirmBars": 1}


def param_space() -> dict:
    return {
        "slowLen": {"type": "int", "min": 60, "max": 400, "log": True,
                    "description": "slow average used near the highs"},
        "fastLen": {"type": "int", "min": 5, "max": 150, "log": True,
                    "description": "fast average used while the coin is deep under its high"},
        "depth": {"type": "float", "min": 0.15, "max": 0.75, "zero": True,
                  "description": "how far under the recent high counts as deep (0 = never: plain slow core)"},
        "highLen": {"type": "int", "min": 90, "max": 540, "log": True,
                    "description": "candles over which the recent high is measured"},
        "confirmBars": {"type": "int", "min": 1, "max": 10,
                        "description": "consecutive closes under the active average needed to sell"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["fastLen"]) >= int(p["slowLen"]):
        return "fastLen must be shorter than slowLen"
    return None


def warmup(p: dict) -> int:
    return max(int(p["slowLen"]), int(p["highLen"])) - 1


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _held(c: np.ndarray, p: dict) -> np.ndarray:
    n = len(c)
    slow = ind.sma(c, int(p["slowLen"]))
    fast = ind.sma(c, int(p["fastLen"]))
    hl = int(p["highLen"])
    high = pd.Series(c).rolling(hl, min_periods=hl).max().to_numpy()
    depth = float(p.get("depth") or 0.0)
    need = max(1, int(p.get("confirmBars") or 1))
    out = np.full(n, np.nan)
    inside, below = False, 0
    for i in range(n):
        x, s, f, h = c[i], slow[i], fast[i], high[i]
        if not (np.isfinite(x) and np.isfinite(s) and np.isfinite(f) and np.isfinite(h)):
            continue
        deep = depth > 0 and x < h * (1.0 - depth)
        ma = f if deep else s
        if x < ma:
            below += 1
        else:
            below = 0
        if inside:
            if below >= need:
                inside = False
        elif x > ma:
            inside = True
        out[i] = 1.0 if inside else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = [_asof(candles[m], _held(candles[m]["close"].to_numpy(np.float64), p), idx) * each for m in markets]
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    depth = float(p.get("depth") or 0)
    need = int(p.get("confirmBars") or 1)
    steps = [
        f"Normally it follows the slow average of the last {bars_text(p['slowLen'], iv)}: it holds {mk} while the "
        f"price is above it" + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
    ]
    if depth > 0:
        steps.append(
            f"After a crash (the price {pct(depth)} or more under its highest close of the last "
            f"{bars_text(p['highLen'], iv)}) it switches to the fast average of the last "
            f"{bars_text(p['fastLen'], iv)}, so it buys back early once the price recovers.")
    steps.append(
        "It sells when the price closes under the average it is following"
        + (f" {need} candles in a row." if need > 1 else "."))
    return {
        "summary": f"Trend-follows {mk} with a slow average near the highs and a fast one after a crash.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sharp V-shaped recoveries after a crash (it is back in early) and long bear markets.",
        "whenItLoses": "Dead-cat bounces in a long bear market and choppy markets around the slow average.",
    }
