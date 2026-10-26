"""altvol_froth_a20 v1 (agent-20): hold BTC/ETH, step aside while old altcoins are unusually VOLATILE next to BTC.

Signal study (agent-20, unrecorded, 1d 2019-03..2025-10, pre-holdout): the ratio of the 30-day volatility of an
equal-weight basket of the nine 2019-listed alts (alt_froth's pool, no hindsight) to BTC's own 30-day volatility,
ranked against its trailing 365 days, sorts the next 30 days: in its top 20 % BTC's forward return was below its
yearly average in 6/6 years (2020-25), ETH's too. The ratio is only loosely related to alt_froth's return spread
(rank correlation ~0.2), and most of its bite comes while alts are also ahead of BTC. Hence three modes:

- ``alone``: out while the vol-ratio state is hot;
- ``and``:   out while it is hot AND old alts lead BTC over ``frothLook`` candles by more than ``frothThr`` (a
             volatility-confirmed froth exit, cf. flow_froth's turnover confirmation);
- ``or``:    out while either is true (alt_froth plus a vol exit).

At bar t (candles up to t only): alt_r = mean over the pool's coins (>= 3 with data) of their candle log return,
ratio = std(alt_r, volLen) / std(btc_r, volLen), rank = share of the last ``rankLen`` ratios below the current one (ties count half).
Hot switches on at rank >= qOut and off once rank < qIn (qIn <= qOut). Every market gets maxWeight / len(markets)
while in. Other markets are aligned "as of" the bar time.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .alt_froth import MIN_POOL, OLD_ALTS, _asof, froth as froth_spread

NAME = "altvol_froth_a20"
VERSION = 1
TITLE = "Altcoin volatility froth exit"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"volLen": 30, "rankLen": 365, "qOut": 0.8, "qIn": 0.6, "mode": "alone", "frothLook": 120,
            "frothThr": 0.1}


def param_space() -> dict:
    return {
        "volLen": {"type": "int", "min": 7, "max": 120, "log": True,
                   "description": "candles over which alt and BTC volatility are measured"},
        "rankLen": {"type": "int", "min": 90, "max": 1000, "log": True,
                    "description": "trailing window the volatility ratio is ranked against"},
        "qOut": {"type": "float", "min": 0.5, "max": 0.99,
                 "description": "rank at or above which the alts count as hot (sell)"},
        "qIn": {"type": "float", "min": 0.2, "max": 0.99,
                "description": "rank below which the hot state ends (buy back)"},
        "mode": {"type": "choice", "values": ["alone", "and", "or"],
                 "description": "vol exit alone, only together with an alt-lead (froth), or either"},
        "frothLook": {"type": "int", "min": 20, "max": 400, "log": True,
                      "description": "candles for the alt-vs-BTC return lead (modes and/or)"},
        "frothThr": {"type": "float", "min": 0.0, "max": 0.5,
                     "description": "log-return lead of the old alts over BTC that counts as froth"},
    }


def valid_params(p: dict) -> str | None:
    if p["qIn"] > p["qOut"]:
        return "qIn must be <= qOut"
    return None


def warmup(p: dict) -> int:
    w = int(p["volLen"]) + int(p["rankLen"])
    return max(w, int(p["frothLook"])) if p["mode"] != "alone" else w


def required_markets(spec: dict) -> list[str]:
    return ["BTC-EUR", *OLD_ALTS]


def _bar_logret(df: pd.DataFrame, idx: np.ndarray) -> np.ndarray:
    """Log return from the previous index bar's close to this one's (closes aligned as of each bar)."""
    c = _asof(df, df["close"].to_numpy(np.float64), idx)
    out = np.full(len(idx), np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        out[1:] = np.log(c[1:] / c[:-1])
    return out


def vol_ratio_rank(candles: dict, idx: np.ndarray, vol_len: int, rank_len: int) -> np.ndarray:
    n = len(idx)
    tot, cnt = np.zeros(n), np.zeros(n)
    for m in OLD_ALTS:
        if m not in candles or len(candles[m]) == 0:
            continue
        r = _bar_logret(candles[m], idx)
        tot += np.nan_to_num(r, nan=0.0)
        cnt += np.isfinite(r)
    alt = np.divide(tot, cnt, out=np.full(n, np.nan), where=cnt >= MIN_POOL)
    btc = _bar_logret(candles["BTC-EUR"], idx)
    sa = pd.Series(alt).rolling(vol_len, min_periods=vol_len).std(ddof=0)
    sb = pd.Series(btc).rolling(vol_len, min_periods=vol_len).std(ddof=0)
    ratio = np.round((sa / sb).replace([np.inf, -np.inf], np.nan).to_numpy(np.float64), 9)
    rank = np.full(n, np.nan)
    if n >= rank_len:
        win = np.lib.stride_tricks.sliding_window_view(ratio, rank_len)      # row j = ratio[j .. j+rank_len-1]
        last = win[:, -1:]
        r = ((win < last).sum(axis=1) + 0.5 * (win == last).sum(axis=1)) / rank_len   # mid-rank: ties count half
        r[~np.isfinite(win).all(axis=1)] = np.nan
        rank[rank_len - 1:] = r
    return rank


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    rk = vol_ratio_rank(candles, idx, int(p["volLen"]), int(p["rankLen"]))
    q_out, q_in, mode = float(p["qOut"]), float(p["qIn"]), p["mode"]
    fr = froth_spread(candles, int(p["frothLook"]), idx) if mode != "alone" else np.zeros(n)
    thr = float(p["frothThr"])
    state = np.full(n, np.nan)
    hot = False
    for i in range(n):
        r, f = rk[i], fr[i]
        if not (np.isfinite(r) and np.isfinite(f)):
            continue
        if hot and r < q_in:
            hot = False
        elif not hot and r >= q_out:
            hot = True
        frothy = f > thr
        out = hot if mode == "alone" else (hot and frothy) if mode == "and" else (hot or frothy)
        state[i] = 0.0 if out else 1.0
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        listed = _asof(candles[m], np.ones(len(candles[m])), idx)
        cols[m] = state * listed * each
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
    steps = [
        f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
        f"After every candle it measures how wildly nine altcoins that were already on Bitvavo in 2019 swing over "
        f"{bars_text(p['volLen'], iv)}, compared with Bitcoin's own swings, and ranks that ratio against the last "
        f"{bars_text(p['rankLen'], iv)}.",
        f"When the ratio ranks in the top {pct(1 - float(p['qOut']))} the alts count as 'hot'; they stay hot until "
        f"the rank falls below {pct(float(p['qIn']))}.",
    ]
    if p["mode"] == "alone":
        steps.append("While the alts are hot it sells and waits in euros.")
    else:
        lead = (f"the old altcoins are ahead of Bitcoin by more than {pct(np.expm1(float(p['frothThr'])))} over "
                f"{bars_text(p['frothLook'], iv)}")
        steps.append(f"It sells while the alts are hot {'and' if p['mode'] == 'and' else 'or'} {lead}.")
    return {
        "summary": f"Holds {mk}, but steps aside while old altcoins swing far harder than Bitcoin (a sign of "
                   "speculative froth).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Alt-season blow-offs: when small coins go wild next to Bitcoin, the whole market tends to cool "
                      "off over the next month.",
        "whenItLoses": "Healthy broad rallies where alts are simply more volatile: it sits in euros and misses gains.",
    }
