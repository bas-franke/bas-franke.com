"""participation_a04 v1 (agent-04): hold BTC/ETH while participation (traded coin volume) is growing, step aside
while it is shrinking, optionally combined with an SMA trend core.

Unrecorded study (1d pre-holdout 2019-06..2025-10, fwd 30d within-year rank IC): the ratio of short to long mean coin
volume (14/90 d) ordered BTC's next month in 5/7 years (+.08..+.30, negative 2020 and 2025); its part not explained
by price momentum also 5/7. ETH 60/365 d 5/6. Weak and not one-signed: this family is the honest test as a strategy.

- v_t = ln(mean(volume, volShort) / mean(volume, volLong)), coin units (not EUR, so a price rise alone does not lift it).
- gate: in while v_t > exitV; after leaving, back in once v_t > enterV (enterV >= exitV: hysteresis).
- combine: "none" = gate only; "and" = gate AND close > SMA(coreLen); "or" = gate OR close > SMA(coreLen).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "participation_a04"
VERSION = 1
TITLE = "Hold while trading participation grows"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"volShort": 14, "volLong": 90, "exitV": -0.2, "enterV": 0.0, "combine": "none", "coreLen": 130}


def param_space() -> dict:
    return {
        "volShort": {"type": "int", "min": 3, "max": 120, "log": True,
                     "description": "candles in the recent average traded volume"},
        "volLong": {"type": "int", "min": 30, "max": 500, "log": True,
                    "description": "candles in the long average traded volume it is compared with"},
        "exitV": {"type": "float", "min": -1.0, "max": 0.5,
                  "description": "step aside when ln(recent / long volume) falls below this"},
        "enterV": {"type": "float", "min": -1.0, "max": 0.8,
                   "description": "buy back once ln(recent / long volume) rises above this (>= exitV)"},
        "combine": {"type": "choice", "values": ["none", "and", "or"],
                    "description": "none = volume gate only; and/or = combined with close above SMA(coreLen)"},
        "coreLen": {"type": "int", "min": 10, "max": 400, "log": True,
                    "description": "SMA length of the optional trend core"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["volShort"]) >= int(p["volLong"]):
        return "volShort must be shorter than volLong"
    if float(p["enterV"]) < float(p["exitV"]):
        return "enterV must be >= exitV"
    return None


def warmup(p: dict) -> int:
    return max(int(p["volLong"]), int(p["coreLen"]) if p["combine"] != "none" else 0)


def volume_ratio(volume: np.ndarray, short: int, long: int) -> np.ndarray:
    v = pd.Series(np.asarray(volume, dtype=np.float64))
    s = v.rolling(short, min_periods=short).mean()
    lng = v.rolling(long, min_periods=long).mean()
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.log(s.to_numpy() / lng.to_numpy())
    r[~np.isfinite(r)] = np.nan
    return r


def gate_weights(v: np.ndarray, exit_v: float, enter_v: float) -> np.ndarray:
    out = np.full(len(v), np.nan)
    held = None
    for i, x in enumerate(v):
        if not np.isfinite(x):
            if held is not None:
                out[i] = 1.0 if held else 0.0
            continue
        if held is None:
            held = x > exit_v
        elif held and x <= exit_v:
            held = False
        elif not held and x > enter_v:
            held = True
        out[i] = 1.0 if held else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    vr = volume_ratio(df["volume"].to_numpy(np.float64), int(p["volShort"]), int(p["volLong"]))
    g = gate_weights(vr, float(p["exitV"]), float(p["enterV"]))
    if p["combine"] != "none":
        sm = ind.sma(c, int(p["coreLen"]))
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
        ok = np.isfinite(g) & np.isfinite(core)
        on = np.minimum(g, core) if p["combine"] == "and" else np.maximum(g, core)
        g = np.where(ok, on, np.nan)
    return frame(df.index, {m: g * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    steps = [f"It compares how much {mk} was traded over the last {bars_text(p['volShort'], iv)} (in coins, not euros) "
             f"with the average over {bars_text(p['volLong'], iv)}.",
             f"It holds {mk} while trading is not clearly drying up and steps aside when recent volume falls to "
             f"{np.exp(float(p['exitV'])):.2f}x the long average or less; it buys back above "
             f"{np.exp(float(p['enterV'])):.2f}x."]
    if p["combine"] == "and":
        steps.append(f"It also holds only while the price is above its average over {bars_text(p['coreLen'], iv)}.")
    elif p["combine"] == "or":
        steps.append(f"While the price is above its average over {bars_text(p['coreLen'], iv)} it holds anyway.")
    return {
        "summary": f"Holds {mk} while more and more people trade it; steps aside when interest fades.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Rallies fed by new buyers, and quiet bleeding markets that everybody has left.",
        "whenItLoses": "Quiet, steady rallies on falling volume, and crashes on heavy volume.",
    }
