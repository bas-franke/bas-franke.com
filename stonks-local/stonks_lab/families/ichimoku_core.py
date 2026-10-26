"""ichimoku_core v1 (agent-19, trend lane): Ichimoku cloud as a long-only trend core on one coin.

Lines (all from candles up to and including bar t, nothing projected forward):
- Tenkan = midpoint of the highest high and lowest low over ``tenkan`` candles; Kijun = same over ``kijun``.
- Cloud at bar t = the two spans computed ``shift`` candles ago: span A = (Tenkan + Kijun) / 2, span B = midpoint
  over ``senkouB`` candles. (Charting packages draw the spans ``shift`` candles into the future; reading them
  ``shift`` candles later is the same value with no look-ahead.)
Buy when the close is above the cloud top (and, with ``tkCross``, Tenkan > Kijun; with ``chikou``, the close is
above the close ``shift`` candles ago). Sell when the close falls under the exit line: ``cloud`` = cloud bottom,
``top`` = cloud top, ``kijun`` = the Kijun line. Midpoints of the high/low range react differently from moving
averages: they ignore how the price got there and jump when an old extreme leaves the window.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "ichimoku_core"
VERSION = 1
TITLE = "Ichimoku cloud trend core"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"tenkan": 20, "kijun": 60, "senkouB": 120, "shift": 30, "tkCross": False, "chikou": False,
            "exitLine": "cloud"}


def param_space() -> dict:
    return {
        "tenkan": {"type": "int", "min": 3, "max": 80, "log": True, "description": "conversion line range in candles"},
        "kijun": {"type": "int", "min": 10, "max": 250, "log": True, "description": "base line range in candles"},
        "senkouB": {"type": "int", "min": 20, "max": 500, "log": True,
                    "description": "range of the slow cloud span in candles"},
        "shift": {"type": "int", "min": 1, "max": 150, "log": True, "zero": True,
                  "description": "candles the cloud lags behind (Ichimoku's displacement; 0 = cloud of today)"},
        "tkCross": {"type": "bool", "description": "also require Tenkan above Kijun to buy"},
        "chikou": {"type": "bool", "description": "also require the close above the close `shift` candles ago to buy"},
        "exitLine": {"type": "choice", "values": ["cloud", "top", "kijun"],
                     "description": "sell under the cloud bottom, the cloud top, or the Kijun line"},
    }


def valid_params(p: dict) -> str | None:
    if not int(p["tenkan"]) < int(p["kijun"]) <= int(p["senkouB"]):
        return "need tenkan < kijun <= senkouB"
    return None


def warmup(p: dict) -> int:
    return int(p["senkouB"]) + int(p["shift"] or 0)


def _mid(h, lo, n):
    return (ind.rolling_max(h, n) + ind.rolling_min(lo, n)) / 2.0


def _lag(x, k):
    return ind.shift(x, k) if k else x


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    h = df["high"].to_numpy(np.float64)
    lo = df["low"].to_numpy(np.float64)
    n = len(c)
    k = int(p["shift"] or 0)
    tk = _mid(h, lo, int(p["tenkan"]))
    kj = _mid(h, lo, int(p["kijun"]))
    sa = _lag((tk + kj) / 2.0, k)
    sb = _lag(_mid(h, lo, int(p["senkouB"])), k)
    top, bot = np.fmax(sa, sb), np.fmin(sa, sb)
    defined = np.isfinite(sa) & np.isfinite(sb)
    cprev = _lag(c, k)
    if p["chikou"] and k:
        defined &= np.isfinite(cprev)
    exit_line = {"cloud": bot, "top": top, "kijun": kj}[p["exitLine"]]
    w = np.full(n, np.nan)
    mw = max_weight(spec)
    held = False
    for i in range(n):
        if not defined[i]:
            continue
        if held:
            if c[i] < exit_line[i]:
                held = False
        elif (c[i] > top[i] and (not p["tkCross"] or tk[i] > kj[i])
              and (not p["chikou"] or not k or c[i] > cprev[i])):
            held = True
        w[i] = mw if held else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    k = int(p["shift"] or 0)
    extra = []
    if p["tkCross"]:
        extra.append(f"the {bars_text(int(p['tenkan']), iv)} midpoint is above the {bars_text(int(p['kijun']), iv)} one")
    if p["chikou"] and k:
        extra.append(f"the price is above where it was {bars_text(k, iv)} ago")
    exit_txt = {"cloud": "under the bottom of the cloud", "top": "back into the cloud",
                "kijun": f"under the midpoint of the last {bars_text(int(p['kijun']), iv)}"}[p["exitLine"]]
    steps = [
        f"After every {iv} candle it draws the Ichimoku 'cloud' for {mk}: two midpoints of the high-low range (a "
        f"blend of {bars_text(int(p['tenkan']), iv)} and {bars_text(int(p['kijun']), iv)}, and "
        f"{bars_text(int(p['senkouB']), iv)}), as they were {bars_text(k, iv)} ago.",
        "It buys when the close rises above the cloud" + (" and " + " and ".join(extra) if extra else "") + ".",
        f"It sells everything when the close falls {exit_txt}, then waits in euros.",
    ]
    return {
        "summary": f"A trend core on {mk} from the Ichimoku cloud: in while the price is above the cloud, out "
                   "when it breaks down.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends in either direction: it holds the bull runs and sits out the long slides.",
        "whenItLoses": "Sideways markets that move in and out of the cloud, and fast V-shaped recoveries it re-enters late.",
    }
