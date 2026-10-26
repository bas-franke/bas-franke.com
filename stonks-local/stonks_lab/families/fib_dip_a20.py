"""fib_dip_a20 v1 (agent-20): Fibonacci retracement dip buys, optionally on top of an SMA trend core.

Folklore every chart tool ships: after a rally (a "leg" from a swing low L to a swing high H) the price pulls back to
a Fibonacci level of that leg (38.2 %, 50 %, 61.8 %, 78.6 %) and resumes. Every dip family the fleet tried measures
depth against the price (RSI, z-score, % under a high); this one measures it against the size of the preceding
rally, and lets the paired grid answer whether the golden ratios are special (``fib`` is a free number, so 0.618
can be compared with 0.55 / 0.68).

Per market, on its own candles, a decision at bar t uses closes up to and including t only:

- H_t = highest close of the last ``swingLook`` candles (bar iH); L_t = lowest close of the ``legLook`` candles
  ending at iH (the low the rally started from). The leg is valid when H / L - 1 >= ``minLeg``.
- buy level = H - ``fib`` x (H - L); stop level = H - ``stopFib`` x (H - L) (1.0 = the leg low);
  target = H - ``targetFib`` x (H - L) (0 = back at the old high).
- Entry (not in a dip trade): valid leg, stop level < close <= buy level, and no dip trade on this swing high yet
  (one trade per swing high). With ``coreMode`` "gate" the close must also be above SMA(``coreSma``).
- Exit: close < stop level (the leg failed), close >= target (``takeTarget``), or after ``maxHold`` candles
  (0 = no limit). Levels are frozen at the entry.
- ``coreMode`` "or": also hold while close > SMA(``coreSma``) (trend core + dips); "gate": dips only, in uptrends;
  ``coreSma`` 0: dips only, no filter (cash base).

Weight maxWeight while held, else 0.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "fib_dip_a20"
VERSION = 1
TITLE = "Fibonacci retracement dip buys"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"swingLook": 60, "legLook": 120, "minLeg": 0.3, "fib": 0.618, "stopFib": 1.0, "targetFib": 0.0,
            "takeTarget": True, "maxHold": 60, "coreSma": 150, "coreMode": "or"}


def param_space() -> dict:
    return {
        "swingLook": {"type": "int", "min": 10, "max": 400, "log": True,
                      "description": "swing high = highest close of this many candles"},
        "legLook": {"type": "int", "min": 10, "max": 500, "log": True,
                    "description": "leg low = lowest close of this many candles up to the swing high"},
        "minLeg": {"type": "float", "min": 0.05, "max": 2.0, "log": True,
                   "description": "minimum rally size H/L - 1 for a leg to count"},
        "fib": {"type": "float", "min": 0.2, "max": 0.9,
                "description": "buy when the close has given back this share of the leg (0.618 = golden ratio)"},
        "stopFib": {"type": "float", "min": 0.5, "max": 1.5,
                    "description": "sell when the close has given back this share of the leg (1 = leg low)"},
        "targetFib": {"type": "float", "min": 0.0, "max": 0.5,
                      "description": "take profit once only this share of the leg is still missing (0 = old high)"},
        "takeTarget": {"type": "bool", "description": "sell the dip trade at the target"},
        "maxHold": {"type": "int", "min": 2, "max": 400, "zero": True, "log": True,
                    "description": "sell a dip trade after this many candles (0 = no limit)"},
        "coreSma": {"type": "int", "min": 10, "max": 600, "zero": True, "log": True,
                    "description": "SMA of the trend core / gate (0 = dips only, no filter)"},
        "coreMode": {"type": "choice", "values": ["or", "gate"],
                     "description": "or = hold the core too; gate = dip buys only while above the SMA"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["stopFib"]) <= float(p["fib"]) + 0.05:
        return "stopFib must be at least 0.05 deeper than fib"
    if float(p["targetFib"]) >= float(p["fib"]) - 0.05:
        return "targetFib must be at least 0.05 above the buy level (smaller than fib)"
    return None


def warmup(p: dict) -> int:
    return max(int(p["swingLook"]) + int(p["legLook"]), int(p.get("coreSma") or 0))


def fib_trades(c: np.ndarray, p: dict, gate: np.ndarray | None = None) -> np.ndarray:
    """0/1 dip-trade state per bar (NaN before the first full swing window)."""
    n = len(c)
    sl, ll = int(p["swingLook"]), int(p["legLook"])
    min_leg, fib, stop_f, tgt_f = float(p["minLeg"]), float(p["fib"]), float(p["stopFib"]), float(p["targetFib"])
    take, max_hold = bool(p["takeTarget"]), int(p.get("maxHold") or 0)
    out = np.full(n, np.nan)
    first = sl + ll - 2
    in_trade, held, last_h_idx = False, 0, -1
    stop = tgt = 0.0
    for t in range(first, n):
        x = c[t]
        if in_trade:
            held += 1
            if x < stop or (take and x >= tgt) or (max_hold and held >= max_hold):
                in_trade = False
        if not in_trade:
            w0 = t - sl + 1
            ih = w0 + int(np.argmax(c[w0:t + 1]))
            h = c[ih]
            lo = float(np.min(c[max(0, ih - ll + 1):ih + 1]))
            if ih != last_h_idx and lo > 0 and h / lo - 1.0 >= min_leg:
                leg = h - lo
                buy, stp = h - fib * leg, h - stop_f * leg
                if stp < x <= buy and (gate is None or gate[t] == 1):
                    in_trade, held, last_h_idx = True, 0, ih
                    stop, tgt = stp, h - tgt_f * leg
        out[t] = 1.0 if in_trade else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    n_sma = int(p.get("coreSma") or 0)
    mode = p.get("coreMode", "or")
    core = None
    if n_sma > 0:
        sm = ind.sma(c, n_sma)
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    dip = fib_trades(c, p, gate=core if (core is not None and mode == "gate") else None)
    if core is None:
        on = dip
    elif mode == "gate":
        on = np.where(np.isfinite(core), dip, np.nan)
    else:
        on = np.where(np.isfinite(core) & np.isfinite(dip), np.maximum(np.nan_to_num(core), np.nan_to_num(dip)),
                      np.nan)
    return frame(df.index, {m: on * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    n_sma, mode = int(p.get("coreSma") or 0), p.get("coreMode", "or")
    steps = [
        f"It finds the last rally of {mk}: the highest close of the last {bars_text(p['swingLook'], iv)} and the "
        f"lowest close in the {bars_text(p['legLook'], iv)} before it; the rally must be at least "
        f"{pct(float(p['minLeg']))}.",
        f"When the price has given back {pct(float(p['fib']))} of that rally (a Fibonacci retracement) it buys, "
        "once per swing high.",
        f"It sells that dip trade if the price gives back {pct(float(p['stopFib']))} of the rally (the rally failed)"
        + (f", when the price is back within {pct(float(p['targetFib']))} of the rally from the old high"
           if p.get("takeTarget") else "")
        + (f", or after {bars_text(p['maxHold'], iv)}" if int(p.get("maxHold") or 0) else "") + ".",
    ]
    if n_sma and mode == "or":
        steps.append(f"Besides the dip trades it holds {mk} while the price is above its {bars_text(n_sma, iv)} "
                     "average (trend core).")
    elif n_sma:
        steps.append(f"It only buys dips while the price is above its {bars_text(n_sma, iv)} average.")
    return {
        "summary": f"Buys {mk} when a pullback reaches a Fibonacci level of the last rally"
                   + (", on top of a trend core." if n_sma and mode == "or" else "."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with orderly pullbacks that stop half-way down the last leg and run to new highs.",
        "whenItLoses": "Tops: the first pullback after the last rally looks the same, and it buys into the crash "
                       "until the stop level.",
    }
