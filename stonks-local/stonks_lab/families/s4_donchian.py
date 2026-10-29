"""s4_donchian: turtle-style channel breakouts with a volatility trailing exit, plus dip buying between trends."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s4_donchian"
VERSION = 1
TITLE = "Channel breakout"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"entry_days": 30.0, "trail": 3.0, "dip_hours": 24.0, "dip": 2.2, "target": 0.5}


def param_space() -> dict:
    return {
        "entry_days": {"type": "float", "min": 3.0, "max": 120.0,
                       "description": "days in the breakout channel: buy when the close beats its highest close"},
        "trail": {"type": "float", "min": 0.5, "max": 10.0,
                  "description": "trailing exit distance below the best close, in daily volatilities"},
        "dip_hours": {"type": "float", "min": 2.0, "max": 240.0,
                      "description": "hours in the moving average that dips are measured against"},
        "dip": {"type": "float", "min": 0.3, "max": 5.0,
                "description": "buy a dip this many volatilities below that average"},
        "target": {"type": "float", "min": -2.0, "max": 3.0,
                   "description": "sell the dip trade this many volatilities above the average"},
    }


def valid_params(p: dict) -> str | None:
    return None


def _step(df) -> float:
    idx = np.asarray(df.index, dtype=np.int64)
    if len(idx) < 2:
        return 900_000.0
    return max(float(np.median(np.diff(idx))), 1.0)


def _bars(step: float, hours: float) -> int:
    return max(2, int(round(hours * 3_600_000 / step)))


def warmup(p: dict) -> int:
    # in 15m bars (the scoring interval); the targets themselves stay NaN-safe on any interval
    return int(round(max(float(p["entry_days"]), 14.0) * 96))


def _prior(x: np.ndarray, n: int, how: str) -> np.ndarray:
    r = pd.Series(x).rolling(n, min_periods=n)
    v = (r.max() if how == "max" else r.min()).to_numpy(np.float64)
    out = np.full(len(x), np.nan)
    out[1:] = v[:-1]
    return out


def _weights(df, entry_days, trail, dip_hours, dip, target, stop=3.0) -> np.ndarray:
    step = _step(df)
    c = df["close"].to_numpy(np.float64)
    n_e = _bars(step, entry_days * 24.0)
    n_d = _bars(step, dip_hours)
    n_v = _bars(step, 7 * 24.0)
    hiN = _prior(c, n_e, "max")
    mean = pd.Series(c).rolling(n_d, min_periods=n_d).mean().to_numpy(np.float64)
    lr = np.zeros(len(c))
    lr[1:] = np.diff(np.log(c))
    vol = pd.Series(lr).rolling(n_v, min_periods=n_v).std().to_numpy(np.float64) * np.sqrt(86_400_000 / step)
    sd = vol * np.sqrt(dip_hours / 24.0)     # the usual move over the dip window
    w = np.zeros(len(c))
    mode = 0          # 0 flat, 1 trend, 2 dip
    peak = 0.0
    entry = 0.0
    for i in range(len(c)):
        x = c[i]
        if not (hiN[i] == hiN[i] and vol[i] == vol[i] and mean[i] == mean[i]):
            continue
        if mode == 1:
            if x > peak:
                peak = x
            if x < peak * (1.0 - trail * vol[i]):
                mode = 0
        elif mode == 2:
            if x > hiN[i]:
                mode, peak = 1, x
            elif x >= mean[i] * (1.0 + target * sd[i]) or x < entry * (1.0 - stop * sd[i]):
                mode = 0
        if mode == 0:
            if x > hiN[i]:
                mode, peak = 1, x
            elif x < mean[i] * (1.0 - dip * sd[i]):
                mode, entry = 2, x
        w[i] = 1.0 if mode else 0.0
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, float(p["entry_days"]), float(p["trail"]), float(p["dip_hours"]), float(p["dip"]),
                 float(p["target"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Buys {mk} when the close beats its {p['entry_days']:g}-day high and rides it with a trailing exit. "
            f"Between trends it buys sharp dips under the {p['dip_hours']:g}-hour average and sells the bounce."
        ),
        "howItWorks": [
            f"The channel top is the highest close of the last {p['entry_days']:g} days, not counting the current candle.",
            "A close above the channel top is a breakout: the book goes all in.",
            f"It stays in until the price falls {p['trail']:g} daily volatilities below the best close since buying "
            "(daily volatility = the usual size of a one-day move over the last week).",
            f"While flat, a close {p['dip']:g} volatilities below the {p['dip_hours']:g}-hour average is a dip: it buys "
            f"(volatility here is scaled to {p['dip_hours']:g} hours).",
            f"The dip trade sells once the price is {p['target']:g} volatilities above that average, or cuts the loss "
            "3 volatilities under its buy price. A breakout during a dip trade turns it into a trend trade.",
        ] + risk_steps(spec),
        "whenItWins": "A big rise that starts with a clean breakout, a big fall that drops well past the trailing exit, "
                      "and quiet weeks with sharp dips that bounce back.",
        "whenItLoses": "False breakouts that reverse straight away, and dips that turn into a crash before the stop.",
    }
