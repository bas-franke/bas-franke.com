"""vwap_reversion v1: buy when the close is far below its rolling volume-weighted average price, sell when it is back.

dev_t = ln(close_t / VWAP_t), VWAP over ``period`` candles from the typical price (high+low+close)/3 weighted by
volume (plain SMA of the close where the window had no volume). z_t = dev_t / population std of dev over the last
``period`` candles. Buy when z < -entryZ (and, with trendSma > 0, the close is above its SMA); sell when z > exitZ
or, with maxHold > 0, after maxHold candles in the trade. After a time exit it waits until z >= -entryZ before it
may buy again (no instant re-entry into the same dip)."""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "vwap_reversion"
VERSION = 1
TITLE = "VWAP reversion"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"period": 48, "entryZ": 2.0, "exitZ": 0.0, "trendSma": 0, "maxHold": 0}


def param_space() -> dict:
    return {
        "period": {"type": "int", "min": 5, "max": 500, "log": True,
                   "description": "candles in the rolling VWAP and in the deviation's spread"},
        "entryZ": {"type": "float", "min": 0.5, "max": 4.0,
                   "description": "buy when the close is this many spreads below the VWAP"},
        "exitZ": {"type": "float", "min": -1.0, "max": 2.0,
                  "description": "sell when the close is back to this many spreads around the VWAP"},
        "trendSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                     "description": "only buy while the close is above this SMA (0 = no filter)"},
        "maxHold": {"type": "int", "min": 2, "max": 500, "zero": True, "log": True,
                    "description": "sell after this many candles in a trade (0 = no time limit)"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["exitZ"] > -p["entryZ"] else "exitZ must be above -entryZ"


def warmup(p: dict) -> int:
    t = int(p.get("trendSma") or 0)
    return max(2 * int(p["period"]) - 2, t - 1 if t > 0 else 0)


def vwap(high, low, close, volume, n: int) -> np.ndarray:
    tp = (np.asarray(high, float) + np.asarray(low, float) + np.asarray(close, float)) / 3.0
    v = np.nan_to_num(np.asarray(volume, float), nan=0.0)
    num, den = ind.sma(tp * v, n), ind.sma(v, n)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    fallback = ind.sma(close, n)
    return np.where(den > 0, out, fallback)


def zdev(df, n: int) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    vw = vwap(df["high"].to_numpy(), df["low"].to_numpy(), c, df["volume"].to_numpy(), n)
    with np.errstate(invalid="ignore", divide="ignore"):
        dev = np.log(c / vw)
    sd = np.full(len(c), np.nan)
    if len(c) >= n:
        tail = dev[n - 1:]
        sd[n - 1:] = ind.std_pop(tail, n)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = dev / sd
    z[(sd == 0)] = 0.0
    return z


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    z = zdev(df, int(p["period"]))
    t = int(p.get("trendSma") or 0)
    trend_ok = (c > np.nan_to_num(ind.sma(c, t), nan=np.inf)) if t > 0 else np.ones(n, dtype=bool)
    w = np.full(n, np.nan)
    first = warmup(p)
    mw = max_weight(spec)
    ent, ex, mh = float(p["entryZ"]), float(p["exitZ"]), int(p.get("maxHold") or 0)
    if first < n:
        zl, tl = z.tolist(), trend_ok.tolist()
        out = [0.0] * (n - first)
        inside, held, armed = False, 0, True
        for k, i in enumerate(range(first, n)):
            zi = zl[i]
            if inside:
                held += 1
                if zi > ex:
                    inside = False
                elif mh > 0 and held >= mh:
                    inside, armed = False, False
            else:
                if not armed and zi >= -ent:
                    armed = True
                if armed and zi < -ent and tl[i]:
                    inside, held = True, 0
            out[k] = mw if inside else 0.0
        w[first:] = out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"After every {iv} candle it computes the volume-weighted average price (VWAP) of {mk} over the last "
        f"{bars_text(p['period'], iv)}: the average price people actually traded at.",
        f"When the price falls more than {p['entryZ']:g} times its usual distance below that VWAP, it buys: the "
        "price is cheap compared to where the volume traded.",
        f"It sells when the price is back to {p['exitZ']:g} times the usual distance from the VWAP"
        + (f", or after {bars_text(p['maxHold'], iv)} at the latest." if int(p.get("maxHold") or 0) > 0 else "."),
    ]
    if int(p.get("trendSma") or 0) > 0:
        steps.insert(2, f"It only buys while the price is above its {bars_text(p['trendSma'], iv)} average, so it "
                        "buys pullbacks in an uptrend rather than falling knives.")
    return {
        "summary": f"Buys {mk} when it trades well below its volume-weighted average price and sells on the snap back.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Choppy or gently rising markets where sell-offs below the VWAP get bought back quickly.",
        "whenItLoses": "Crashes and long downtrends: the price keeps sliding below the VWAP while it holds.",
    }
