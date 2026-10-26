"""donchian_vol v1 (agent-04): a Donchian breakout with a volatility-sized position and a chandelier exit.

- Entry: the close beats the highest high of the previous ``entry`` candles (and, if ``trendSma`` > 0, the close is
  above its SMA). The position size is fixed at entry: min(maxWeight, targetVol / realised vol), where realised vol is
  the annualised population stdev of log returns over ``volLookback`` candles, rounded down to steps of 0.05.
- Exit (whichever first): the close falls below the lowest low of the previous ``exit`` candles, or (if ``atrMult``
  > 0) the close falls below the highest close since entry minus ``atrMult`` x ATR(``atrLen``) (a chandelier stop).

Motivation (findings #6/#7): plain donchian_breakout on ETH 1d has positive median excess over buy and hold but
loses the score to drawdown; sizing down in wild markets and a tighter trailing exit attack exactly that.
Everything at bar t uses candles up to and including t.
"""
from __future__ import annotations

import math

import numpy as np

from .. import indicators as ind
from ._base import _INTERVAL_MIN, bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "donchian_vol"
VERSION = 1
TITLE = "Donchian breakout, volatility-sized"
BOT_READY = False
MULTI_MARKET = False

_MIN_PER_YEAR = 365.0 * 24 * 60
_STEP = 0.05


def default_params() -> dict:
    return {"entry": 60, "exit": 20, "atrMult": 3.0, "atrLen": 14, "volLookback": 30, "targetVol": 0.6,
            "trendSma": 0}


def param_space() -> dict:
    return {
        "entry": {"type": "int", "min": 5, "max": 300, "log": True,
                  "description": "buy when the close beats the high of this many previous candles"},
        "exit": {"type": "int", "min": 2, "max": 200, "log": True,
                 "description": "sell when the close falls under the low of this many previous candles"},
        "atrMult": {"type": "float", "min": 1.0, "max": 8.0, "zero": True,
                    "description": "chandelier stop: sell when the close is this many ATRs under the best close "
                                   "since buying (0 = off)"},
        "atrLen": {"type": "int", "min": 5, "max": 100, "log": True, "description": "candles in the ATR"},
        "volLookback": {"type": "int", "min": 10, "max": 200, "log": True,
                        "description": "candles in the volatility estimate used for sizing"},
        "targetVol": {"type": "float", "min": 0.15, "max": 3.0, "log": True,
                      "description": "annualised volatility the position aims for (size = target / measured, "
                                     "capped at maxWeight)"},
        "trendSma": {"type": "int", "min": 20, "max": 400, "zero": True, "log": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["entry"]), int(p["exit"]), int(p["atrLen"]), int(p["volLookback"]) + 1, int(p["trendSma"]))


def _vol(c: np.ndarray, n: int, interval) -> np.ndarray:
    lr = np.full(c.shape, np.nan)
    lr[1:] = np.log(c[1:] / c[:-1])
    per_bar = np.full(c.shape, np.nan)
    if len(c) > n:
        per_bar[n:] = ind.std_pop(lr[1:], n)[n - 1:]
    return per_bar * math.sqrt(_MIN_PER_YEAR / _INTERVAL_MIN.get(interval or "1d", 1440))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    h = df["high"].to_numpy(np.float64)
    l = df["low"].to_numpy(np.float64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    hi = ind.prior_max(h, int(p["entry"]))
    lo = ind.prior_min(l, int(p["exit"]))
    use_atr = float(p["atrMult"]) > 0
    a = ind.atr(h, l, c, int(p["atrLen"])) if use_atr else np.zeros(n)
    vol = _vol(c, int(p["volLookback"]), spec.get("interval"))
    sma = ind.sma(c, int(p["trendSma"])) if p["trendSma"] else None
    mw = max_weight(spec)
    tv, k = float(p["targetVol"]), float(p["atrMult"])
    w = np.full(n, np.nan)
    first = warmup(p)
    if first >= n:
        return frame(df.index, {m: w})
    cl, hl, ll, al, vl = c.tolist(), hi.tolist(), lo.tolist(), a.tolist(), vol.tolist()
    sl = sma.tolist() if sma is not None else None
    size, best = 0.0, 0.0
    for i in range(first, n):
        if size == 0.0:
            ok = cl[i] > hl[i] and (sl is None or cl[i] > sl[i]) and vl[i] > 0 and math.isfinite(vl[i])
            if ok:
                s = math.floor(min(mw, tv / vl[i]) / _STEP + 1e-9) * _STEP
                if s > 0:
                    size, best = min(s, mw), cl[i]
        else:
            best = max(best, cl[i])
            if cl[i] < ll[i] or (use_atr and cl[i] < best - k * al[i]):
                size = 0.0
        w[i] = size
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"After every {iv} candle it looks at the highest price of the previous {bars_text(p['entry'], iv)}; a close "
        "above it is a breakout and it buys" + (f", but only while the price is above its average of the last "
                                               f"{bars_text(p['trendSma'], iv)}." if p["trendSma"] else "."),
        f"How much it buys depends on how wild {mk} has been over the last {bars_text(p['volLookback'], iv)}: "
        f"it aims for {pct(p['targetVol'])} yearly volatility, so in a market swinging twice as hard it buys half as "
        "much. The rest stays in euros, and the size is not changed until it sells.",
        f"It sells everything when a candle closes below the lowest price of the previous {bars_text(p['exit'], iv)}",
    ]
    if p["atrMult"]:
        steps[-1] += (f", or when the price closes {p['atrMult']:g} typical candle ranges (ATR over "
                      f"{bars_text(p['atrLen'], iv)}) below the best close since it bought.")
    else:
        steps[-1] += "."
    return {
        "summary": f"A breakout strategy on {mk} that buys new highs with a position sized to the market's "
                   "volatility and follows the price up with a trailing exit.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Calm, steady breakouts that keep running: it is fully in and lets the trend run.",
        "whenItLoses": "Choppy ranges with false breakouts, and violent rallies where it was sized small; it usually "
                       "trails buy and hold in strong bull markets.",
    }
