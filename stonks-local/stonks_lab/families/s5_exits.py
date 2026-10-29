"""s5_exits: the Session 4 #1 entries (sharp dips, new-high breakouts) with stepped profit-taking on rides."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s5_exits"
VERSION = 1
TITLE = "Dip and breakout, banking gains"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"dip_hours": 9.0, "dip_depth": 2.2, "dip_exit": -0.55, "vol_days": 9.075,
            "high_days": 27.0, "giveback": 3.3, "take_gain": 0.15, "take_frac": 0.5, "take_steps": 2}


def param_space() -> dict:
    return {
        "dip_hours": {"type": "float", "min": 2.0, "max": 72.0, "description": "hours in the short average a dip is measured from"},
        "dip_depth": {"type": "float", "min": 0.8, "max": 5.0, "description": "how many typical swings below that average counts as a dip"},
        "dip_exit": {"type": "float", "min": -2.0, "max": 1.5, "description": "sell the dip trade when price is back this many swings from the average (negative = just below it)"},
        "vol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history used to measure the typical swing"},
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends when price falls this many daily swings below its peak"},
        "take_gain": {"type": "float", "min": 0.02, "max": 2.0, "description": "log gain of a ride (peak over buy) at which part of it is sold"},
        "take_frac": {"type": "float", "min": 0.0, "max": 0.9, "description": "share of what is left of the ride that each profit-taking step sells"},
        "take_steps": {"type": "int", "min": 1, "max": 4, "description": "number of profit-taking steps: step m sells at m x take_gain"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["dip_exit"]) <= -float(p["dip_depth"]):
        return "dip_exit must be above -dip_depth, or a dip trade would sell the bar it buys"
    return None


def _step(index) -> float:
    ts = np.asarray(index, dtype=np.int64)
    if len(ts) < 2:
        return 900_000.0
    return max(float(np.median(np.diff(ts))), 1.0)


def _bars(step: float, hours: float) -> int:
    return max(2, int(round(hours * 3_600_000 / step)))


def warmup(p: dict) -> int:
    # in 15m bars (the lab's finest research interval): the longest lookback
    return int(max(float(p["high_days"]), float(p["vol_days"])) * 96)


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(x).ewm(span=max(1, int(span)), adjust=False).mean().to_numpy()


def _weights(df, p) -> np.ndarray:
    c = df["close"].to_numpy(dtype=np.float64)
    n = len(c)
    if n == 0:
        return np.zeros(0)
    step = _step(df.index)
    lc = np.log(np.maximum(c, 1e-12))
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["vol_days"])))   # mean squared bar move
    # dip layer: distance below a short average, in units of the swing expected over that many hours
    nd = _bars(step, float(p["dip_hours"]))
    mean = _ema(lc, nd)
    z = (lc - mean) / np.maximum(np.sqrt(var_bar * nd), 1e-9)
    # breakout layer: a close above the highest close of the previous high_days, trailing exit in daily swings
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    k, ex, give = float(p["dip_depth"]), float(p["dip_exit"]), float(p["giveback"])
    take_g, take_f = float(p["take_gain"]), float(p["take_frac"])
    nsteps = max(1, int(round(float(p["take_steps"]))))
    w = np.zeros(n)
    dip = ride = level = 0
    peak = entry = 0.0
    zl, ll, hl, sl = z.tolist(), lc.tolist(), hi.tolist(), day_sd.tolist()
    for i in range(n):
        if dip == 0:
            if zl[i] < -k:
                dip = 1
        elif zl[i] > ex:
            dip = 0
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i]:
                ride, peak, entry, level = 1, ll[i], ll[i], 0
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * sl[i]:
                ride = 0
            else:
                while level < nsteps and peak - entry >= take_g * (level + 1):
                    level += 1
        rw = (1.0 - take_f) ** level if ride else 0.0
        w[i] = 1.0 if dip else rw
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    w = _weights(df, spec["params"])
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    g = float(p["take_gain"])
    n = max(1, int(round(float(p["take_steps"]))))
    f = float(p["take_frac"])
    steps = ", ".join(f"{(np.exp(g * (m + 1)) - 1) * 100:.0f} %" for m in range(n))
    left = (1 - f) ** n * 100
    return {
        "summary": (
            f"Trades {mk}. Buys sharp dips below the {p['dip_hours']:g}-hour average and sells them on the bounce; "
            f"rides any close above the {p['high_days']:g}-day high, banks part of the ride as it climbs, and lets "
            f"the rest run until price gives back {p['giveback']:g} daily swings."
        ),
        "howItWorks": [
            f"A swing is the typical price move, measured from the last {p['vol_days']:g} days of candles.",
            f"Dip trade: when price is {p['dip_depth']:g} swings below its {p['dip_hours']:g}-hour average, buy with "
            f"everything. Sell when it is back to {p['dip_exit']:g} swings from that average.",
            f"Ride: when price closes above the highest close of the previous {p['high_days']:g} days, buy with everything.",
            f"Banking gains: each time the ride's best price is up another step ({steps} above the buy), "
            f"{f * 100:g} % of what is still riding is sold. After all steps {left:.0f} % rides on.",
            f"The ride ends when price falls {p['giveback']:g} daily swings below its best price since the buy. "
            "Because part of a big winner is already sold by then, a reversal from the top costs much less.",
            "A dip buy during a ride tops the book back up to fully in until the bounce.",
        ] + risk_steps(spec),
        "whenItWins": "Sideways markets with sharp sell-offs that bounce, and rallies that climb, stall and fall back.",
        "whenItLoses": "Very long rallies (the banked part misses the rest of the climb) and breakouts that fail right after the buy.",
    }
