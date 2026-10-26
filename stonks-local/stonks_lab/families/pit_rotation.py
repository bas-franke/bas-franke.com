"""pit_rotation v2 (agent-17): momentum rotation over a point-in-time universe (no hindsight in the coin list).

`top10` is today's top 10, so every rotation run on it knows in advance which coins would survive and grow (SOL,
AVAX, DOGE, BNB). This family takes a wider pool of markets (e.g. today's top 10 plus the 2019/2020 leaders that
faded: LTC, BCH, XLM, DOT, UNI, LUNA) and at every rebalance only considers the ``universe`` coins with the largest
trailing EUR turnover on the exchange, a point-in-time stand-in for "the top-N coins at that moment".

- Closes and volumes are aligned to the union index (missing bar: previous close, volume 0; NaN before listing).
- Turnover of each market at bar t = mean of close*volume over the last ``volLook`` bars (its own listing must be at
  least ``volLook`` bars old). The ``universe`` largest are eligible.
- Return at t = close[t] / close[t-lookback] - 1. Eligible markets are ranked by it (desc, ties by name); with
  ``absMom`` only positive returns qualify. The best ``count`` get maxWeight/count each.
- Rebalance bars: the first warm bar, every bar that starts a new block of ``hold`` candles (block = ts //
  (candle length * hold)), and every bar where the regime gate turns back on. hold=1 rebalances every bar
  (= rotation_momentum on the point-in-time universe).
- ``regimeSma`` > 0: everything is cash while BTC-EUR closes at or below its SMA(regimeSma) (checked every bar).

- v2: with ``"universe": "top10_pit"`` on the spec, only coins that are point-in-time members at bar t
  (universe.pit_members: dated CoinMarketCap eligibility + trailing Bitvavo volume) are candidates, so a pick is
  never a coin the evaluator would zero to cash afterwards (v1 picked over the whole pool and lost those slots).

Everything at bar t uses candles up to and including t (no look-ahead).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from .. import universe as uni_mod
from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "pit_rotation"
VERSION = 2
TITLE = "Point-in-time momentum rotation"
BOT_READY = False
MULTI_MARKET = True
REGIME_MARKET = "BTC-EUR"


def default_params() -> dict:
    return {"lookback": 20, "hold": 1, "count": 3, "universe": 10, "volLook": 90, "regimeSma": 50, "absMom": True}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 2, "max": 400, "log": True,
                     "description": "candles over which each coin's return is measured for the ranking"},
        "hold": {"type": "int", "min": 1, "max": 100, "log": True,
                 "description": "candles between rebalances (1 = every candle)"},
        "count": {"type": "int", "min": 1, "max": 5, "description": "how many coins to hold"},
        "universe": {"type": "int", "min": 2, "max": 16,
                     "description": "only the N coins with the largest recent EUR turnover are considered"},
        "volLook": {"type": "int", "min": 7, "max": 400, "log": True,
                    "description": "candles over which the turnover (close x volume) is averaged"},
        "regimeSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                      "description": "only hold coins while BTC is above this SMA (0 = off)"},
        "absMom": {"type": "bool", "description": "only buy coins whose own return over the lookback is positive"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["count"]) < 1 or int(p["hold"]) < 1:
        return "count and hold must be at least 1"
    if int(p["universe"]) < int(p["count"]):
        return "universe must be at least count"
    return None


def warmup(p: dict) -> int:
    r = int(p.get("regimeSma") or 0)
    return max(int(p["lookback"]), int(p["volLook"]), r - 1 if r > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    return [REGIME_MARKET] if int((spec.get("params") or {}).get("regimeSma") or 0) > 0 else []


def _aligned_turnover(candles, market, idx):
    df = candles[market]
    s = pd.Series((df["close"] * df["volume"]).to_numpy(np.float64), index=np.asarray(df.index, dtype=np.int64))
    v = s.reindex(idx).to_numpy(np.float64)
    listed = np.isfinite(aligned_close(candles, market, idx))
    return np.where(listed, np.nan_to_num(v, nan=0.0), np.nan)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    lb, hold, count = int(p["lookback"]), int(p["hold"]), int(p["count"])
    uni, vlook = int(p["universe"]), int(p["volLook"])
    reg_n = int(p.get("regimeSma") or 0)
    absmom = bool(p.get("absMom"))
    idx = union_index(candles, markets)
    n, M = len(idx), len(markets)
    W = np.full((n, M), np.nan)
    if n == 0:
        return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})
    C = np.vstack([aligned_close(candles, m, idx) for m in markets])
    ret = np.full((M, n), np.nan)
    if n > lb:
        with np.errstate(invalid="ignore", divide="ignore"):
            ret[:, lb:] = C[:, lb:] / C[:, :-lb] - 1.0
    TV = np.full((M, n), np.nan)
    for j, m in enumerate(markets):
        # rolling mean that is NaN until the market has volLook listed bars
        TV[j] = pd.Series(_aligned_turnover(candles, m, idx)).rolling(vlook, min_periods=vlook).mean().to_numpy()
    member = None
    if spec.get("universe") == uni_mod.PIT_NAME:
        daily = {m: candles[m] for m in markets} if spec.get("interval") == "1d" else None
        member = uni_mod.pit_members(idx, markets, daily)
    warm = np.isfinite(ret).any(axis=0) & np.isfinite(TV).any(axis=0)
    gate = np.ones(n, dtype=bool)
    if reg_n > 0:
        if REGIME_MARKET in markets:
            bc = C[markets.index(REGIME_MARKET)]
        else:
            bc = aligned_close(candles, REGIME_MARKET, idx)
        S = ind.sma(bc, reg_n) if np.isfinite(bc).any() else np.full(n, np.nan)
        with np.errstate(invalid="ignore"):
            gate = np.isfinite(S) & (bc > S)
        warm &= np.isfinite(S)
    first = int(np.argmax(warm)) if warm.any() else n
    step = int(np.median(np.diff(idx))) if n > 1 else 1
    block = idx // max(1, step * hold)
    each = max_weight(spec) / count
    name_rank = np.argsort(np.argsort(np.array(markets)))
    held: list[int] = []
    for t in range(first, n):
        if not gate[t]:
            held = []
            W[t] = 0.0
            continue
        if t == first or block[t] != block[t - 1] or not gate[t - 1] or hold == 1:
            tv = TV[:, t]
            live = [j for j in range(M) if np.isfinite(tv[j]) and np.isfinite(ret[j, t])
                    and (member is None or member[t, j])]
            live.sort(key=lambda j: (-tv[j], name_rank[j]))
            cand = [j for j in live[:uni] if not absmom or ret[j, t] > 0]
            cand.sort(key=lambda j: (-ret[j, t], name_rank[j]))
            held = cand[:count]
        row = np.zeros(M)
        for j in held:
            row[j] = each
        W[t] = row
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    count, uni = int(p["count"]), int(p["universe"])
    steps = [
        f"From {market_names(spec)} it only looks at the {uni} coins with the largest euro trading volume over the "
        f"last {bars_text(p['volLook'], iv)}, so the coin list changes over time like a real top-{uni} would.",
        f"Every {bars_text(p['hold'], iv)} it ranks those by their return over the last "
        f"{bars_text(p['lookback'], iv)} and holds the best {count} with an equal share each"
        + (" (only coins that actually rose)." if p.get("absMom") else "."),
    ]
    if int(p.get("regimeSma") or 0) > 0:
        steps.append(f"Safety switch: everything is sold while bitcoin is below its {bars_text(p['regimeSma'], iv)} "
                     "average price.")
    return {
        "summary": "Rides the strongest of the coins that were big at the time, without knowing today's winners.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Alt seasons where a few large coins keep outrunning the rest for weeks.",
        "whenItLoses": "Sharp reversals and coins that collapse right after leading (LUNA 2022).",
    }
