"""level_stop_a21 v1 (agent-21): a daily-length SMA trend core that is checked on EVERY intraday close.

Every daily trend core in the lab decides once a day at the 00:00 UTC close, and finding #505 showed that this hour
is a hidden knob worth 4-10 score points. A real trader can avoid the clock altogether by resting a stop order at
the moving average: sell the moment the price falls clearly under it, buy the moment it climbs clearly above it.

Here the line is the simple average of the last ``smaDays`` days of intraday closes (``smaDays`` x candles per day,
so it rolls with every candle and has no day boundary). With ``band`` b the coin is bought when the close is above
line x (1 + b) and sold when it is below line x (1 - b); the band absorbs intraday noise around the line.

``mode`` says which side reacts intraday (ablation):
- ``both``: entries and exits on any candle close.
- ``exit``: exits on any candle close (a resting stop), entries only at the ``decideHour`` close.
- ``entry``: entries on any candle close (a resting stop-buy), exits only at the ``decideHour`` close.
- ``daily``: both only at the ``decideHour`` close (= a daily core whose day closes at that UTC hour).

The target is re-emitted on every candle. A decision at candle t uses closes up to and including t only.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ..data import DAY, HOUR, INTERVAL_MS
from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "level_stop_a21"
VERSION = 1
TITLE = "Intraday stop at a daily trend line"
BOT_READY = False
MULTI_MARKET = False

MODES = ["both", "exit", "entry", "daily"]


def default_params() -> dict:
    return {"smaDays": 130, "band": 0.02, "mode": "both", "decideHour": 0}


def param_space() -> dict:
    return {
        "smaDays": {"type": "int", "min": 10, "max": 300, "log": True,
                    "description": "days of intraday closes in the rolling average"},
        "band": {"type": "float", "min": 0.002, "max": 0.1, "log": True, "zero": True,
                 "description": "buy above line x (1+band), sell below line x (1-band)"},
        "mode": {"type": "choice", "values": MODES,
                 "description": "which side is checked on every candle (the rest only at decideHour)"},
        "decideHour": {"type": "int", "min": 0, "max": 23,
                       "description": "UTC hour of the once-a-day check for the sides that are not intraday"},
    }


def _bpd(spec: dict) -> int:
    step = INTERVAL_MS.get(spec.get("interval") or "1h", HOUR)
    return max(1, DAY // step)


def warmup(p: dict) -> int:
    return int(p["smaDays"]) * 24  # upper bound (1h candles); the line itself is NaN until it is full


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    step = INTERVAL_MS.get(spec.get("interval") or "1h", HOUR)
    line = ind.sma(c, int(p["smaDays"]) * _bpd(spec))
    b = float(p["band"] or 0.0)
    up, dn = 1.0 + b, 1.0 - b
    mode = p["mode"]
    daily_bar = (((ts + step) % DAY) // HOUR) == int(p["decideHour"])
    fast_in = mode in ("both", "entry")
    fast_out = mode in ("both", "exit")
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    ok = np.isfinite(line)
    held = False
    started = False
    for i in range(n):
        if not ok[i]:
            continue
        can_in = fast_in or daily_bar[i]
        can_out = fast_out or daily_bar[i]
        if not started:
            if not daily_bar[i] and not (fast_in or fast_out):
                continue
            started = True
        if held:
            if can_out and c[i] < line[i] * dn:
                held = False
        elif can_in and c[i] > line[i] * up:
            held = True
        w[i] = mw if held else 0.0
    return frame(ts, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    b = float(p["band"] or 0.0)
    h = f"{int(p['decideHour']):02d}:00 UTC"
    side = {
        "both": f"Both checks run after every {iv} candle, like resting stop orders at the line.",
        "exit": f"The sell check runs after every {iv} candle (a resting stop under the line); the buy check only "
                f"once a day at {h}.",
        "entry": f"The buy check runs after every {iv} candle (a resting stop-buy over the line); the sell check only "
                 f"once a day at {h}.",
        "daily": f"Both checks run only once a day, at {h}.",
    }[p["mode"]]
    return {
        "summary": f"A slow trend filter on {mk}: hold above the {p['smaDays']}-day average, euros below it, checked "
                   f"during the day instead of only at midnight.",
        "howItWorks": [
            f"The trend line is the average of {mk}'s {iv} closes over the last {p['smaDays']} days; it moves with "
            "every candle.",
            f"It buys when the price closes more than {pct(b)} above the line.",
            f"It sells everything when the price closes more than {pct(b)} below the line, then waits in euros.",
            side,
        ] + risk_steps(spec),
        "whenItWins": "Long bear markets, which it leaves early, and long bull runs, which it holds.",
        "whenItLoses": "Sideways stretches around the line and V-shaped recoveries it buys back late and higher.",
    }
