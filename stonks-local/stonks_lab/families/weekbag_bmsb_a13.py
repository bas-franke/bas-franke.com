"""weekbag_bmsb_a13 v1 (agent-13): the folklore "bull market support band" on weekly closes, optionally in 7 weekday tranches.

The bull market support band (crypto folklore) is the 20-week SMA and the 21-week EMA of the weekly close. Bull while
the week closes above the band, bear once it closes below. Here: buy when a weekly close is above BOTH lines, sell
when it is below BOTH (inside the band nothing changes), else hold ``offWeight``.

Which weekday a "week" ends on is arbitrary (Bitvavo's 1W candle ends on Sunday), so the family can also split the
money into 7 tranches whose weeks end on Monday..Sunday (``phases`` 7): tranche d builds its weekly closes from the
1d closes of weekday d and decides at that day's close. The position is the mean of the tranches' latest decisions,
re-emitted every day once all have decided. ``phases`` 1 runs one tranche whose week ends on ``weekday`` (6 = Sunday,
the native weekly candle). Interval 1d. Multi-market: equal split, each coin its own band.
Decisions use candles up to and including bar t only.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "weekbag_bmsb_a13"
VERSION = 1
TITLE = "Bull market support band, weekday tranches"
BOT_READY = False
MULTI_MARKET = True

DAY_MS = 86_400_000
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def default_params() -> dict:
    return {"smaWeeks": 20, "emaWeeks": 21, "phases": 7, "weekday": 6, "offWeight": 0.0}


def param_space() -> dict:
    return {
        "smaWeeks": {"type": "int", "min": 5, "max": 60, "description": "weeks in the band's simple moving average"},
        "emaWeeks": {"type": "int", "min": 5, "max": 60, "description": "weeks in the band's exponential average"},
        "phases": {"type": "choice", "values": [1, 7],
                   "description": "1 = one weekly clock ending on 'weekday'; 7 = seven tranches, one per weekday"},
        "weekday": {"type": "int", "min": 0, "max": 6,
                    "description": "with phases 1: the day the week ends on (0 = Monday .. 6 = Sunday)"},
        "offWeight": {"type": "float", "min": 0.05, "max": 0.5, "zero": True,
                      "description": "share kept in the coin while bearish (0 = all out)"},
    }


def warmup(p: dict) -> int:
    return 7 * max(int(p["smaWeeks"]), int(p["emaWeeks"])) + 7


def weekday_of(ts: np.ndarray) -> np.ndarray:
    """0 = Monday .. 6 = Sunday for bar open times in ms (1970-01-01 was a Thursday)."""
    return ((np.asarray(ts, dtype=np.int64) // DAY_MS) + 3) % 7


def tranche(c: np.ndarray, wd: np.ndarray, day: int, p: dict) -> np.ndarray:
    """Daily weights (forward-filled) of the tranche whose week ends on ``day``; NaN before its first decision."""
    n = len(c)
    pos = np.flatnonzero((wd == day) & np.isfinite(c))
    out = np.full(n, np.nan)
    if len(pos) == 0:
        return out
    wc = c[pos]
    s = ind.sma(wc, int(p["smaWeeks"]))
    e = ind.ema(wc, int(p["emaWeeks"]))
    off = float(p.get("offWeight") or 0.0)
    cur = np.nan
    dec = np.full(len(pos), np.nan)
    for k in range(len(pos)):
        if not (np.isfinite(s[k]) and np.isfinite(e[k])):
            continue
        hi, lo = max(s[k], e[k]), min(s[k], e[k])
        if wc[k] > hi:
            cur = 1.0
        elif wc[k] < lo:
            cur = off
        elif cur != cur:
            cur = off            # first decision inside the band: not yet a bull signal
        dec[k] = cur
    out[pos] = dec
    ok = np.isfinite(out)
    idx = np.where(ok, np.arange(n), -1)
    np.maximum.accumulate(idx, out=idx)
    return np.where(idx >= 0, out[np.maximum(idx, 0)], np.nan)


def sleeve(c: np.ndarray, ts: np.ndarray, p: dict) -> np.ndarray:
    wd = weekday_of(ts)
    days = list(range(7)) if int(p["phases"]) == 7 else [int(p["weekday"])]
    acc = np.zeros(len(c))
    for d in days:
        acc = acc + tranche(c, wd, d, p)
    avg = acc / len(days)
    if len(days) == 1:
        return np.where(wd == days[0], avg, np.nan)   # one decision a week, at the week's last close
    return avg


def targets(candles, spec, start_time=None):
    p = spec["params"]
    ms = list(spec["markets"])
    idx = union_index(candles, ms)
    k, mw = len(ms), max_weight(spec)
    return frame(idx, {m: sleeve(aligned_close(candles, m, idx), idx, p) * (mw / k) for m in ms})


def explain(spec) -> dict:
    p = spec["params"]
    mk = market_names(spec)
    band = f"the {int(p['smaWeeks'])}-week simple and {int(p['emaWeeks'])}-week exponential average of weekly closes"
    off = float(p.get("offWeight") or 0.0)
    steps = []
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split equally over {mk}; each part follows its own coin.")
    if int(p["phases"]) == 7:
        steps.append("Each part is split again into 7 slices; slice d counts weeks that end on a different weekday "
                     "(Monday..Sunday), so a switch happens in steps over a week.")
        when = "the slice's weekly close"
    else:
        when = f"each {DAYS[int(p['weekday'])]} close (the end of its week)"
    steps += [
        f"The 'bull market support band' is {band}.",
        f"At {when} it buys when the close is above both lines and sells when it is below both "
        + (f"(keeping {pct(off)} in the coin)." if off > 0 else "(all to euros)."),
        "Inside the band nothing changes.",
    ]
    return {
        "summary": f"Holds {mk} while the weekly close is above the bull market support band (20-week SMA / 21-week "
                   "EMA style), out below it.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bear markets: it is out once the weekly close falls through the band.",
        "whenItLoses": "Sharp dips inside bull markets and fast recoveries: weekly closes react late, so it sells low "
                       "and buys back higher.",
    }
