"""xskew_a18 v1: hold the coins, step aside after a ONE-COIN MANIA in the old-alt pool (agent-18).

Signal: the cross-sectional skewness of the `lookback`-candle log returns of the 11 altcoins already listed on
Bitvavo in 2019 (ADA BCH ETC LINK LTC MIOTA NEO TRX XLM XRP XTZ; a traded coin is left out of its own pool).
High positive skew = one or two old coins pump far ahead of the rest (a lottery-style chase). This is the SHAPE of
the alt returns, not their level: its rank correlation with alt_froth's mean-alt-minus-BTC spread is only 0.1-0.3.
When today's skew ranks above `quantile` of its own trailing `rankLen` candles, the strategy sells everything and
waits `minOut` candles (counted from the latest trigger), then buys back.

Study (agent-18 w9, 1d pre-holdout 2019-25): within-year rank IC of the 30 d skew vs forward 5-60 d returns is
negative in 7/7 years on BTC and ETH (mean -0.10..-0.23), also net of 30 d momentum and the froth spread.
Decisions use pool candles aligned "as of" each bar (nothing after t).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "xskew_a18"
VERSION = 1
TITLE = "One-coin mania exit (alt-pool return skew)"
BOT_READY = False
MULTI_MARKET = True
POOL = ["ADA-EUR", "BCH-EUR", "ETC-EUR", "LINK-EUR", "LTC-EUR", "MIOTA-EUR", "NEO-EUR", "TRX-EUR", "XLM-EUR",
        "XRP-EUR", "XTZ-EUR"]
MIN_POOL = 5


def default_params() -> dict:
    return {"lookback": 30, "quantile": 0.9, "rankLen": 365, "minOut": 20}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 7, "max": 120, "log": True,
                     "description": "candles over which each old altcoin's return is measured"},
        "quantile": {"type": "float", "min": 0.6, "max": 0.99,
                     "description": "sell when today's skew ranks above this share of its trailing window"},
        "rankLen": {"type": "int", "min": 120, "max": 730, "log": True,
                    "description": "candles of skew history the rank is taken over"},
        "minOut": {"type": "int", "min": 1, "max": 120, "log": True,
                   "description": "candles to stay out after the latest trigger (1 = only on trigger candles)"},
    }


def warmup(p: dict) -> int:
    return int(p["lookback"]) + int(p["rankLen"]) // 2


def required_markets(spec: dict) -> list[str]:
    return list(POOL)


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def pool_skew(candles: dict, lookback: int, idx: np.ndarray, exclude=()) -> np.ndarray:
    """Bias-corrected cross-sectional skew of lookback log returns over the pool on idx (NaN if < MIN_POOL coins)."""
    cols = []
    for m in POOL:
        if m in exclude or m not in candles or len(candles[m]) <= lookback:
            continue
        c = np.log(candles[m]["close"].to_numpy(np.float64))
        r = np.full(len(c), np.nan)
        r[lookback:] = c[lookback:] - c[:-lookback]
        cols.append(_asof(candles[m], r, idx))
    if not cols:
        return np.full(len(idx), np.nan)
    R = np.column_stack(cols)
    sk = pd.DataFrame(R).skew(axis=1, skipna=True).to_numpy(np.float64).copy()   # adjusted Fisher-Pearson, like pandas
    k = np.isfinite(R).sum(axis=1)
    sk[k < MIN_POOL] = np.nan
    return sk


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    sk = pd.Series(pool_skew(candles, int(p["lookback"]), idx, exclude=set(markets)))
    L = int(p["rankLen"])
    rk = sk.rolling(L, min_periods=max(L // 2, 2)).rank(pct=True).to_numpy()
    q, k_out = float(p["quantile"]), max(int(p["minOut"]), 1)
    state = np.full(n, np.nan)
    last = -10 ** 9
    for i in range(n):
        if not np.isfinite(rk[i]):
            continue
        if rk[i] > q:
            last = i
        state[i] = 0.0 if i - last < k_out else 1.0
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        live = _asof(candles[m], np.ones(len(candles[m])), idx)   # NaN before the coin trades
        cols[m] = state * np.nan_to_num(live, nan=0.0) * each
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    return {
        "summary": f"Holds {mk}, but steps aside for a while after one or two old altcoins pump far ahead of the "
                   "rest (a lottery-style chase that tends to precede weaker weeks).",
        "howItWorks": [
            f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
            f"After every {iv} candle it takes the return over {bars_text(p['lookback'], iv)} of eleven altcoins "
            "that were already trading in 2019 and measures how lopsided they are: is one coin far ahead of the "
            "pack (high skew) or are they spread evenly?",
            f"When that lopsidedness is in the top {pct(1 - float(p['quantile']))} of the last "
            f"{bars_text(p['rankLen'], iv)}, it sells everything and waits in euros.",
            f"It buys back {bars_text(p['minOut'], iv)} after the latest such signal.",
        ] + risk_steps(spec),
        "whenItWins": "Speculative phases where money chases one hot old coin just before the market cools off.",
        "whenItLoses": "Bull runs that keep going while single coins pump; it then sits in euros and misses gains.",
    }
