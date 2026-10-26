"""vp_core: volume-profile trend core (agent-06).

SMA/EMA cores use the *average* price of the last N bars as their line. A volume profile asks instead where most
money changed hands: each bar's EUR turnover (volume x typical price) is put in a log-price bin of width
``binPct``, over the last ``lookback`` bars (up to and including bar t). The line is either

- ``poc``: the point of control, the bin with the most turnover (traders' "fair value"; acts as support/resistance),
- ``quantile``: the price below which a share ``q`` of the turnover traded (q 0.15 ~ the value-area low).

Buy when the close is ``entryBand`` above the line, sell when it is ``exitBand`` below it, otherwise keep what it
has. Every market is decided on its own candles and gets maxWeight / len(markets) while held.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "vp_core"
VERSION = 1
TITLE = "Volume-profile trend core"
BOT_READY = False
MULTI_MARKET = True

LEVELS = ["poc", "quantile"]


def default_params() -> dict:
    return {"lookback": 120, "binPct": 0.03, "level": "poc", "q": 0.15, "entryBand": 0.0, "exitBand": 0.0}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 20, "max": 500, "log": True,
                     "description": "candles in the volume profile"},
        "binPct": {"type": "float", "min": 0.005, "max": 0.1, "log": True,
                   "description": "width of a price bin (log scale), e.g. 0.03 = 3 %"},
        "level": {"type": "choice", "values": LEVELS,
                  "description": "poc = price bin with the most turnover; quantile = turnover-weighted price quantile q"},
        "q": {"type": "float", "min": 0.05, "max": 0.6,
              "description": "turnover share below the line in quantile mode"},
        "entryBand": {"type": "float", "min": 0.005, "max": 0.2, "log": True, "zero": True,
                      "description": "buy when the close is this far above the line (0 = just above)"},
        "exitBand": {"type": "float", "min": 0.005, "max": 0.2, "log": True, "zero": True,
                     "description": "sell when the close is this far below the line (0 = just below)"},
    }


def valid_params(p: dict) -> str | None:
    if p.get("level") not in LEVELS:
        return f"level must be one of {LEVELS}"
    return None


def warmup(p: dict) -> int:
    return int(p["lookback"]) - 1


def profile_line(df: pd.DataFrame, p: dict) -> np.ndarray:
    """Profile line at each bar from the last ``lookback`` bars (inclusive); NaN until the window is full."""
    h = df["high"].to_numpy(np.float64)
    l = df["low"].to_numpy(np.float64)
    c = df["close"].to_numpy(np.float64)
    v = df["volume"].to_numpy(np.float64)
    tp = (h + l + c) / 3.0
    eur = np.where(np.isfinite(v) & np.isfinite(tp), v * tp, 0.0)
    lp = np.log(np.where(tp > 0, tp, np.nan))
    n = int(p["lookback"])
    w = np.log1p(float(p["binPct"]))
    out = np.full(len(c), np.nan)
    poc = p.get("level", "poc") == "poc"
    q = float(p.get("q", 0.15))
    for i in range(n - 1, len(c)):
        x = lp[i - n + 1: i + 1]
        e = eur[i - n + 1: i + 1]
        ok = np.isfinite(x)
        if ok.sum() < n // 2 or e[ok].sum() <= 0:
            continue
        x, e = x[ok], e[ok]
        if poc:
            b = np.floor(x / w).astype(np.int64)
            b0 = b.min()
            tot = np.bincount(b - b0, weights=e)
            k = int(np.argmax(tot))
            out[i] = float(np.exp((b0 + k + 0.5) * w))
        else:
            o = np.argsort(x)
            cum = np.cumsum(e[o])
            j = int(np.searchsorted(cum, q * cum[-1], side="left"))
            out[i] = float(np.exp(x[o][min(j, len(o) - 1)]))
    return out


def _held(df: pd.DataFrame, p: dict) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    line = profile_line(df, p)
    up = 1.0 + float(p.get("entryBand") or 0.0)
    dn = 1.0 - float(p.get("exitBand") or 0.0)
    out = np.full(len(c), np.nan)
    inside = False
    for i in range(len(c)):
        x, m = c[i], line[i]
        if not (np.isfinite(x) and np.isfinite(m)):
            continue
        if inside:
            if x < m * dn:
                inside = False
        elif x > m * up:
            inside = True
        out[i] = 1.0 if inside else 0.0
    return out


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = [_asof(candles[m], _held(candles[m], p), idx) * each for m in markets]
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
    look = bars_text(p["lookback"], iv)
    if p.get("level", "poc") == "poc":
        line = (f"the price level where the most money changed hands over the last {look} "
                f"(prices grouped in {pct(float(p['binPct']))} steps)")
    else:
        line = (f"the price below which {float(p['q']) * 100:.0f} % of the last {look}'s trading volume "
                f"(in euros) took place")
    eb, xb = float(p.get("entryBand") or 0), float(p.get("exitBand") or 0)
    steps = [
        f"Its line is {line}.",
        f"Buy: it buys {mk} when the price closes " + (f"{pct(eb)} or more above" if eb else "above")
        + " that line" + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        "Sell: it sells when the price closes " + (f"{pct(xb)} or more below" if xb else "below") + " the line.",
        "Otherwise it keeps what it has.",
    ]
    return {
        "summary": f"Holds {mk} while the price stays above the level where most of the recent trading took place.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Trends that leave a heavily traded price zone behind and long bear markets.",
        "whenItLoses": "Sideways markets that keep crossing the busiest price level.",
    }
