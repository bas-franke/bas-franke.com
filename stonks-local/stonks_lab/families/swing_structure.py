"""swing_structure: Dow-theory market structure as a trend core (agent-06).

Every SMA/EMA/MACD/Supertrend core on BTC/ETH reacts to an average that lags. This family uses price structure
instead: swing highs and swing lows (pivots).

- A swing high at bar j is a high that is the highest of the k bars on each side (k = pivot strength). It is only
  *known* k bars later (bar j + k), so a decision at bar t sees only pivots with j + k <= t. Swing lows likewise.
- Buy when the close breaks above the most recent known swing high of strength ``kEntry`` (a "break of structure"
  up), optionally only while the close is above SMA(trendSma).
- Sell when the close breaks ``exitBand`` below the most recent known swing low of strength ``kExit``. A larger
  ``kExit`` uses bigger, older lows, so ordinary pullbacks don't shake it out; a smaller one exits on the first
  lower low.
- ``useWicks`` picks highs/lows (true) or closes (false) for the pivots.

Every market is decided on its own candles and gets maxWeight / len(markets) while held.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "swing_structure"
VERSION = 1
TITLE = "Swing-high / swing-low market structure"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"kEntry": 5, "kExit": 10, "exitBand": 0.0, "trendSma": 0, "useWicks": False}


def param_space() -> dict:
    return {
        "kEntry": {"type": "int", "min": 2, "max": 40, "log": True,
                   "description": "pivot strength for the swing high that must be broken to buy (bars each side)"},
        "kExit": {"type": "int", "min": 2, "max": 60, "log": True,
                  "description": "pivot strength for the swing low that must be broken to sell (bars each side)"},
        "exitBand": {"type": "float", "min": 0.01, "max": 0.2, "log": True, "zero": True,
                     "description": "how far under the swing low the close must be to sell (0 = just under)"},
        "trendSma": {"type": "int", "min": 20, "max": 400, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
        "useWicks": {"type": "bool", "description": "pivots from candle highs/lows (true) or closes (false)"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return max(4 * int(p["kEntry"]), 4 * int(p["kExit"]), int(p.get("trendSma") or 0))


def _last_pivot(x: np.ndarray, k: int, high: bool) -> np.ndarray:
    """Level of the most recent pivot of strength k that is known at each bar (pivot j becomes known at j + k)."""
    s = pd.Series(x)
    win = s.rolling(2 * k + 1, center=True, min_periods=2 * k + 1)
    ext = win.max() if high else win.min()
    is_piv = (s >= ext) if high else (s <= ext)
    piv = np.where(is_piv.to_numpy() & np.isfinite(ext.to_numpy()), x, np.nan)
    known = np.full(len(x), np.nan)
    if len(x) > k:
        known[k:] = piv[: len(x) - k]          # pivot at j is revealed at bar j + k
    return pd.Series(known).ffill().to_numpy(np.float64)


def _held(df: pd.DataFrame, p: dict) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    hi = df["high"].to_numpy(np.float64) if p.get("useWicks") else c
    lo = df["low"].to_numpy(np.float64) if p.get("useWicks") else c
    ph = _last_pivot(hi, int(p["kEntry"]), True)
    pl = _last_pivot(lo, int(p["kExit"]), False)
    ts = int(p.get("trendSma") or 0)
    sma = ind.sma(c, ts) if ts > 0 else np.zeros(len(c))
    band = float(p.get("exitBand") or 0.0)
    out = np.full(len(c), np.nan)
    inside = False
    for i in range(len(c)):
        x, h, l, m = c[i], ph[i], pl[i], sma[i]
        if not (np.isfinite(x) and np.isfinite(h) and np.isfinite(l) and np.isfinite(m)):
            continue
        broken = x < l * (1.0 - band)
        if inside:
            if broken:
                inside = False
        elif x > h and not broken and (ts == 0 or x > m):
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
    band = float(p.get("exitBand") or 0)
    src = "candle highs and lows" if p.get("useWicks") else "closing prices"
    ts = int(p.get("trendSma") or 0)
    steps = [
        f"It marks swing highs and swing lows in the {src}: a swing high is a peak higher than the "
        f"{bars_text(p['kEntry'], iv)} on either side of it, so it only counts once that much time has passed.",
        f"Buy: it buys {mk} when the price closes above the latest swing high (a new higher high)"
        + (f", but only while the price is above its average of the last {bars_text(ts, iv)}" if ts else "")
        + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        f"Sell: it sells when the price closes "
        + (f"{pct(band)} or more below" if band > 0 else "below")
        + f" the latest swing low, where a swing low is the lowest point of {bars_text(p['kExit'], iv)} on either side.",
        "Otherwise it keeps what it has.",
    ]
    return {
        "summary": f"Holds {mk} while prices make higher highs and sells when they make a lower low.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends with orderly pullbacks, and long bear markets (it is out after the first lower low).",
        "whenItLoses": "Sideways markets that break the latest high and then the latest low again and again.",
    }
