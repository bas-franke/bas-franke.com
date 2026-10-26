"""vr_switch v1 (agent-05): variance-ratio regime switch between trend following and mean reversion.

Idea: crypto alternates between trending stretches (returns keep their sign over several candles) and choppy
stretches (moves get reversed). The variance ratio measures which one the recent past was:

    VR = Var(sum of q consecutive log returns) / (q * Var(single log return)),  both over the last vrWin candles

VR > 1 means multi-candle moves are bigger than independent noise would give (trending); VR < 1 means they partly
cancel (mean reverting). The family follows a trend rule while VR >= vrThr and switches to a reversion rule below it:

- trend regime:     hold while close > SMA(trendLen)
- reverting regime (revMode):
    "dip"  - buy when the close's z-score vs SMA(revLen) / std(revLen) is below -entryZ, sell once it is back above 0
             (an open dip trade is also kept if the regime flips back to trend while the trend rule says hold)
    "hold" - always hold (chop is not worth whipsawing the trend core out of)
    "cash" - stay in euros
    "keep" - keep whatever the last decision was (ignore trend signals while it's choppy)

Everything at bar t uses candles up to and including t. Each market gets maxWeight/len(markets) while held.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "vr_switch"
VERSION = 1
TITLE = "Variance-ratio switch: trend or mean reversion"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"trendLen": 100, "vrWin": 120, "vrQ": 5, "vrThr": 1.0, "revMode": "dip", "revLen": 20, "entryZ": 1.5}


def param_space() -> dict:
    return {
        "trendLen": {"type": "int", "min": 10, "max": 400, "log": True,
                     "description": "trend regime: hold while the close is above this SMA"},
        "vrWin": {"type": "int", "min": 30, "max": 500, "log": True,
                  "description": "candles over which the variance ratio is measured"},
        "vrQ": {"type": "int", "min": 2, "max": 20, "log": True,
                "description": "candles summed in the multi-candle return of the variance ratio"},
        "vrThr": {"type": "float", "min": 0.6, "max": 1.4,
                  "description": "variance ratio at or above this = trending, below = mean reverting"},
        "revMode": {"type": "choice", "values": ["dip", "hold", "cash", "keep"],
                    "description": "what to do while mean reverting: buy z-score dips, hold, cash, or keep the last state"},
        "revLen": {"type": "int", "min": 5, "max": 100, "log": True,
                   "description": "dip mode: SMA/std length of the z-score"},
        "entryZ": {"type": "float", "min": 0.5, "max": 3.0,
                   "description": "dip mode: buy when the z-score is below minus this"},
    }


def warmup(p: dict) -> int:
    return max(int(p["trendLen"]), int(p["vrWin"]) + int(p["vrQ"]), int(p["revLen"]))


def variance_ratio(close: np.ndarray, win: int, q: int) -> np.ndarray:
    """VR at each bar from the last ``win`` 1-bar and q-bar (overlapping) log returns; NaN until defined."""
    r = pd.Series(np.diff(np.log(close), prepend=np.nan))
    rq = r.rolling(q, min_periods=q).sum()
    v1 = r.rolling(win, min_periods=win).var(ddof=0)
    vq = rq.rolling(win, min_periods=win).var(ddof=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        vr = np.array((vq / (q * v1)).to_numpy(np.float64), dtype=np.float64)
    vr[~np.isfinite(vr)] = np.nan
    return vr


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _weights(c: np.ndarray, p: dict) -> np.ndarray:
    n = len(c)
    s = ind.sma(c, int(p["trendLen"]))
    trend = np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan)
    vr = variance_ratio(c, int(p["vrWin"]), int(p["vrQ"]))
    rl = int(p["revLen"])
    mid, sd = ind.sma(c, rl), ind.std_pop(c, rl)
    with np.errstate(divide="ignore", invalid="ignore"):
        z = np.where(sd > 0, (c - mid) / sd, 0.0)
    z[~np.isfinite(mid)] = np.nan
    mode, thr, ez = p["revMode"], float(p["vrThr"]), float(p["entryZ"])
    w = np.full(n, np.nan)
    ok = np.isfinite(trend) & np.isfinite(vr) & np.isfinite(z)
    state, dip = 0.0, False
    for i in range(n):
        if not ok[i]:
            continue
        if vr[i] >= thr:
            if dip and z[i] >= 0:
                dip = False
            state = 1.0 if (trend[i] == 1.0 or dip) else 0.0
        elif mode == "hold":
            dip, state = False, 1.0
        elif mode == "cash":
            dip, state = False, 0.0
        elif mode == "keep":
            dip = False
        else:  # dip
            if dip:
                if z[i] >= 0:
                    dip = False
            elif z[i] < -ez:
                dip = True
            state = 1.0 if dip else 0.0
        w[i] = state
    return w


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = []
    for m in markets:
        df = candles[m]
        cols.append(_asof(df, _weights(df["close"].to_numpy(np.float64), p), idx) * each)
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    mode = p["revMode"]
    rev = {
        "dip": (f"it switches to buying dips: it buys when the price is more than {float(p['entryZ']):g} standard "
                f"deviations below its {bars_text(p['revLen'], iv)} average and sells once it is back at the average."),
        "hold": "it simply keeps holding: in a choppy market a trend signal flipping to 'sell' is usually noise.",
        "cash": "it stays in euros: choppy markets are not worth the trading costs.",
        "keep": "it ignores new trend signals and keeps its last decision until the market trends again.",
    }[mode]
    steps = [
        f"After every {iv} candle it measures over the last {bars_text(p['vrWin'], iv)} whether moves of "
        f"{int(p['vrQ'])} candles in a row tend to continue (trending market) or reverse (choppy market), with the "
        f"variance ratio; {float(p['vrThr']):g} or more counts as trending.",
        f"While the market is trending it holds {mk} whenever the price is above its "
        f"{bars_text(p['trendLen'], iv)} average, and sells when it drops below.",
        f"While the market is choppy {rev}",
    ]
    return {
        "summary": f"Follows the trend in {mk} when moves continue, and changes tactics when moves keep reversing.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Markets that alternate between clean trends and sideways chop, where a plain trend filter "
                      "would be whipsawed in and out.",
        "whenItLoses": "When the regime measure lags: a new trend that starts out of chop, or a crash inside a "
                       "'choppy' stretch.",
    }
