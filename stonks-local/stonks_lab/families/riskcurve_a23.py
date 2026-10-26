"""riskcurve_a23 v1 (agent-23): hold BTC/ETH, step aside when speculation reaches the far end of the risk curve.

Idea: in crypto bull cycles money moves down the risk curve, BTC -> ETH -> the large altcoins -> the small ones. The
late, fragile stage is when the SMALLEST old altcoins outrun the LARGEST. Unlike alt_froth (old alts vs BTC) this
compares altcoins with each other, so it reads where on the risk curve speculation sits, not how far alts lead BTC.

Signal ("depth"): every candle the pool of 11 altcoins already listed on Bitvavo in 2019 (a single traded pool coin is left out) is
ranked by trailing `turnLen`-candle mean EUR turnover (close x volume, past candles only). Depth = mean `lookback`
log return of the `k` smallest minus the `k` largest. Its percentile among its own last `rankLen` values (this candle
included) decides: out of every traded market while the percentile >= `exitQ`, back in once it falls below
`exitQ - band` (mid-rank percentile, so a flat signal sits at 0.5). Otherwise it holds every traded market with an equal slice of maxWeight.

Everything at bar t uses candles up to t only (other markets aligned "as of" t).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "riskcurve_a23"
VERSION = 1
TITLE = "Risk-curve depth exit"
BOT_READY = False
MULTI_MARKET = True
POOL = ["XRP-EUR", "ADA-EUR", "LINK-EUR", "TRX-EUR", "LTC-EUR", "BCH-EUR", "XLM-EUR", "XTZ-EUR", "MIOTA-EUR",
        "ETC-EUR", "NEO-EUR"]


def default_params() -> dict:
    return {"lookback": 90, "k": 3, "exitQ": 0.85, "band": 0.15, "rankLen": 365, "turnLen": 90}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 10, "max": 400, "log": True,
                     "description": "candles over which small and large old altcoins' returns are compared"},
        "k": {"type": "int", "min": 2, "max": 4, "description": "coins in the small and in the large tier"},
        "exitQ": {"type": "float", "min": 0.5, "max": 0.99,
                  "description": "sell when the small-minus-large lead ranks at or above this trailing percentile"},
        "band": {"type": "float", "min": 0.0, "max": 0.4,
                 "description": "buy back once the percentile is under exitQ minus this"},
        "rankLen": {"type": "int", "min": 90, "max": 1000, "log": True,
                    "description": "candles of the signal's own history it is ranked against"},
        "turnLen": {"type": "int", "min": 20, "max": 365, "log": True,
                    "description": "candles of EUR turnover used to rank coins by size"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["exitQ"]) - float(p["band"]) <= 0:
        return "exitQ - band must be > 0"
    return None


def warmup(p: dict) -> int:
    return int(p["lookback"]) + int(p["turnLen"]) // 2 + _min_rank(int(p["rankLen"]))


def _min_rank(rank_len: int) -> int:
    return max(60, rank_len // 2)


def required_markets(spec: dict) -> list[str]:
    return ["BTC-EUR", *POOL]


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def depth(candles: dict, idx: np.ndarray, lookback: int, k: int, turn_len: int,
          exclude: tuple = ()) -> np.ndarray:
    """Small-tier minus large-tier mean lookback log return of the old-alt pool on idx (NaN while < 2k coins)."""
    pool = [m for m in POOL if m not in exclude and m in candles and len(candles[m])]
    n = len(idx)
    if len(pool) < 2 * k:
        return np.full(n, np.nan)
    R = np.full((n, len(pool)), np.nan)
    S = np.full((n, len(pool)), np.nan)
    for j, m in enumerate(pool):
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        lc = np.log(c)
        r = np.full(len(c), np.nan)
        if len(c) > lookback:
            r[lookback:] = lc[lookback:] - lc[:-lookback]
        eur = pd.Series(c * df["volume"].to_numpy(np.float64))
        size = eur.rolling(turn_len, min_periods=max(5, turn_len // 2)).mean().to_numpy()
        R[:, j] = _asof(df, r, idx)
        S[:, j] = _asof(df, size, idx)
    out = np.full(n, np.nan)
    ok = np.isfinite(R) & np.isfinite(S)
    for i in range(n):
        cols = np.flatnonzero(ok[i])
        if len(cols) < 2 * k:
            continue
        order = cols[np.argsort(-S[i, cols], kind="stable")]     # largest turnover first
        out[i] = R[i, order[-k:]].mean() - R[i, order[:k]].mean()
    return out


def trailing_pct(x: np.ndarray, rank_len: int) -> np.ndarray:
    """Mid-rank percentile of this value among the last rank_len finite values (incl. itself): share below plus half
    the share equal (a flat signal sits at 0.5, not at the top). NaN until enough history."""
    n = len(x)
    out = np.full(n, np.nan)
    need = _min_rank(rank_len)
    fin = np.isfinite(x)
    for i in range(n):
        if not fin[i]:
            continue
        w = x[max(0, i - rank_len + 1): i + 1]
        w = w[np.isfinite(w)]
        if len(w) < need:
            continue
        out[i] = float(np.mean(w < x[i]) + 0.5 * np.mean(w == x[i]))
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    # a single traded pool coin (the alt transfer test) is left out of its own signal
    excl = tuple(markets) if len(markets) == 1 else ()
    d = depth(candles, idx, int(p["lookback"]), int(p["k"]), int(p["turnLen"]), exclude=excl)
    q = trailing_pct(d, int(p["rankLen"]))
    hi, lo = float(p["exitQ"]), float(p["exitQ"]) - float(p["band"])
    each = max_weight(spec) / len(markets)
    state = np.full(n, np.nan)
    out_ = False
    for i, v in enumerate(q.tolist()):
        if not np.isfinite(v):
            continue
        if out_:
            if v < lo:
                out_ = False
        elif v >= hi:
            out_ = True
        state[i] = 0.0 if out_ else 1.0
    cols = {}
    for m in markets:
        listed = _asof(candles[m], np.ones(len(candles[m])), idx)
        cols[m] = state * listed * each
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(state)
    first = int(np.argmax(good)) if good.any() else n         # unlisted markets count as 0 after that
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    steps = [
        f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
        f"After every {iv} candle it ranks eleven altcoins that already traded in 2019 by their euro trading volume "
        f"over {bars_text(p['turnLen'], iv)} and compares the return over {bars_text(p['lookback'], iv)} of the "
        f"{int(p['k'])} smallest with the {int(p['k'])} largest.",
        f"When the small coins' lead is in the top {100 * (1 - float(p['exitQ'])):.0f} % of the last "
        f"{bars_text(p['rankLen'], iv)}, speculation has reached the far end of the risk curve: it sells and waits "
        "in euros.",
        f"It buys back once that lead is no longer in the top {100 * (1 - float(p['exitQ']) + float(p['band'])):.0f} %.",
    ]
    return {
        "summary": f"Holds {mk}, but sells while the smallest old altcoins outrun the largest (late-cycle "
                   "speculation).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Late bull phases where money chases ever smaller coins just before a crash.",
        "whenItLoses": "Small-coin rallies that happen in healthy markets or at bottoms; it then sits in euros while "
                       "Bitcoin keeps rising.",
    }
