"""obv_trend v1 (agent-05, trend lane): trend following on volume flow (on-balance volume) instead of price.

OBV[0] = 0; OBV[i] = OBV[i-1] + volume[i] * sign(close[i] - close[i-1]). Volume on up candles adds, on down candles
subtracts, so OBV rises while buyers keep showing up.

Rule at bar t (closes and volumes up to and including t):
- volume signal: EMA(fast) of OBV > EMA(slow) of OBV;
- optional price filter ``priceSma`` (0 = off): also require close > SMA(priceSma) of closes;
- mode "and": hold maxWeight when both agree; mode "half": hold maxWeight/2 per agreeing signal (graded).
With priceSma = 0 both modes reduce to the volume signal alone.

Why: every price-only trend family is near buy and hold with lag (findings #24, #30). If volume flow leads price,
the OBV cross should enter earlier in rallies and leave earlier in distribution tops. Nobody had tested volume yet.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "obv_trend"
VERSION = 1
TITLE = "Volume-flow trend (on-balance volume)"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"fast": 10, "slow": 50, "priceSma": 0, "mode": "and"}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 2, "max": 150, "log": True, "description": "fast EMA of OBV in candles"},
        "slow": {"type": "int", "min": 5, "max": 500, "log": True, "description": "slow EMA of OBV in candles"},
        "priceSma": {"type": "int", "min": 10, "max": 600, "zero": True, "log": True,
                     "description": "also require the price above this SMA (0 = off)"},
        "mode": {"type": "choice", "values": ["and", "half"],
                 "description": "and: hold only when volume and price agree; half: half a position per signal"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["fast"] < p["slow"] else "fast must be shorter than slow"


def warmup(p: dict) -> int:
    return max(int(p["slow"]) - 1, int(p.get("priceSma") or 0) - 1)


def obv(close: np.ndarray, volume: np.ndarray) -> np.ndarray:
    d = np.zeros_like(close)
    d[1:] = np.sign(close[1:] - close[:-1])
    v = np.nan_to_num(volume, nan=0.0)
    return np.cumsum(np.nan_to_num(d, nan=0.0) * v)


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    vol = df["volume"].to_numpy(np.float64)
    o = obv(c, vol)
    f, s = ind.ema(o, p["fast"]), ind.ema(o, p["slow"])
    sig_v = (f > s).astype(float)
    ok = np.isfinite(f) & np.isfinite(s)
    mw = max_weight(spec)
    n = int(p.get("priceSma") or 0)
    if n > 0:
        ps = ind.sma(c, n)
        sig_p = (c > ps).astype(float)
        ok &= np.isfinite(ps)
        w = mw * sig_v * sig_p if p["mode"] == "and" else mw * 0.5 * (sig_v + sig_p)
    else:
        w = mw * sig_v
    w = np.where(ok, w, np.nan)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"After every {iv} candle it updates the 'on-balance volume' of {mk}: the traded volume of a rising candle "
        "is added, that of a falling candle subtracted, so the line climbs while buyers dominate.",
        f"It compares a fast average of that line ({bars_text(p['fast'], iv)}) with a slow one "
        f"({bars_text(p['slow'], iv)}): fast above slow means money is flowing in.",
    ]
    if int(p.get("priceSma") or 0) > 0:
        if p["mode"] == "and":
            steps.append(f"It holds {mk} only while money flows in AND the price is above its "
                         f"{bars_text(p['priceSma'], iv)} average; otherwise it holds euros.")
        else:
            steps.append(f"It holds half a position for each of the two signals that is positive: money flowing in, "
                         f"and the price above its {bars_text(p['priceSma'], iv)} average.")
    else:
        steps.append(f"It holds {mk} while money flows in and sits in euros otherwise.")
    return {
        "summary": f"Follows the volume flow of {mk}: it holds while the volume on rising days outweighs the volume "
                   "on falling days, and sits in euros otherwise.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Rallies that are carried by rising volume: the volume line often turns before the price does.",
        "whenItLoses": "Moves on thin volume and choppy markets, where the volume line flips back and forth and every "
                       "flip costs fees.",
    }
