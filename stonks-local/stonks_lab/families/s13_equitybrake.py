"""s13_equitybrake: a slow book-level brake on s9_cyclebull that only sizes new buys.

The layer keeps a virtual equity curve of the main strategy itself, worked out from its weights and closes (with the
maker fee), so the brake reads the main strategy's own health and not its own trimmed result. Once a day it looks at how
deep the curve has fallen under its running high:
  depth <= brake_on               new buys stay whole
  brake_on .. brake_on + width    new buys slide down to floor
  deeper                          new buys stay at floor
The deepest depth since the high counts, so the brake only tightens during a fall. It lets go in one piece when the curve
stands rec above its lowest close since the high (progress), and that close becomes the new running high. A new high
lets go too. The size of a buy is set when the main strategy buys: the layer never sells on its own. What a position
bought small stays small until the main strategy closes it, and the main strategy's sells stay proportional.
"""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names
from ._s13_core import trimmed

NAME = "s13_equitybrake"
VERSION = 1
TITLE = "Slow equity brake"
BOT_READY = False
MULTI_MARKET = False

_DAY = 86_400_000
_FEE = 0.0015


def default_params() -> dict:
    return {"brake_on": 0.2, "width": 0.1, "floor": 0.4, "rec": 0.1}


def param_space() -> dict:
    return {
        "brake_on": {"type": "float", "min": 0.05, "max": 0.6, "description": "fall of the main strategy's own curve under its high where the brake starts"},
        "width": {"type": "float", "min": 0.0, "max": 0.4, "description": "further fall over which new buys slide down to floor"},
        "floor": {"type": "float", "min": 0.0, "max": 1.0, "description": "lowest share of the usual size for a new buy"},
        "rec": {"type": "float", "min": 0.01, "max": 2.0, "description": "gain off the curve's low that releases the brake"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["brake_on"]) + float(p["width"]) >= 1.0:
        return "brake_on + width must stay under 1"
    return None


def warmup(p: dict) -> int:
    return 0


def _curve(core: np.ndarray, close: np.ndarray) -> np.ndarray:
    """The main strategy's virtual equity: the last weight earns this bar's move, weight changes pay the maker fee."""
    move = np.r_[0.0, np.nan_to_num(close[1:] / close[:-1] - 1.0)]
    held = np.r_[0.0, core[:-1]]
    return np.cumprod(1.0 + held * move - _FEE * np.abs(np.diff(core, prepend=0.0)))


def _levels(day_eq: np.ndarray, p: dict) -> np.ndarray:
    """Share of the usual size for new buys, decided at each day's last close."""
    on, wide, floor, rec = float(p["brake_on"]), float(p["width"]), float(p["floor"]), float(p["rec"])
    out = np.ones(len(day_eq))
    high = low = float(day_eq[0]) if len(day_eq) else 1.0
    depth = 0.0
    for i, e in enumerate(day_eq):
        e = float(e)
        if e >= high or (depth > 0.0 and e >= low * (1.0 + rec)):
            high = low = e
            depth = 0.0
        low = min(low, e)
        depth = max(depth, 1.0 - e / high)
        out[i] = 1.0 - (1.0 - floor) * min(max((depth - on) / max(wide, 1e-9), 0.0), 1.0)
    return out


def _on_buys(core: np.ndarray, level: np.ndarray) -> np.ndarray:
    """Apply the level to what the main strategy adds; what is held keeps its share until the position closes."""
    out = np.ones(len(core))
    change = np.flatnonzero(np.abs(np.diff(core, prepend=0.0)) > 1e-12)
    share, prev, val = 1.0, 0.0, np.ones(len(change))
    for j, b in enumerate(change):
        now = float(core[b])
        if now <= 1e-12:
            share = 1.0
        elif now > prev:
            share = (prev * share + (now - prev) * float(level[b])) / now
        val[j], prev = share, now
    k = np.searchsorted(change, np.arange(len(core)), side="right") - 1
    out[k >= 0] = val[k[k >= 0]]
    return out


def _trim(df, core, p) -> np.ndarray:
    eq = _curve(core, df["close"].to_numpy(np.float64))
    day = np.asarray(df.index, dtype=np.int64) // _DAY
    last = np.flatnonzero(np.diff(day) > 0)     # the last bar of every finished day
    level = np.ones(len(df))
    if len(last):
        lv = _levels(eq[last], p)
        k = np.searchsorted(last, np.arange(len(df)), side="left")     # a day's level starts on the next day's first bar
        level[k > 0] = lv[k[k > 0] - 1]
    return _on_buys(core, level)


def targets(candles, spec, start_time=None):
    del start_time
    m, df, w = trimmed(candles, spec, _trim)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    on, full = float(p["brake_on"]) * 100, (float(p["brake_on"]) + float(p["width"])) * 100
    fl, rec = float(p["floor"]) * 100, float(p["rec"]) * 100
    return {
        "summary": f"Bitcoin bull, cycle check on {mk} with a slow brake: after a deep loss its new buys are at most {fl:.0f} % of their usual size.",
        "howItWorks": [
            "Keeps a paper curve of what the main strategy would earn untouched, and checks it once a day.",
            f"From {on:.0f} % under that curve's high new buys shrink, down to {fl:.0f} % of their size at {full:.0f} % under it.",
            f"The brake lets go once the curve is {rec:.0f} % above its low.",
            "It never sells: a position bought small simply stays small until the main strategy closes it.",
        ],
        "whenItWins": "In crash weeks, when the dip ladder would buy the second leg of a fall at full size.",
        "whenItLoses": "When the loss ends at once and the rebound is ridden at a smaller size. It cannot help in a sudden fall from a fresh high.",
        "vsBuyHold": "Holds no more than the main strategy, and less after a deep loss.",
    }
