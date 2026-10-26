"""trend_committee v1 (agent-11, ensemble lane): three trend followers vote per market.

Voters (each exactly the rule of its v1 family, computed on the market's own candles):
- EMA cross:   in while EMA(emaFast) > EMA(emaSlow).
- MACD:        in while MACD(macdFast, macdSlow) > its signal EMA(macdSignal).
- Donchian:    in after a close above the prior dcEntry-bar high, out after a close below the prior dcExit-bar low.

mode "avg":      weight = share * (voters in) / 3 (a third of the coin's slice per voter).
mode "majority": weight = share while at least two voters are in, else 0.
Multi-market: each market gets share = maxWeight / number of markets. v2: a row is decided once any market has
finished its warm-up; a market that is not listed yet or still warming up keeps its slice in euros (weight 0), so a
top-10 basket can start before the youngest coin is listed (v1 waited for every market).

Why: single trend rules on ETH 1d are cliffs (macd_trend slow 165 -> -17, 195 -> +11); averaging three different
trend definitions should keep most of the edge with smoother parameter neighbourhoods.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps

NAME = "trend_committee"
VERSION = 2
TITLE = "Trend committee (EMA + MACD + Donchian vote)"
BOT_READY = False
MULTI_MARKET = True

MODES = ["avg", "majority"]


def default_params() -> dict:
    return {"emaFast": 20, "emaSlow": 150, "macdFast": 12, "macdSlow": 180, "macdSignal": 30,
            "dcEntry": 90, "dcExit": 15, "mode": "avg"}


def param_space() -> dict:
    return {
        "emaFast": {"type": "int", "min": 2, "max": 150, "log": True, "description": "EMA voter: fast EMA length"},
        "emaSlow": {"type": "int", "min": 10, "max": 500, "log": True, "description": "EMA voter: slow EMA length"},
        "macdFast": {"type": "int", "min": 2, "max": 60, "log": True, "description": "MACD voter: fast EMA length"},
        "macdSlow": {"type": "int", "min": 10, "max": 400, "log": True, "description": "MACD voter: slow EMA length"},
        "macdSignal": {"type": "int", "min": 2, "max": 60, "log": True, "description": "MACD voter: signal EMA"},
        "dcEntry": {"type": "int", "min": 5, "max": 300, "log": True,
                    "description": "Donchian voter: buy on a close above the high of this many prior candles"},
        "dcExit": {"type": "int", "min": 2, "max": 200, "log": True,
                   "description": "Donchian voter: sell on a close below the low of this many prior candles"},
        "mode": {"type": "choice", "values": MODES,
                 "description": "avg = a third per voter that is in, majority = all in while 2 of 3 are in"},
    }


def valid_params(p: dict) -> str | None:
    if p["emaFast"] >= p["emaSlow"]:
        return "emaFast must be shorter than emaSlow"
    if p["macdFast"] >= p["macdSlow"]:
        return "macdFast must be shorter than macdSlow"
    return None


def warmup(p: dict) -> int:
    return max(int(p["emaSlow"]) - 1, int(p["macdSlow"]) + int(p["macdSignal"]) - 2, int(p["dcEntry"]),
               int(p["dcExit"]))


def votes(df: pd.DataFrame, p: dict) -> np.ndarray:
    """(n, 3) array of 0/1 votes [ema, macd, donchian]; rows before warmup(p) are NaN."""
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    f, s = ind.ema(c, int(p["emaFast"])), ind.ema(c, int(p["emaSlow"]))
    v_ema = (f > s).astype(np.float64)
    line, sig, _ = ind.macd(c, int(p["macdFast"]), int(p["macdSlow"]), int(p["macdSignal"]))
    v_macd = (line > sig).astype(np.float64)
    hi = ind.prior_max(df["high"].to_numpy(np.float64), int(p["dcEntry"])).tolist()
    lo = ind.prior_min(df["low"].to_numpy(np.float64), int(p["dcExit"])).tolist()
    cl = c.tolist()
    first = warmup(p)
    v_dc = np.zeros(n)
    inside = False
    for i in range(first, n):
        if not inside:
            if cl[i] > hi[i]:
                inside = True
        elif cl[i] < lo[i]:
            inside = False
        v_dc[i] = 1.0 if inside else 0.0
    out = np.column_stack([v_ema, v_macd, v_dc])
    out[: min(first, n)] = np.nan
    return out


def combine(v: np.ndarray, mode: str) -> np.ndarray:
    k = v.sum(axis=1)
    return k / 3.0 if mode == "avg" else (k >= 2).astype(np.float64)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("trend_committee needs at least one market")
    share = max_weight(spec) / len(markets)
    series, index = {}, None
    for m in markets:
        df = candles[m]
        w = combine(votes(df, p), p["mode"]) * share
        idx = np.asarray(df.index, dtype=np.int64)
        series[m] = pd.Series(w, index=idx)
        index = idx if index is None else np.union1d(index, idx)
    cols = {m: s.reindex(index).ffill().to_numpy(np.float64) for m, s in series.items()}
    out = frame(index, cols)
    decided = out.notna().any(axis=1).to_numpy()
    out.iloc[decided, :] = out.iloc[decided, :].fillna(0.0)
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    n = len(spec.get("markets") or []) or 1
    combo = ("Each voter that says 'in' controls a third of the money for that coin, so it scales in and out in "
             "thirds as the trend strengthens or fades." if p["mode"] == "avg" else
             "It holds the coin fully while at least two of the three voters say 'in', and sells when only one "
             "or none does.")
    steps = [
        f"After every {iv} candle three different trend rules vote on {mk}.",
        f"Moving averages: 'in' while the {bars_text(p['emaFast'], iv)} average is above the "
        f"{bars_text(p['emaSlow'], iv)} average.",
        f"MACD: 'in' while the MACD line ({p['macdFast']}/{p['macdSlow']}) is above its {p['macdSignal']}-candle "
        "signal line, i.e. the trend is accelerating upwards.",
        f"Breakout: 'in' after the price closes above the highest high of the last {bars_text(p['dcEntry'], iv)}, "
        f"'out' after it closes below the lowest low of the last {bars_text(p['dcExit'], iv)}.",
        combo,
    ]
    if n > 1:
        steps.append(f"Each of the {n} coins gets an equal {pct(1 / n)} slice of the money and votes on its own.")
    return {
        "summary": f"Three trend-following rules vote on {mk}; it holds more when more of them see an uptrend.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bull runs (all three agree and it is fully in) and long bear markets (all three are out).",
        "whenItLoses": "Sideways chop and sharp V-shaped reversals: the votes lag, so it buys late and sells late.",
    }
