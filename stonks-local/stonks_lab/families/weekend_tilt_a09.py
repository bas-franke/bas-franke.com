"""weekend_tilt_a09 v1 (agent-09): hold, but step aside while weekdays have clearly beaten weekends lately.

Signal study behind it (agent-09, unrecorded, BTC/ETH 1d pre-holdout, forward 30 d): the mean daily log return on
weekend days (Sat/Sun UTC) minus the mean on weekdays over the last 56-84 days ranked forward returns positively
in 6/7 years on both coins, while the plain 56-84 d momentum did not (1-3/7). Weekends are retail hours (no
US/EU institutional desks, no ETF flows); a market that only goes up on weekdays and bleeds on weekends may be
carried by flows that can reverse. This family turns that into a hold/step-aside rule.

- tilt_t = mean(log return on weekend candles, last ``look`` candles) - mean(log return on weekday candles, same
  window); weekend = a candle that opens on Saturday or Sunday UTC.
- in -> out when tilt_t <= ``exitBelow``; out -> in when tilt_t >= ``enterAbove`` (hysteresis, per-day units).
- ``coreSma`` > 0 combines it with an SMA core: ``combine = or`` holds while either says hold, ``and`` only
  while both do. ``coreSma`` 0 = the tilt alone on a hold base.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "weekend_tilt_a09"
VERSION = 1
TITLE = "Weekend vs weekday return tilt"
BOT_READY = False
MULTI_MARKET = False

D_MS = 86_400_000


def default_params() -> dict:
    return {"look": 70, "exitBelow": -0.004, "enterAbove": 0.0, "coreSma": 0, "combine": "or"}


def param_space() -> dict:
    return {
        "look": {"type": "int", "min": 20, "max": 200, "log": True,
                 "description": "candles over which weekend and weekday returns are averaged"},
        "exitBelow": {"type": "float", "min": -0.015, "max": 0.0,
                      "description": "step aside when weekend minus weekday mean daily log return falls to this"},
        "enterAbove": {"type": "float", "min": -0.01, "max": 0.006,
                       "description": "hold again when it rises to this"},
        "coreSma": {"type": "int", "min": 0, "max": 250, "zero": True,
                    "description": "SMA core combined with the tilt (0 = tilt alone on a hold base)"},
        "combine": {"type": "choice", "values": ["or", "and"],
                    "description": "with a core: hold if either says hold (or) or only if both do (and)"},
    }


def valid_params(p) -> str | None:
    if float(p["exitBelow"]) > float(p["enterAbove"]):
        return "exitBelow must be <= enterAbove"
    return None


def warmup(p: dict) -> int:
    return max(int(p["look"]) + 1, int(p["coreSma"]))


def tilt(df: pd.DataFrame, look: int) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    lr = np.full(len(c), np.nan)
    lr[1:] = np.log(c[1:] / c[:-1])
    dow = ((ts // D_MS) + 3) % 7          # 1970-01-01 was a Thursday: 0 = Monday
    we = (dow >= 5).astype(np.float64)
    ok = np.isfinite(lr)
    r = np.where(ok, lr, 0.0)
    w_we, w_wd = we * ok, (1.0 - we) * ok
    s = lambda x: pd.Series(x).rolling(look, min_periods=look).sum().to_numpy()
    n_we, n_wd = s(w_we), s(w_wd)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = s(r * w_we) / n_we - s(r * w_wd) / n_wd
    out[(n_we < 2) | (n_wd < 2) | ~np.isfinite(out)] = np.nan
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    t = tilt(df, int(p["look"]))
    lo, hi = float(p["exitBelow"]), float(p["enterAbove"])
    sig = np.full(len(t), np.nan)
    state = None
    for i, v in enumerate(t.tolist()):
        if v != v:
            continue
        if state is None:
            state = 0.0 if v <= lo else 1.0
        elif state == 1.0 and v <= lo:
            state = 0.0
        elif state == 0.0 and v >= hi:
            state = 1.0
        sig[i] = state
    g = int(p["coreSma"])
    if g > 0:
        c = df["close"].to_numpy(np.float64)
        sm = ind.sma(c, g)
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
        sig = np.fmax(sig, core) if p["combine"] == "or" else sig * core
        sig[~np.isfinite(core) | ~np.isfinite(t)] = np.nan
    return frame(df.index, {m: sig * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    steps = [f"It compares the average daily move of {mk} on weekends (Saturday, Sunday) with weekdays over the last "
             f"{bars_text(p['look'], iv)}.",
             f"When weekdays beat weekends by {abs(float(p['exitBelow'])) * 100:.2f} % a day or more it steps "
             f"into euros; it buys back once the gap closes to {float(p['enterAbove']) * 100:+.2f} % a day."]
    if int(p["coreSma"]) > 0:
        steps.append(f"It also follows the {bars_text(p['coreSma'], iv)} average price: "
                     + ("it holds while either rule says hold." if p["combine"] == "or"
                        else "it holds only while both rules say hold."))
    return {
        "summary": f"Holds {mk}, stepping aside while the market rises only on weekdays and slips on weekends.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "When weekday-only rallies (institutional flows) fade and the drop follows.",
        "whenItLoses": "When weekday strength is a real trend: it sits in euros through the rise and pays fees.",
    }
