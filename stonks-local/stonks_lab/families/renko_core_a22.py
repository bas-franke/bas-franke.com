"""renko_core_a22: Renko brick trend core (agent-22).

SMA/EMA/MACD/Kalman cores all run on a *time* clock: every bar moves the average whether price moved or not, so a
sideways market keeps crossing the line. A Renko chart runs on a *price* clock: a new brick is drawn only when the
close has moved a full brick size beyond the last brick, and the trend only flips after the price has moved
``reversal`` bricks against it. Sideways noise smaller than a brick draws nothing.

- Bricks live in log price, so a brick is a fixed percentage move: ``brickPct`` (mode "pct"), or ``brickAtr`` x
  ATR(atrLen) / close at the bar the brick is tested (mode "atr", volatility-scaled bricks).
- Up trend: a close >= top + 1 brick adds up bricks. The trend flips down when the close is ``reversal`` bricks
  under the top of the last up brick (reversal 2 = the classic Renko two-brick reversal). Mirror image in a down trend.
- Hold while the Renko trend is up (optionally only buy while the close is above SMA(trendSma)); otherwise hold
  ``offWeight`` (0 = cash).

Close-only, causal: the decision at bar t uses closes up to t. Every market is decided on its own candles and gets
maxWeight / len(markets) while held.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "renko_core_a22"
VERSION = 1
TITLE = "Renko brick trend (price clock)"
BOT_READY = False
MULTI_MARKET = True
ANCHORED = False


def default_params() -> dict:
    return {"mode": "pct", "brickPct": 0.08, "brickAtr": 2.0, "atrLen": 14, "reversal": 2, "trendSma": 0,
            "offWeight": 0.0}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["pct", "atr"],
                 "description": "brick size: fixed percentage (pct) or a multiple of the ATR (atr)"},
        "brickPct": {"type": "float", "min": 0.01, "max": 0.35, "log": True,
                     "description": "brick size as a fraction of price (mode pct)"},
        "brickAtr": {"type": "float", "min": 0.5, "max": 8.0, "log": True,
                     "description": "brick size in ATRs (mode atr)"},
        "atrLen": {"type": "int", "min": 5, "max": 90, "log": True, "description": "ATR length in bars (mode atr)"},
        "reversal": {"type": "int", "min": 1, "max": 5,
                     "description": "bricks against the trend (from the last brick's far end) needed to flip it"},
        "trendSma": {"type": "int", "min": 20, "max": 400, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
        "offWeight": {"type": "float", "min": 0.05, "max": 0.6, "zero": True,
                      "description": "share kept while the Renko trend is down (0 = all cash)"},
    }


def valid_params(p: dict) -> str | None:
    if p.get("mode") not in ("pct", "atr"):
        return "mode must be pct or atr"
    return None


def warmup(p: dict) -> int:
    return max(2 * int(p.get("atrLen") or 14) if p.get("mode") == "atr" else 2, int(p.get("trendSma") or 0))


def renko_state(close: np.ndarray, brick: np.ndarray, reversal: int) -> np.ndarray:
    """+1 / -1 Renko trend per bar (0 before the first brick, NaN where the brick size is unknown)."""
    lc = np.log(np.asarray(close, dtype=np.float64))
    n = len(lc)
    out = np.full(n, np.nan)
    top = bot = np.nan
    d = 0
    rev = max(1, int(reversal))
    for i in range(n):
        b, x = brick[i], lc[i]
        if not (np.isfinite(b) and b > 0 and np.isfinite(x)):
            continue
        if not np.isfinite(top):
            top = bot = x
        if d >= 0 and x >= top + b:                      # up continuation (or first brick up)
            top += np.floor((x - top) / b) * b
            bot = top - b
            d = 1
        elif d <= 0 and x <= bot - b:                    # down continuation (or first brick down)
            bot -= np.floor((bot - x) / b) * b
            top = bot + b
            d = -1
        elif d == 1 and x <= top - rev * b:              # reversal down
            bot = top - np.floor((top - x) / b) * b
            top = bot + b
            d = -1
        elif d == -1 and x >= bot + rev * b:             # reversal up
            top = bot + np.floor((x - bot) / b) * b
            bot = top - b
            d = 1
        out[i] = float(d)
    return out


def _held(df, p: dict) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    if p.get("mode") == "atr":
        a = ind.atr(df["high"].to_numpy(np.float64), df["low"].to_numpy(np.float64), c, int(p["atrLen"]))
        brick = float(p["brickAtr"]) * a / c
    else:
        brick = np.full(len(c), np.log1p(float(p["brickPct"])))
    st = renko_state(c, brick, int(p["reversal"]))
    ts = int(p.get("trendSma") or 0)
    sma = ind.sma(c, ts) if ts > 0 else np.zeros(len(c))
    off = float(p.get("offWeight") or 0.0)
    out = np.full(len(c), np.nan)
    inside = False
    for i in range(len(c)):
        if not (np.isfinite(st[i]) and np.isfinite(sma[i])):
            continue
        if inside:
            if st[i] < 1:
                inside = False
        elif st[i] == 1 and (ts == 0 or c[i] > sma[i]):
            inside = True
        out[i] = 1.0 if inside else off
    return out


def _asof(df, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
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
    size = (f"{pct(float(p['brickPct']))} of the price" if p.get("mode") != "atr"
            else f"{float(p['brickAtr']):g} times the average daily range of the last {bars_text(p['atrLen'], iv)}")
    ts = int(p.get("trendSma") or 0)
    off = float(p.get("offWeight") or 0)
    steps = [
        f"It draws a Renko chart: a new brick only when the closing price has moved a full brick ({size}) beyond "
        "the last brick. Small sideways moves draw nothing.",
        f"The trend turns down only after the price falls {int(p['reversal'])} brick(s) below the top of the last "
        "rising brick, and turns up after it rises that far above the bottom of the last falling brick.",
        f"Buy: it buys {mk} when the bricks turn up"
        + (f", but only while the price is above its average of the last {bars_text(ts, iv)}" if ts else "")
        + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        "Sell: it sells when the bricks turn down"
        + (f", keeping {pct(off)} of the position." if off > 0 else "."),
    ]
    return {
        "summary": f"Holds {mk} while its Renko bricks (fixed-size price moves) point up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends with pullbacks smaller than the reversal distance; quiet sideways markets "
                      "(no bricks, no trades).",
        "whenItLoses": "Choppy markets that swing just over the reversal distance, and V-shaped rebounds "
                       "(it re-buys only after a full reversal above the low).",
    }
