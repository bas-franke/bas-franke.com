"""rsi_dip v1: buy when RSI < buyBelow (and, with trendSma > 0, the close is above its SMA), sell when
RSI > sellAbove. In/out state carried from bar to bar; the trend filter only gates entries."""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "rsi_dip"
VERSION = 1
TITLE = "RSI dip buying"
BOT_READY = True
MULTI_MARKET = False


def default_params() -> dict:
    return {"period": 14, "buyBelow": 30, "sellAbove": 65, "trendSma": 0}


def param_space() -> dict:
    return {
        "period": {"type": "int", "min": 2, "max": 50, "description": "RSI length in candles"},
        "buyBelow": {"type": "float", "min": 5, "max": 50, "description": "buy when the RSI drops under this"},
        "sellAbove": {"type": "float", "min": 40, "max": 95, "description": "sell when the RSI rises over this"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "only buy while the close is above this SMA (0 = no filter)"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["buyBelow"] < p["sellAbove"] else "buyBelow must be below sellAbove"


def warmup(p: dict) -> int:
    t = int(p.get("trendSma") or 0)
    return max(int(p["period"]), t - 1 if t > 0 else 0)


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    r = ind.rsi(c, p["period"])
    t = int(p.get("trendSma") or 0)
    trend_ok = (c > ind.sma(c, t)) if t > 0 else np.ones(len(c), dtype=bool)
    n = len(c)
    w = np.full(n, np.nan)
    first = warmup(p)
    mw = max_weight(spec)
    buy_below, sell_above = float(p["buyBelow"]), float(p["sellAbove"])
    if first < n:
        rl, tl = r.tolist(), trend_ok.tolist()
        out = [0.0] * (n - first)
        inside = False
        for k, i in enumerate(range(first, n)):
            if not inside:
                if rl[i] < buy_below and tl[i]:
                    inside = True
            elif rl[i] > sell_above:
                inside = False
            out[k] = mw if inside else 0.0
        w[first:] = out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"After every {iv} candle it computes the RSI over {bars_text(p['period'], iv)}: a 0-100 score of how hard "
        "the price has been rising or falling lately.",
        f"When the RSI drops under {p['buyBelow']:g}, {mk} has fallen a lot in a short time: it buys the dip.",
        f"It holds until the RSI climbs over {p['sellAbove']:g} (the bounce has happened), then sells everything.",
    ]
    if int(p.get("trendSma") or 0) > 0:
        steps.insert(2, f"It only buys dips while the price is above its {bars_text(p['trendSma'], iv)} average, "
                        "so it avoids catching a falling knife in a downtrend.")
    return {
        "summary": f"Buys {mk} after sharp short-term drops and sells after the rebound.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Markets that move sideways or grind up with regular pullbacks that bounce back.",
        "whenItLoses": "Crashes and long downtrends: the dip keeps dipping and it holds a falling coin.",
    }
