"""mtf_trend v1 (agent-08): multi-timeframe. A slow trend filter on daily or weekly candles (built inside the family
from the fast candles: only *completed* slow candles count) gates fast entries on the spec interval (1h/4h...).

Slow regime is on while the last completed slow close is above the SMA of the last ``slowSma`` completed slow closes.
Fast entry modes:
- ``pullback``: buy when the fast RSI(rsiPeriod) drops under ``buyBelow`` while the regime is on; sell when the RSI
  rises over ``sellAbove``.
- ``ema``: hold while EMA(fastEma) > EMA(slowEma) on the fast candles and the regime is on.
``exitOnRegime``: sell as soon as the slow regime turns off (otherwise the regime only gates new entries).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ..data import DAY, INTERVAL_MS, WEEK, WEEK_ORIGIN_MS
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "mtf_trend"
VERSION = 1
TITLE = "Multi-timeframe trend filter"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"slowTf": "1d", "slowSma": 50, "entry": "pullback", "rsiPeriod": 14, "buyBelow": 35, "sellAbove": 70,
            "fastEma": 12, "slowEma": 48, "exitOnRegime": True}


def param_space() -> dict:
    return {
        "slowTf": {"type": "choice", "values": ["1d", "1W"], "description": "time frame of the slow trend filter"},
        "slowSma": {"type": "int", "min": 3, "max": 200, "log": True,
                    "description": "SMA length of the trend filter, in slow (daily/weekly) candles"},
        "entry": {"type": "choice", "values": ["pullback", "ema"],
                  "description": "fast entry: RSI pullback or EMA trend on the trading interval"},
        "rsiPeriod": {"type": "int", "min": 2, "max": 30, "description": "fast RSI length (pullback entry)"},
        "buyBelow": {"type": "float", "min": 10, "max": 50, "description": "buy when the fast RSI drops under this"},
        "sellAbove": {"type": "float", "min": 50, "max": 95, "description": "sell when the fast RSI rises over this"},
        "fastEma": {"type": "int", "min": 2, "max": 100, "log": True, "description": "fast EMA length (ema entry)"},
        "slowEma": {"type": "int", "min": 5, "max": 400, "log": True, "description": "slow EMA length (ema entry)"},
        "exitOnRegime": {"type": "bool", "description": "sell at once when the slow trend filter turns off"},
    }


def valid_params(p: dict) -> str | None:
    if p["buyBelow"] >= p["sellAbove"]:
        return "buyBelow must be below sellAbove"
    if p["fastEma"] >= p["slowEma"]:
        return "fastEma must be below slowEma"
    return None


def warmup(p: dict) -> int:
    return int(p["rsiPeriod"]) if p["entry"] == "pullback" else int(p["slowEma"]) - 1


def _bucket(ts: np.ndarray, slow_tf: str) -> np.ndarray:
    if slow_tf == "1W":
        return (ts - WEEK_ORIGIN_MS) // WEEK
    return ts // DAY


def slow_regime(ts: np.ndarray, close: np.ndarray, step_ms: int, slow_tf: str, n: int) -> np.ndarray:
    """Per fast bar: True when the last *completed* slow candle closed above the SMA(n) of completed slow closes.
    A slow candle is complete at fast bar i when bar i's close time reaches the next slow bucket."""
    b = _bucket(ts, slow_tf)
    # last fast bar of every bucket -> that bucket's close
    last = np.flatnonzero(np.r_[b[1:] != b[:-1], True])
    ub, sc = b[last], close[last]
    above = sc > ind.sma(sc, n)  # NaN compares False
    cur = _bucket(ts + step_ms, slow_tf)  # bucket current at bar i's close
    j = np.searchsorted(ub, cur, side="left") - 1  # newest bucket strictly before it (all its bars are <= i)
    out = np.zeros(len(ts), dtype=bool)
    ok = j >= 0
    out[ok] = above[j[ok]]
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    step = INTERVAL_MS.get(spec.get("interval") or "4h", 4 * 3600_000)
    reg = slow_regime(ts, c, step, p["slowTf"], int(p["slowSma"]))
    w = np.full(n, np.nan)
    first = warmup(p)
    mw = max_weight(spec)
    exit_reg = bool(p["exitOnRegime"])
    if first >= n:
        return frame(ts, {m: w})
    rg = reg.tolist()
    out = [0.0] * (n - first)
    if p["entry"] == "pullback":
        r = ind.rsi(c, int(p["rsiPeriod"])).tolist()
        bb, sa = float(p["buyBelow"]), float(p["sellAbove"])
        inside = False
        for k, i in enumerate(range(first, n)):
            if not inside:
                if rg[i] and r[i] < bb:
                    inside = True
            elif r[i] > sa or (exit_reg and not rg[i]):
                inside = False
            out[k] = mw if inside else 0.0
    else:
        up = (ind.ema(c, int(p["fastEma"])) > ind.ema(c, int(p["slowEma"]))).tolist()
        inside = False
        for k, i in enumerate(range(first, n)):
            if not inside:
                # enter on a fresh condition: fast trend up and regime on
                if rg[i] and up[i]:
                    inside = True
            elif not up[i] or (exit_reg and not rg[i]):
                inside = False
            out[k] = mw if inside else 0.0
    w[first:] = out
    return frame(ts, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    slow_word = "daily" if p["slowTf"] == "1d" else "weekly"
    steps = [
        f"Big picture first: it builds {slow_word} candles and only trades {mk} while the last finished {slow_word} "
        f"close is above its {p['slowSma']}-{'day' if p['slowTf'] == '1d' else 'week'} average (an uptrend).",
    ]
    if p["entry"] == "pullback":
        steps += [
            f"Inside that uptrend it waits for a short dip on the {iv} candles: an RSI over "
            f"{bars_text(p['rsiPeriod'], iv)} under {p['buyBelow']:g}, then buys.",
            f"It sells when that RSI climbs over {p['sellAbove']:g} (the bounce is done).",
        ]
    else:
        steps += [
            f"Inside that uptrend it holds while the {bars_text(p['fastEma'], iv)} average is above the "
            f"{bars_text(p['slowEma'], iv)} average, and sells when it crosses back under.",
        ]
    if p["exitOnRegime"]:
        steps.append(f"If the {slow_word} trend filter turns off, it sells straight away.")
    else:
        steps.append(f"If the {slow_word} trend filter turns off it stops buying, but lets an open trade finish.")
    return {
        "summary": f"Trades {mk} on {iv} candles only while the {slow_word} trend is up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bull markets with regular pullbacks; it sits out bear markets.",
        "whenItLoses": "Choppy markets around the long average (the filter flips on and off) and sharp V-shaped "
                       "recoveries that it misses until the slow trend turns.",
    }
