"""trend_dip_vote v1 (agent-11, ensemble lane): two voters per market, combined into one target weight.

- Trend voter: in while EMA(fast) > EMA(slow) at the bar close (the ema_cross rule).
- Dip voter: the rsi_dip state machine without a trend filter: in after RSI(period) < buyBelow, out after
  RSI > sellAbove.
- mode "or":  full weight while either voter is in (trend rides rallies, dip buys pullbacks in chop/declines).
  mode "avg": half weight per voter that is in (a 50/50 blend of the two strategies, fewer all-in flips).
  mode "and": in only while both are in (dips bought inside an uptrend, held until the bounce or the trend ends).

Multi-market: each market gets an equal share (maxWeight / number of markets) and votes independently.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps

NAME = "trend_dip_vote"
VERSION = 1
TITLE = "Trend + dip vote"
BOT_READY = False
MULTI_MARKET = True

MODES = ["or", "avg", "and"]


def default_params() -> dict:
    return {"fast": 20, "slow": 100, "period": 14, "buyBelow": 30, "sellAbove": 65, "mode": "or"}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 2, "max": 150, "log": True, "description": "trend voter: fast EMA length"},
        "slow": {"type": "int", "min": 5, "max": 500, "log": True, "description": "trend voter: slow EMA length"},
        "period": {"type": "int", "min": 2, "max": 50, "description": "dip voter: RSI length in candles"},
        "buyBelow": {"type": "float", "min": 5, "max": 50, "description": "dip voter: buy when the RSI drops under this"},
        "sellAbove": {"type": "float", "min": 40, "max": 95,
                      "description": "dip voter: sell when the RSI rises over this"},
        "mode": {"type": "choice", "values": MODES,
                 "description": "or = either voter, avg = half per voter, and = both voters"},
    }


def valid_params(p: dict) -> str | None:
    if p["fast"] >= p["slow"]:
        return "fast must be shorter than slow"
    if p["buyBelow"] >= p["sellAbove"]:
        return "buyBelow must be below sellAbove"
    return None


def warmup(p: dict) -> int:
    return max(int(p["slow"]) - 1, int(p["period"]))


def _dip_state(c: np.ndarray, p: dict, first: int) -> np.ndarray:
    r = ind.rsi(c, int(p["period"])).tolist()
    bb, sa = float(p["buyBelow"]), float(p["sellAbove"])
    out = np.zeros(len(c))
    inside = False
    for i in range(first, len(c)):
        if not inside:
            if r[i] < bb:
                inside = True
        elif r[i] > sa:
            inside = False
        out[i] = 1.0 if inside else 0.0
    return out


def votes(c: np.ndarray, p: dict) -> tuple[np.ndarray, np.ndarray, int]:
    """(trend 0/1, dip 0/1, first decision bar) for one close series."""
    first = warmup(p)
    f, s = ind.ema(c, int(p["fast"])), ind.ema(c, int(p["slow"]))
    t = np.where(np.isfinite(f) & np.isfinite(s) & (f > s), 1.0, 0.0)
    return t, _dip_state(c, p, first), first


def combine(t: np.ndarray, d: np.ndarray, mode: str) -> np.ndarray:
    if mode == "or":
        return np.maximum(t, d)
    if mode == "and":
        return np.minimum(t, d)
    return 0.5 * (t + d)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("trend_dip_vote needs at least one market")
    share = max_weight(spec) / len(markets)
    series, index = {}, None
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        t, d, first = votes(c, p)
        w = combine(t, d, p["mode"]) * share
        w[: min(first, len(w))] = np.nan
        idx = np.asarray(df.index, dtype=np.int64)
        series[m] = pd.Series(w, index=idx)
        index = idx if index is None else np.union1d(index, idx)
    # a market without a candle at some timestamp keeps its previous target
    cols = {m: s.reindex(index).ffill().to_numpy(np.float64) for m, s in series.items()}
    out = frame(index, cols)
    # a row counts only once every market has decided, so the equal split is never lopsided
    undecided = out.isna().any(axis=1).to_numpy()
    out.iloc[undecided, :] = np.nan
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    n = len(spec.get("markets") or []) or 1
    mode = p["mode"]
    combo = {
        "or": "It holds the coin whenever at least one of the two voters says 'in'.",
        "avg": "Each voter controls half of the money for that coin: both in = fully invested, one in = half, "
               "none = all euros.",
        "and": "It only holds the coin while both voters say 'in': dips are bought only inside an uptrend.",
    }[mode]
    steps = [
        f"After every {iv} candle two simple strategies vote on {mk}.",
        f"Trend voter: 'in' while the {bars_text(p['fast'], iv)} average price is above the "
        f"{bars_text(p['slow'], iv)} average.",
        f"Dip voter: 'in' after the RSI over {bars_text(p['period'], iv)} drops under {p['buyBelow']:g} (a sharp "
        f"drop), 'out' again once it climbs over {p['sellAbove']:g} (the bounce).",
        combo,
    ]
    if n > 1:
        steps.append(f"Each of the {n} coins gets an equal {pct(1 / n)} slice of the money and votes on its own.")
    return {
        "summary": f"Combines trend following with dip buying on {mk}: two voters decide together how much to hold.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Markets that alternate between rallies (the trend voter rides them) and sharp pullbacks that "
                      "bounce (the dip voter buys them).",
        "whenItLoses": "Long grinding declines with no bounce, and choppy markets where both voters flip often and "
                       "fees add up.",
    }
