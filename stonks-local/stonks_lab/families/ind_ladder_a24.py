"""ind_ladder_a24 v2 (agent-24): one of ~30 TAAPI indicators, traded in 10 % slices instead of all in / all out.

Every indicator from ``_ta`` is normalized to about -1..+1, so one family covers them all and the sweep can compare
indicators on equal terms. ``mode`` decides what the reading means:

- ``revert``: reading <= -thr (oversold) buys one slice, >= +thr (overbought) sells one slice, in between nothing.
- ``trend``: reading >= +thr (bullish) buys one slice, <= -thr (bearish) sells one slice.
- ``revert_level`` / ``trend_level``: the reading sets a target position (0..maxPos, linear over -thr..+thr, rounded
  to whole slices) and the position walks there one slice at a time.

A slice is ``step`` of the portfolio (0.1 = 10 %), at most one slice every ``every`` bars, up to ``maxPos``.
Guards against big drops: below SMA(trendSma), or more than ddMax under the ddLook-bar high, it buys nothing and
sells a slice per step (``guardExit`` = sell everything at once instead).
"""
from __future__ import annotations

import numpy as np

from . import _step, _ta
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "ind_ladder_a24"
VERSION = 2
INVALID_BELOW_VERSION = 2  # v1 (12 smoke-test rows) had unstretched RSI/CMO/TSI/... readings
TITLE = "Indicator ladder: buy and sell in 10 % slices"
BOT_READY = False
MULTI_MARKET = False

MODES = ["revert", "trend", "revert_level", "trend_level"]


def default_params() -> dict:
    return {"indicator": "rsi", "n": 14, "mode": "revert", "thr": 0.4, "step": 0.1, "every": 1, "maxPos": 1.0,
            "trendSma": 0, "ddLook": 0, "ddMax": 0.2, "guardExit": False}


def param_space() -> dict:
    return {
        "indicator": {"type": "choice", "values": list(_ta.ALL), "description": "which TAAPI indicator"},
        "n": {"type": "int", "min": 5, "max": 200, "log": True, "description": "indicator length in bars"},
        "mode": {"type": "choice", "values": MODES,
                 "description": "revert = buy oversold/sell overbought, trend = buy bullish/sell bearish; _level = "
                                "the reading sets the position size"},
        "thr": {"type": "float", "min": 0.05, "max": 0.9, "zero": True,
                "description": "normalized reading (-1..1) that counts as a signal"},
        "step": {"type": "choice", "values": [0.05, 0.1, 0.2, 0.25, 0.5, 1.0],
                 "description": "slice of the portfolio bought or sold per step"},
        "every": {"type": "int", "min": 1, "max": 48, "log": True, "zero": False,
                  "description": "at most one slice every this many bars"},
        "maxPos": {"type": "choice", "values": [0.5, 0.7, 1.0], "description": "largest position"},
        "trendSma": {"type": "int", "min": 20, "max": 400, "log": True, "zero": True,
                     "description": "below SMA(trendSma) buy nothing and scale out (0 = off)"},
        "ddLook": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                   "description": "drawdown guard window in bars (0 = off)"},
        "ddMax": {"type": "float", "min": 0.05, "max": 0.5, "description": "drawdown from the ddLook-bar high that trips the guard"},
        "guardExit": {"type": "bool", "description": "a tripped guard sells everything at once instead of slice by slice"},
    }


def valid_params(p: dict) -> str | None:
    if p["mode"].endswith("_level") and float(p["thr"]) < 0.05:
        return "level modes need thr >= 0.05 (it is the reading that means a full position)"
    if float(p["step"]) > float(p["maxPos"]) + 1e-9:
        return "step larger than maxPos"
    return None


def warmup(p: dict) -> int:
    return max(_ta.warmup(p["indicator"], p["n"]), int(p.get("trendSma") or 0), int(p.get("ddLook") or 0))


def goal_from_reading(x: np.ndarray, mode: str, thr: float, step: float, max_pos: float) -> np.ndarray:
    """Target per bar from the normalized reading: max_pos / 0 / NaN (hold) for signal modes, a level otherwise."""
    if mode in ("revert", "revert_level"):
        x = -x
    with np.errstate(invalid="ignore"):
        if mode.endswith("_level"):
            lvl = np.clip(0.5 + 0.5 * x / thr, 0.0, 1.0) * max_pos
            return np.round(lvl / step) * step
        return np.where(x >= max(thr, 1e-12), max_pos, np.where(x <= -max(thr, 1e-12), 0.0, np.nan))


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    x = _ta.compute(p["indicator"], df, int(p["n"]))
    step, mp = float(p["step"]), float(p["maxPos"])
    goal = goal_from_reading(x, p["mode"], float(p["thr"]), step, mp)
    decided = np.isfinite(x)
    decided[: min(len(decided), warmup(p))] = False
    g = _step.guard_mask(c, int(p.get("trendSma") or 0), int(p.get("ddLook") or 0), float(p.get("ddMax") or 0))
    w = _step.walk(goal, decided, step, int(p["every"]), g, bool(p.get("guardExit")))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p = spec["params"]
    iv = spec.get("interval")
    mk = market_names(spec)
    lab = _ta.LABEL.get(p["indicator"], p["indicator"])
    st, every = float(p["step"]), int(p["every"])
    pace = "per candle" if every == 1 else f"at most once every {bars_text(every, iv)}"
    mode = p["mode"]
    thr = float(p["thr"])
    if mode == "revert":
        rule = (f"When the {lab} ({bars_text(int(p['n']), iv)}) says {mk} is oversold (reading at or below "
                f"-{thr:.2f} on a -1..+1 scale) it buys {pct(st)} of the portfolio; when it is overbought "
                f"(+{thr:.2f} or more) it sells {pct(st)}.")
    elif mode == "trend":
        rule = (f"While the {lab} ({bars_text(int(p['n']), iv)}) points up (reading at least +{thr:.2f} on a "
                f"-1..+1 scale) it buys {pct(st)} of the portfolio; while it points down it sells {pct(st)}.")
    else:
        side = "the more oversold" if mode == "revert_level" else "the more bullish"
        rule = (f"The {lab} ({bars_text(int(p['n']), iv)}) sets how much it holds: {side} the reading, the larger "
                f"the position, moved {pct(st)} of the portfolio at a time.")
    steps = [rule, f"It moves one slice {pace}, and never holds more than {pct(float(p['maxPos']))} in {mk}."]
    out = "everything at once" if p.get("guardExit") else f"{pct(st)} per step"
    if int(p.get("trendSma") or 0):
        steps.append(f"Below its {bars_text(int(p['trendSma']), iv)} average it buys nothing and sells {out}.")
    if int(p.get("ddLook") or 0):
        steps.append(f"When the price is more than {pct(float(p['ddMax']))} under its "
                     f"{bars_text(int(p['ddLook']), iv)} high it buys nothing and sells {out}.")
    steps += risk_steps(spec)
    return {
        "summary": f"Buys and sells {mk} in {pct(st)} slices on the {lab}.",
        "howItWorks": steps,
        "whenItWins": "Choppy or slowly trending markets, where scaling in and out averages the price and avoids "
                      "betting everything on one signal.",
        "whenItLoses": "Sharp V-shaped moves (it is only partly in when the move starts) and long falls when no "
                       "guard is set (it keeps buying slices on the way down in revert mode).",
    }
