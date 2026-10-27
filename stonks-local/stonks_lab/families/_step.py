"""Gradual position sizing shared by ``ind_ladder_a24`` and ``step_wrap_a24``: buy or sell a fixed slice of the
portfolio (e.g. 10 %) per step instead of going all in or all out, plus drawdown guards that scale out of a falling
market. Bar i only uses inputs up to i."""
from __future__ import annotations

import numpy as np

from .. import indicators as ind


def guard_mask(close: np.ndarray, trend_sma: int, dd_look: int, dd_max: float) -> np.ndarray:
    """True where a guard trips: close below its SMA(trend_sma), or more than dd_max below its dd_look-bar high.
    Undefined guards (warm-up, length 0) never trip."""
    g = np.zeros(len(close), dtype=bool)
    with np.errstate(invalid="ignore"):
        if trend_sma > 0:
            s = ind.sma(close, trend_sma)
            g |= np.isfinite(s) & (close < s)
        if dd_look > 0 and dd_max > 0:
            hi = ind.rolling_max(close, dd_look)
            g |= np.isfinite(hi) & (close < hi * (1.0 - dd_max))
    return g


def walk(goal: np.ndarray, decided: np.ndarray, step: float, every: int, guard: np.ndarray | None = None,
         guard_exit: bool = False) -> np.ndarray:
    """Weight path that moves toward ``goal`` by at most ``step`` per move, at most one move every ``every`` bars.

    goal NaN = no wish (hold the current weight). Before the first decided bar the output is NaN; the walk starts
    from 0 there. Where ``guard`` is True the goal becomes 0 (no buying, scale out step by step), or with
    ``guard_exit`` the weight drops to 0 at once.
    """
    n = len(goal)
    out = np.full(n, np.nan)
    gl = goal.tolist()
    dl = decided.tolist()
    gd = guard.tolist() if guard is not None else [False] * n
    w = 0.0
    started = False
    last = -10 ** 12
    every = max(1, int(every))
    for i in range(n):
        if not started:
            if not dl[i]:
                continue
            started = True
        g = gl[i]
        if gd[i]:
            if guard_exit:
                if w > 0:
                    w, last = 0.0, i
                out[i] = w
                continue
            g = 0.0 if g != g else min(g, 0.0)
        if g == g and abs(g - w) > 1e-9 and i - last >= every:
            d = g - w
            w = w + (step if d > step else -step if d < -step else d)
            w = 0.0 if w < 1e-9 else w
            last = i
        out[i] = w
    return out
