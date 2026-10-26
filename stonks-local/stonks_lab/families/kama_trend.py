"""kama_trend v1 (agent-08, invent lane): Kaufman adaptive moving average trend follower.

Plain EMA/SMA trend followers lose on 1h-4h to whipsaw in sideways chop (findings #26, #30, #51). Kaufman's
adaptive moving average (KAMA) moves fast when the price trends cleanly and almost stops in noise: its smoothing
constant comes from the efficiency ratio ER = |net move over erLen candles| / sum of absolute candle moves.

Rules (decided at a bar's close, using closes up to and including that bar only):
- enter (weight = maxWeight) when close > KAMA * (1 + band), KAMA is higher than ``slopeBars`` candles ago (if set)
  and ER >= erMin (if set);
- exit (weight 0) when close < KAMA * (1 - band).
The band is hysteresis so it does not flip on every touch of the line.
"""
from __future__ import annotations

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "kama_trend"
VERSION = 1
TITLE = "Adaptive moving average trend"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"erLen": 20, "fastLen": 2, "slowLen": 60, "band": 0.0, "erMin": 0.0, "slopeBars": 0}


def param_space() -> dict:
    return {
        "erLen": {"type": "int", "min": 3, "max": 300, "log": True,
                  "description": "candles in the efficiency ratio (how cleanly the price is trending)"},
        "fastLen": {"type": "int", "min": 2, "max": 30, "log": True,
                    "description": "EMA length the average behaves like in a clean trend"},
        "slowLen": {"type": "int", "min": 10, "max": 500, "log": True,
                    "description": "EMA length the average behaves like in pure noise"},
        "band": {"type": "float", "min": 0.002, "max": 0.15, "log": True, "zero": True,
                 "description": "buy only this fraction above the average, sell only this fraction below (0 = off)"},
        "erMin": {"type": "float", "min": 0.05, "max": 0.7, "zero": True,
                  "description": "only buy while the efficiency ratio is at least this (0 = off)"},
        "slopeBars": {"type": "int", "min": 1, "max": 100, "zero": True, "log": True,
                      "description": "only buy while the average is higher than this many candles ago (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if p["slowLen"] <= p["fastLen"] * 2:
        return "slowLen must be more than twice fastLen"
    return None


def warmup(p: dict) -> int:
    # KAMA is seeded with the close at bar erLen; give it time to settle before the first decision.
    return int(p["erLen"]) + int(p.get("slopeBars") or 0) + min(int(p["slowLen"]), 200)


def kama(c: np.ndarray, er_len: int, fast_len: int, slow_len: int) -> tuple[np.ndarray, np.ndarray]:
    n = len(c)
    k = np.full(n, np.nan)
    er = np.full(n, np.nan)
    if n <= er_len:
        return k, er
    d = np.abs(np.diff(c, prepend=c[0]))
    d[0] = 0.0
    cs = np.cumsum(d)
    noise = cs[er_len:] - cs[:-er_len]
    net = np.abs(c[er_len:] - c[:-er_len])
    er[er_len:] = np.where(noise > 0, net / np.where(noise > 0, noise, 1.0), 0.0)
    fsc, ssc = 2.0 / (fast_len + 1), 2.0 / (slow_len + 1)
    sc = (er * (fsc - ssc) + ssc) ** 2
    k[er_len] = c[er_len]
    prev = c[er_len]
    for t in range(er_len + 1, n):
        prev = prev + sc[t] * (c[t] - prev)
        k[t] = prev
    return k, er


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    k, er = kama(c, int(p["erLen"]), int(p["fastLen"]), int(p["slowLen"]))
    band = float(p.get("band") or 0.0)
    er_min = float(p.get("erMin") or 0.0)
    sb = int(p.get("slopeBars") or 0)
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    start = min(warmup(p), n)
    state = 0.0
    for t in range(start, n):
        kt = k[t]
        if state == 0.0:
            ok = c[t] > kt * (1 + band)
            if ok and er_min > 0:
                ok = er[t] >= er_min
            if ok and sb > 0:
                ok = kt > k[t - sb]
            if ok:
                state = mw
        elif c[t] < kt * (1 - band):
            state = 0.0
        w[t] = state
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"It keeps an adaptive average of {mk}'s price: when the last {bars_text(p['erLen'], iv)} moved cleanly in "
        f"one direction the average follows the price quickly (like a {p['fastLen']}-candle average); when the price "
        f"just zig-zags it barely moves (like a {p['slowLen']}-candle average).",
    ]
    band = float(p.get("band") or 0.0)
    if band:
        steps.append(f"It buys when the close is more than {pct(band)} above that average and sells when it is more "
                     f"than {pct(band)} below it.")
    else:
        steps.append("It buys when the close is above that average and sells when it closes below it.")
    if p.get("erMin"):
        steps.append(f"It only buys while the price is trending cleanly (efficiency ratio at least {p['erMin']}).")
    if p.get("slopeBars"):
        steps.append(f"It only buys while the average is higher than {bars_text(p['slopeBars'], iv)} ago.")
    return {
        "summary": f"A trend follower on {mk} whose moving average speeds up in clean trends and stands still in "
                   "choppy markets, to avoid paying fees on every wiggle.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long, clean rallies and declines: it rides the rally and is in euros for most of the fall.",
        "whenItLoses": "Sharp reversals right after a buy, and bull markets with deep pullbacks that dip under the "
                       "average and then recover.",
    }
