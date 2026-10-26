"""depth_core: trend core whose average gets shorter the deeper the coin is below its high (agent-03).

Every SMA core on BTC/ETH 1d trails buy and hold in the recovery and bull folds (finding #373): a long average
re-enters a recovery late, a short average whipsaws through bull corrections (#371). This family lets the drawdown
from the running high choose the speed:

- dd = 1 - close / high, high = highest close so far (athLook 0) or over the last athLook bars.
- a = clip((dd - ddShallow) / (ddDeep - ddShallow), 0, 1): 0 near the high, 1 deep in a bear.
- The average length L = slowLen + (fastLen - slowLen) * a (rounded), a simple moving average of the last L closes.
- Hold while the close is above that average; once held, sell only when the close is exitBand under it.

fastLen == slowLen is the plain SMA core (ablation). Each market is decided on its own candles and gets
maxWeight / len(markets) while held. A decision at bar t uses closes up to and including t only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "depth_core"
VERSION = 1
TITLE = "Drawdown-adaptive trend core"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"slowLen": 150, "fastLen": 40, "ddShallow": 0.2, "ddDeep": 0.5, "athLook": 0, "exitBand": 0.0}


def param_space() -> dict:
    return {
        "slowLen": {"type": "int", "min": 40, "max": 400, "log": True,
                    "description": "average length used near the high (slow: rides bull corrections)"},
        "fastLen": {"type": "int", "min": 5, "max": 200, "log": True,
                    "description": "average length used deep below the high (fast: re-enters recoveries early)"},
        "ddShallow": {"type": "float", "min": 0.0, "max": 0.5,
                      "description": "drawdown up to which the slow average is used"},
        "ddDeep": {"type": "float", "min": 0.1, "max": 0.85,
                   "description": "drawdown from which the fast average is used (linear in between)"},
        "athLook": {"type": "int", "min": 90, "max": 1500, "log": True, "zero": True,
                    "description": "high = highest close of the last N candles (0 = highest close so far)"},
        "exitBand": {"type": "float", "min": 0.01, "max": 0.2, "log": True, "zero": True,
                     "description": "sell only when the close is this far under the average (0 = just under)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["fastLen"]) > int(p["slowLen"]):
        return "fastLen must not exceed slowLen"
    if float(p["ddDeep"]) <= float(p["ddShallow"]):
        return "ddDeep must be above ddShallow"
    return None


def warmup(p: dict) -> int:
    return max(int(p["slowLen"]), int(p.get("athLook") or 0)) - 1


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def levels(c: np.ndarray, p: dict) -> np.ndarray:
    """The adaptive average at every bar (NaN until slowLen closes exist)."""
    c = np.asarray(c, dtype=np.float64)
    n = len(c)
    slow, fast = int(p["slowLen"]), int(p["fastLen"])
    lo, hi = float(p["ddShallow"]), float(p["ddDeep"])
    look = int(p.get("athLook") or 0)
    s = pd.Series(c)
    high = (s.cummax() if look <= 0 else s.rolling(look, min_periods=look).max()).to_numpy()
    dd = 1.0 - c / high
    a = np.clip((dd - lo) / (hi - lo), 0.0, 1.0)
    L = np.rint(slow + (fast - slow) * a)
    cs = np.concatenate([[0.0], np.cumsum(np.nan_to_num(c))])
    out = np.full(n, np.nan)
    i = np.arange(n)
    ok = np.isfinite(L) & (i >= slow - 1)
    Li = L[ok].astype(np.int64)
    ii = i[ok]
    out[ok] = (cs[ii + 1] - cs[ii + 1 - Li]) / Li
    return out


def _held(c: np.ndarray, p: dict) -> np.ndarray:
    lvl = levels(c, p)
    band = float(p.get("exitBand") or 0.0)
    out = np.full(len(c), np.nan)
    inside = False
    for i, (x, m) in enumerate(zip(c.tolist(), lvl.tolist())):
        if not (np.isfinite(x) and np.isfinite(m)):
            continue
        if inside:
            if x < m * (1.0 - band):
                inside = False
        elif x > m:
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
    band = float(p.get("exitBand") or 0)
    steps = [
        f"It measures how far {mk} is below {high}.",
        f"Within {pct(p['ddShallow'])} of that high it follows the average of the last {bars_text(p['slowLen'], iv)}; "
        f"from {pct(p['ddDeep'])} below the high it follows the much shorter average of the last "
        f"{bars_text(p['fastLen'], iv)}, and in between something in the middle.",
        f"It holds {mk} while the price is above that average"
        + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "")
        + (f" and sells once the price is {pct(band)} or more below it." if band > 0
           else " and sells once the price drops below it."),
    ]
    return {
        "summary": f"A trend strategy on {mk} that is patient near the top and quick to buy back after a deep fall.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with corrections (the slow average keeps it in) and V-shaped recoveries after "
                      "deep bear markets (the fast average buys back early).",
        "whenItLoses": "Crashes that start right at the top (it sells late) and long, choppy bottoms where the "
                       "fast average flips in and out.",
    }
