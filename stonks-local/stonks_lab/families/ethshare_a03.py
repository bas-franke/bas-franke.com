"""ethshare_a03: hold BTC/ETH, step aside while ETH's share of BTC+ETH EUR turnover is unusually high (agent-03).

Signal: share_t = ETH-EUR EUR turnover / (BTC-EUR + ETH-EUR EUR turnover), each summed over the last turnLen
candles (turnover = close x volume on Bitvavo). rank_t = percentile of share_t among its last rankLen values
(trailing, includes t). Out once rank_t > exitQ; back in once rank_t < exitQ - band and at least minOut candles
have passed since the exit. Optional coreSma: a traded market is held only while its close is above that SMA too.

Why (unrecorded pre-holdout study, 1d 2019-03..2025-10, fwd 30 d log return minus the year's mean): with turnLen 7-60
and rankLen 90-365, days in the top 20 % of the ETH share were followed by ETH -3..-10 % (below the year mean in 5-7
of 5-7 years) and BTC -1..-5 %. It is not just the ETH/BTC price spike of eth_froth (#499): high share without a high
ETH/BTC lead still gave ETH -4.6 % (5/7 yrs negative), a high lead without high share only -0.9 %. Reading: when
euro traders crowd into ETH relative to BTC, speculation is running hot.

Every traded market gets maxWeight / len(markets) while held. Decisions at bar t use candles up to t only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "ethshare_a03"
VERSION = 1
TITLE = "ETH turnover-share exit"
BOT_READY = False
MULTI_MARKET = True

BTC, ETH = "BTC-EUR", "ETH-EUR"


def default_params() -> dict:
    return {"turnLen": 14, "rankLen": 180, "exitQ": 0.8, "band": 0.1, "minOut": 0, "coreSma": 0}


def param_space() -> dict:
    return {
        "turnLen": {"type": "int", "min": 3, "max": 90, "log": True,
                    "description": "candles of EUR turnover summed for the ETH share"},
        "rankLen": {"type": "int", "min": 60, "max": 730, "log": True,
                    "description": "trailing candles the share is ranked against"},
        "exitQ": {"type": "float", "min": 0.6, "max": 0.98,
                  "description": "step out once the share's trailing percentile is above this"},
        "band": {"type": "float", "min": 0.0, "max": 0.4,
                 "description": "back in once the percentile is below exitQ - band"},
        "minOut": {"type": "int", "min": 1, "max": 90, "zero": True, "log": True,
                   "description": "stay out at least this many candles after an exit (0 = no minimum)"},
        "coreSma": {"type": "int", "min": 20, "max": 400, "zero": True, "log": True,
                    "description": "also require the close above this SMA (0 = no trend core)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["exitQ"]) - float(p["band"]) <= 0.2:
        return "exitQ - band too low: it would hardly ever re-enter"
    return None


def warmup(p: dict) -> int:
    return max(int(p["turnLen"]) + int(p["rankLen"]) - 1, int(p.get("coreSma") or 0) - 1)


def required_markets(spec: dict) -> list[str]:
    return [BTC, ETH]


def share_rank(candles: dict, turn_len: int, rank_len: int, idx: np.ndarray) -> np.ndarray:
    """Trailing percentile of ETH's share of BTC+ETH EUR turnover, as of each idx time (NaN until defined)."""
    if any(m not in candles or len(candles[m]) == 0 for m in (BTC, ETH)):
        return np.full(len(idx), np.nan)
    b, e = candles[BTC], candles[ETH]
    common = np.intersect1d(np.asarray(b.index, dtype=np.int64), np.asarray(e.index, dtype=np.int64))
    tb = (b["close"] * b["volume"]).reindex(common).rolling(turn_len, min_periods=turn_len).sum()
    te = (e["close"] * e["volume"]).reindex(common).rolling(turn_len, min_periods=turn_len).sum()
    with np.errstate(divide="ignore", invalid="ignore"):
        share = te / (tb + te)
    rk = share.rolling(rank_len, min_periods=rank_len).rank(pct=True).to_numpy(np.float64)
    pos = np.searchsorted(common, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = rk[pos[ok]]
    return out


def _gate(rk: np.ndarray, p: dict) -> np.ndarray:
    q, band, min_out = float(p["exitQ"]), float(p["band"]), int(p.get("minOut") or 0)
    out = np.full(len(rk), np.nan)
    state, since = None, 0
    for i, v in enumerate(rk):
        if v != v:
            if state is not None:
                out[i] = state   # keep the last state over a data hole
            continue
        if state is None:
            state = 0.0 if v > q else 1.0
        elif state == 1.0:
            if v > q:
                state, since = 0.0, 0
        else:
            since += 1
            if v < q - band and since >= min_out:
                state = 1.0
        out[i] = state
    return out


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    gate = _gate(share_rank(candles, int(p["turnLen"]), int(p["rankLen"]), idx), p)
    core_n = int(p.get("coreSma") or 0)
    cols = []
    for m in markets:
        df = candles[m]
        if core_n > 0:
            c = df["close"].to_numpy(np.float64)
            s = ind.sma(c, core_n)
            core = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            core = _asof(df, np.ones(len(df)), idx)
        cols.append(gate * core * each)
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    q, band = float(p["exitQ"]), float(p["band"])
    core_n = int(p.get("coreSma") or 0)
    steps = [f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "")
             + (f" while the price is above its {bars_text(core_n, iv)} average" if core_n else "") + ".",
             f"Every day it measures how much of the euro trading in bitcoin and ether on Bitvavo went to ether over "
             f"the last {bars_text(p['turnLen'], iv)}, and compares that share with the last "
             f"{bars_text(p['rankLen'], iv)}.",
             f"When ether's share is higher than on {q * 100:.0f} % of those days (traders crowding into ether), it "
             f"sells and holds euros; it buys back once the share drops below the {(q - band) * 100:.0f} % level"
             + (f" and at least {bars_text(p['minOut'], iv)} have passed." if int(p.get('minOut') or 0) else ".")]
    return {
        "summary": f"Holds {mk} and steps aside while euro traders crowd into ether relative to bitcoin.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Speculative ether manias that end in a sell-off.",
        "whenItLoses": "Healthy ether-led bull runs: it sits in euros while prices keep rising.",
    }
