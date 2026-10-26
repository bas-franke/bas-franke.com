"""high_recency: SMA trend core whose exits are switched off for a while after a new high (agent-03).

Every SMA core on BTC/ETH 1d trails buy and hold in the bull and recovery folds (finding #373): it sells bull
corrections under the average and buys back higher. Bull markets are the stretches where the coin keeps making new
highs. This family holds through those stretches and only lets the trend core sell once the last high is old:

- high = highest close so far (athLook 0) or of the last athLook candles; a bar "is at the high" when its close is
  within nearPct of that high.
- recent = a bar at the high happened within the last recentBars candles (this one included).
- Hold while recent OR close > SMA(coreSma); once held, the core sells only when the close is exitBand under the SMA.

recentBars 0 is the plain SMA core (ablation). Each market is decided on its own candles and gets
maxWeight / len(markets) while held. A decision at bar t uses closes up to and including t only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "high_recency"
VERSION = 1
TITLE = "Trend core that holds while new highs are recent"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"coreSma": 130, "recentBars": 60, "nearPct": 0.0, "athLook": 0, "exitBand": 0.0}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 20, "max": 400, "log": True,
                    "description": "trend core: hold while the close is above this SMA"},
        "recentBars": {"type": "int", "min": 5, "max": 365, "log": True, "zero": True,
                       "description": "ignore the core's sell signal for this many candles after a high (0 = off)"},
        "nearPct": {"type": "float", "min": 0.01, "max": 0.25, "zero": True,
                    "description": "a close within this fraction of the high counts as a high (0 = a new high only)"},
        "athLook": {"type": "int", "min": 90, "max": 1500, "log": True, "zero": True,
                    "description": "high = highest close of the last N candles (0 = highest close so far)"},
        "exitBand": {"type": "float", "min": 0.01, "max": 0.2, "log": True, "zero": True,
                     "description": "the core sells only when the close is this far under the SMA"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return max(int(p["coreSma"]), int(p.get("athLook") or 0)) - 1


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def recent_high(c: np.ndarray, p: dict) -> np.ndarray:
    """True where a close at (or within nearPct of) the high happened within the last recentBars candles."""
    c = np.asarray(c, dtype=np.float64)
    n = len(c)
    k = int(p.get("recentBars") or 0)
    if k <= 0:
        return np.zeros(n, dtype=bool)
    look = int(p.get("athLook") or 0)
    s = pd.Series(c)
    high = (s.cummax() if look <= 0 else s.rolling(look, min_periods=look).max()).to_numpy()
    at = np.isfinite(high) & (c >= high * (1.0 - float(p.get("nearPct") or 0.0)))
    return pd.Series(at.astype(float)).rolling(k, min_periods=1).max().to_numpy() > 0


def _held(c: np.ndarray, p: dict) -> np.ndarray:
    sma = ind.sma(c, int(p["coreSma"]))
    rec = recent_high(c, p)
    band = float(p.get("exitBand") or 0.0)
    out = np.full(len(c), np.nan)
    inside = False
    for i in range(len(c)):
        x, m = c[i], sma[i]
        if not (np.isfinite(x) and np.isfinite(m)):
            continue
        if inside:
            if not rec[i] and x < m * (1.0 - band):
                inside = False
        elif rec[i] or x > m:
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
    look = int(p.get("athLook") or 0)
    high = "its highest price so far" if look <= 0 else f"its highest price of the last {bars_text(look, iv)}"
    near = float(p.get("nearPct") or 0)
    band = float(p.get("exitBand") or 0)
    rb = int(p.get("recentBars") or 0)
    steps = [
        f"It holds {mk} while the price is above its average of the last {bars_text(p['coreSma'], iv)}"
        + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        (f"After {mk} closes at {high}" + (f" (or within {pct(near)} of it)" if near > 0 else "")
         + f", it ignores sell signals for {bars_text(rb, iv)}: bull markets keep making new highs.") if rb > 0
        else "There is no new-high rule in this variant (plain trend core).",
        "Otherwise it sells once the price is "
        + (f"{pct(band)} or more under the average." if band > 0 else "under the average."),
    ]
    return {
        "summary": f"A trend strategy on {mk} that does not sell while new highs are recent.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with sharp corrections: it sits through the dip instead of selling low and "
                      "buying back higher.",
        "whenItLoses": "Crashes that start right at a new high (it keeps holding for a while) and long sideways "
                       "markets around the average.",
    }
