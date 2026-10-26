"""flow_committee v1 (agent-06, ensemble lane): price momentum, volume flow and price level vote per market.

Voters (computed on each market's own candles, decisions at bar t use candles up to and including t):
- MACD (price momentum):  in while MACD(macdFast, macdSlow) line > its EMA(macdSignal) signal line.
- OBV (volume flow):      in while EMA(obvFast) of on-balance volume > EMA(obvSlow) of it.
- SMA (price level):      in while close > SMA(smaLen); smaLen = 0 switches this voter off (two voters left).

mode "avg":      weight = share * (voters in) / (active voters), i.e. it scales in and out in steps.
mode "majority": weight = share while more than half of the active voters are in (2 of 3, or 2 of 2).
mode "any":      weight = share while at least one voter is in (sells only when every voter is out).
Multi-market: share = maxWeight / number of markets; each market votes on its own; a market that is not listed yet
or still warming up keeps its slice in euros once any market is decided.

Why (eval v2): the two best v2 single-market specs are a price-momentum MACD (macd_smooth ETH 1d) and a volume-flow
cross (obv_trend ETH 1d), and they miss DIFFERENT folds (MACD lost -0.9 log to holding in the 2020-21 bull, OBV
held it; OBV lost the 2024 fold, MACD won it). Committees of three price trend rules (trend_committee) land between
their members because the voters are correlated; voters that read different information (price vs volume) should
diversify the fold misses, and averaging their positions lowers the drawdown term of the score.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps

NAME = "flow_committee"
VERSION = 1
TITLE = "Flow committee (MACD + volume flow + SMA vote)"
BOT_READY = False
MULTI_MARKET = True

MODES = ["avg", "majority", "any"]


def default_params() -> dict:
    return {"macdFast": 12, "macdSlow": 180, "macdSignal": 40, "obvFast": 5, "obvSlow": 70, "smaLen": 150,
            "mode": "avg"}


def param_space() -> dict:
    return {
        "macdFast": {"type": "int", "min": 2, "max": 60, "log": True, "description": "MACD voter: fast EMA length"},
        "macdSlow": {"type": "int", "min": 10, "max": 400, "log": True, "description": "MACD voter: slow EMA length"},
        "macdSignal": {"type": "int", "min": 2, "max": 80, "log": True, "description": "MACD voter: signal EMA"},
        "obvFast": {"type": "int", "min": 2, "max": 100, "log": True,
                    "description": "volume voter: fast EMA of on-balance volume"},
        "obvSlow": {"type": "int", "min": 5, "max": 400, "log": True,
                    "description": "volume voter: slow EMA of on-balance volume"},
        "smaLen": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                   "description": "level voter: in while the close is above this SMA (0 = voter off)"},
        "mode": {"type": "choice", "values": MODES,
                 "description": "avg = a share per voter that is in, majority = all in while most are in, "
                                "any = all in while at least one is in"},
    }


def valid_params(p: dict) -> str | None:
    if p["macdFast"] >= p["macdSlow"]:
        return "macdFast must be shorter than macdSlow"
    if p["obvFast"] >= p["obvSlow"]:
        return "obvFast must be shorter than obvSlow"
    return None


def warmup(p: dict) -> int:
    return max(int(p["macdSlow"]) + int(p["macdSignal"]) - 2, int(p["obvSlow"]) - 1, int(p.get("smaLen") or 0) - 1)


def obv(close: np.ndarray, volume: np.ndarray) -> np.ndarray:
    d = np.zeros_like(close)
    d[1:] = np.sign(close[1:] - close[:-1])
    v = np.nan_to_num(volume, nan=0.0)
    return np.cumsum(np.nan_to_num(d, nan=0.0) * v)


def votes(df: pd.DataFrame, p: dict) -> np.ndarray:
    """(n, k) array of 0/1 votes [macd, obv(, sma)]; rows before warmup(p) are NaN."""
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    line, sig, _ = ind.macd(c, int(p["macdFast"]), int(p["macdSlow"]), int(p["macdSignal"]))
    cols = [(line > sig).astype(np.float64)]
    o = obv(c, df["volume"].to_numpy(np.float64))
    cols.append((ind.ema(o, int(p["obvFast"])) > ind.ema(o, int(p["obvSlow"]))).astype(np.float64))
    k = int(p.get("smaLen") or 0)
    if k > 0:
        cols.append((c > ind.sma(c, k)).astype(np.float64))
    out = np.column_stack(cols)
    out[: min(warmup(p), n)] = np.nan
    return out


def combine(v: np.ndarray, mode: str) -> np.ndarray:
    k = v.sum(axis=1)
    m = v.shape[1]
    if mode == "avg":
        return k / m
    if mode == "majority":
        return np.where(np.isnan(k), np.nan, (k > m / 2).astype(np.float64))
    return np.where(np.isnan(k), np.nan, (k >= 1).astype(np.float64))


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("flow_committee needs at least one market")
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
    k = 3 if int(p.get("smaLen") or 0) > 0 else 2
    combo = {
        "avg": f"Each voter that says 'in' controls 1/{k} of the money for that coin, so it scales in and out in "
               "steps as the signals agree or disagree.",
        "majority": "It holds the coin fully while most of the voters say 'in' and sells when they don't.",
        "any": "It holds the coin fully while at least one voter says 'in' and only sells when all of them say 'out'.",
    }[p["mode"]]
    steps = [
        f"After every {iv} candle {k} different signals vote on {mk}.",
        f"Price momentum (MACD): 'in' while the MACD line ({p['macdFast']}/{p['macdSlow']} candles) is above its "
        f"{p['macdSignal']}-candle signal line.",
        f"Volume flow: the traded volume of rising candles is added up and that of falling candles subtracted "
        f"(on-balance volume); 'in' while its {bars_text(p['obvFast'], iv)} average is above its "
        f"{bars_text(p['obvSlow'], iv)} average, i.e. money keeps flowing in.",
    ]
    if k == 3:
        steps.append(f"Price level: 'in' while the price is above its {bars_text(p['smaLen'], iv)} average.")
    steps.append(combo)
    if n > 1:
        steps.append(f"Each of the {n} coins gets an equal {pct(1 / n)} slice of the money and votes on its own.")
    return {
        "summary": f"Price momentum, volume flow and the price level vote on {mk}; it holds more when more of them "
                   "see an uptrend.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends that are carried by volume: the signals agree, it is fully in for bull runs and "
                      "out for long bear markets.",
        "whenItLoses": "Choppy sideways markets where the signals flip back and forth, and sudden V-shaped reversals "
                       "that all of them notice late.",
    }
