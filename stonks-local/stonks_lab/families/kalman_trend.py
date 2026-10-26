"""kalman_trend v1 (agent-06, trend lane): local-linear-trend Kalman filter on log price, traded on the slope's t-stat.

Every moving-average core so far reacts to price *level* crosses, which fire on noise (whipsaw) as often as on trend
changes (#444 #453). A Kalman local linear trend model estimates level and slope of log price together with the
uncertainty of the slope. The signal is the slope's t-statistic t = slope / sd(slope): it only gets large when the
drift is big relative to the noise, so the same filter is cautious in chop and decisive in clean trends.

State x = [level, slope]; x_t = F x_{t-1} + noise, F = [[1, 1], [0, 1]]; observation y_t = ln(close_t) + noise.
The observation variance R_t is the EWMA variance of log returns (half-life ``volHl``, causal); the process noise is
R_t * diag(10^``logQLevel``, 10^``logQSlope``), so the filter's speed is set by two unitless ratios.

- mode "binary": buy when t >= ``zIn``, sell when t < ``zOut`` (hysteresis); hold ``maxWeight`` or nothing.
- mode "scaled": weight = clip((t - zOut) / (zIn - zOut), 0, 1) * maxWeight, rounded down to quarters; it only trades
  when the rounded weight changes, so partial exposure ramps with trend confidence.
Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import math

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "kalman_trend"
VERSION = 1
TITLE = "Kalman trend (slope t-stat)"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"logQLevel": -1.0, "logQSlope": -3.0, "volHl": 30, "zIn": 1.0, "zOut": 0.0, "mode": "binary"}


def param_space() -> dict:
    return {
        "logQLevel": {"type": "float", "min": -3.0, "max": 0.3,
                      "description": "log10 of level noise / observation noise: how fast the level follows the price"},
        "logQSlope": {"type": "float", "min": -6.0, "max": -1.3,
                      "description": "log10 of slope noise / observation noise: how fast the estimated drift can change"},
        "volHl": {"type": "int", "min": 5, "max": 200, "log": True,
                  "description": "half-life in candles of the EWMA return variance (the noise unit)"},
        "zIn": {"type": "float", "min": 0.0, "max": 4.0,
                "description": "buy (or be fully in) when the slope t-stat reaches this"},
        "zOut": {"type": "float", "min": -3.0, "max": 2.0,
                 "description": "sell (or be fully out) when the slope t-stat falls under this"},
        "mode": {"type": "choice", "values": ["binary", "scaled"],
                 "description": "all-in/all-out with hysteresis, or weight ramping with the t-stat"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["zOut"]) < float(p["zIn"]) else "zOut must be below zIn"


def warmup(p: dict) -> int:
    return max(30, 2 * int(p["volHl"]))


def slope_tstat(close: np.ndarray, q_level: float, q_slope: float, vol_hl: int) -> np.ndarray:
    """Causal t-stat of the Kalman slope of ln(close); NaN on the first bar or invalid closes."""
    y = np.log(np.asarray(close, dtype=np.float64))
    n = len(y)
    out = np.full(n, np.nan)
    if n < 2:
        return out
    lam = 0.5 ** (1.0 / max(1, int(vol_hl)))
    r = np.diff(y)
    finite = r[np.isfinite(r)]
    var = float(np.var(finite[: min(len(finite), 20)])) if len(finite) >= 2 else 1e-4
    var = max(var, 1e-8)
    var = 1e-4 if not math.isfinite(var) else var
    lvl, slp = y[0], 0.0
    p00, p01, p11 = var * 10.0, 0.0, var
    for i in range(1, n):
        yi = y[i]
        if not math.isfinite(yi):
            continue
        ri = yi - y[i - 1] if math.isfinite(y[i - 1]) else 0.0
        var = lam * var + (1.0 - lam) * ri * ri
        R = max(var, 1e-10)
        # predict
        lvl, slp = lvl + slp, slp
        a00 = p00 + 2.0 * p01 + p11 + R * q_level
        a01 = p01 + p11
        a11 = p11 + R * q_slope
        # update
        s = a00 + R
        k0, k1 = a00 / s, a01 / s
        e = yi - lvl
        lvl += k0 * e
        slp += k1 * e
        p00 = (1.0 - k0) * a00
        p01 = (1.0 - k0) * a01
        p11 = a11 - k1 * a01
        out[i] = slp / math.sqrt(p11) if p11 > 0 else np.nan
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    t = slope_tstat(c, 10.0 ** float(p["logQLevel"]), 10.0 ** float(p["logQSlope"]), int(p["volHl"]))
    zi, zo = float(p["zIn"]), float(p["zOut"])
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    start = warmup(p)
    held = 0.0
    tl = t.tolist()
    for i in range(start, n):
        ti = tl[i]
        if not math.isfinite(ti):
            if i > start:
                w[i] = w[i - 1]
            continue
        if p["mode"] == "binary":
            if held == 0.0 and ti >= zi:
                held = 1.0
            elif held > 0.0 and ti < zo:
                held = 0.0
        else:
            frac = min(1.0, max(0.0, (ti - zo) / (zi - zo)))
            held = math.floor(frac * 4.0 + 1e-9) / 4.0
        w[i] = held * mw
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    zi, zo = float(p["zIn"]), float(p["zOut"])
    steps = [
        f"After every {iv} candle a Kalman filter updates its estimate of {mk}'s trend: the current level of the "
        "(log) price, its slope, and how sure it is about that slope.",
        "It divides the slope by its uncertainty (a t-statistic), with recent volatility "
        f"(half-life {bars_text(int(p['volHl']), iv)}) as the noise unit: big only when the drift clearly beats the noise.",
    ]
    if p["mode"] == "binary":
        steps.append(f"It buys when that score reaches {zi:g} and sells when it drops under {zo:g}.")
    else:
        steps.append(f"It holds a quarter, half, three quarters or all of the money as the score climbs from {zo:g} "
                     f"to {zi:g}, and nothing under {zo:g}.")
    return {
        "summary": f"A statistical trend follower on {mk}: in while a Kalman filter is confident the trend points up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Clean, persistent trends up, and long bear markets (the slope turns negative and it sells).",
        "whenItLoses": "Sharp V-shaped recoveries (the slope needs time to turn) and choppy markets near zero slope.",
    }
