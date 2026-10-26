"""session_share_a18 v1 (agent-18): who is trading? Hold BTC/ETH depending on WHEN in the day the EUR volume trades.

From hourly candles it measures the share of the last L days' EUR turnover (close x volume) that traded inside one
UTC session (sessStart for sessLen hours), and ranks that share against its own last rankLen days (a percentile, so
slow drifts in Bitvavo's user base don't matter). Unrecorded study (1d pre-holdout 2019-03..2025-10, fwd 30 d):
when the 12-20 UTC (US open + EU afternoon) share of ETH turnover sat in its top 20 % of the past year, ETH's next
month was 13 pts worse than otherwise (6/7 years); a high 18-02 UTC (late evening / Asia) share was bullish on ETH
(+9.7, 6/7) and BTC (+5.7, 6/7).

- side "out_high": hold, step out while the rank > thr (session-heavy trading is bearish).
- side "in_high": hold only while the rank > thr.
- combine: "none", or with a daily SMA(coreLen) core: "and" = both, "or" = either.
Decides once per UTC day at the close of the 23:00 candle (all of that day's hours known) and keeps the weight until
the next decision. Made for 1h candles.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "session_share_a18"
VERSION = 1
TITLE = "Session share of turnover (hourly)"
BOT_READY = False
MULTI_MARKET = False

HOUR = 3_600_000
DAY = 86_400_000


def default_params() -> dict:
    return {"sessStart": 12, "sessLen": 8, "shareLen": 30, "rankLen": 365, "side": "out_high", "thr": 0.8,
            "combine": "none", "coreLen": 100}


def param_space() -> dict:
    return {
        "sessStart": {"type": "int", "min": 0, "max": 23, "description": "first UTC hour of the session"},
        "sessLen": {"type": "int", "min": 2, "max": 16, "description": "hours in the session"},
        "shareLen": {"type": "int", "min": 5, "max": 120, "log": True,
                     "description": "days of turnover the session share is measured over"},
        "rankLen": {"type": "int", "min": 90, "max": 730, "log": True,
                    "description": "days of history the share is ranked against (percentile)"},
        "side": {"type": "choice", "values": ["out_high", "in_high"],
                 "description": "out_high = step out when the share ranks high; in_high = hold only then"},
        "thr": {"type": "float", "min": 0.05, "max": 0.95, "description": "percentile threshold"},
        "combine": {"type": "choice", "values": ["none", "and", "or"],
                    "description": "combine with a daily SMA core: none, and (both), or (either)"},
        "coreLen": {"type": "int", "min": 10, "max": 400, "log": True, "description": "SMA core length in days"},
    }


def warmup(p: dict) -> int:
    return 24 * (int(p["shareLen"]) + int(p["rankLen"]) // 2 + 1)


def daily_signal(df: pd.DataFrame, p: dict):
    """Per complete UTC day: (decision bar position, rank of the session share, day close). Day D is decided at its
    23:00 candle; only candles up to and including that one are used."""
    ts = df.index.to_numpy(np.int64)
    hour = (ts // HOUR) % 24
    day = ts // DAY
    eur = (df["close"] * df["volume"]).to_numpy(np.float64)
    s0, sl = int(p["sessStart"]), int(p["sessLen"])
    in_sess = ((hour - s0) % 24) < sl
    g = pd.DataFrame({"day": day, "eur": eur, "ses": np.where(in_sess, eur, 0.0)})
    agg = g.groupby("day").agg(eur=("eur", "sum"), ses=("ses", "sum"))
    last = pd.Series(np.arange(len(ts)), index=day).groupby(level=0).max()
    is23 = pd.Series(hour == 23, index=day).groupby(level=0).max()
    agg = agg[is23.reindex(agg.index).to_numpy()]
    pos = last.reindex(agg.index).to_numpy()
    n = int(p["shareLen"])
    share = agg["ses"].rolling(n, min_periods=n).sum() / agg["eur"].rolling(n, min_periods=n).sum()
    rl = int(p["rankLen"])
    rank = share.rolling(rl, min_periods=rl // 2).rank(pct=True).to_numpy(np.float64)
    close = df["close"].to_numpy(np.float64)[pos]
    return pos, rank, close


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    pos, rank, close = daily_signal(df, p)
    thr = float(p["thr"])
    sig = np.where(np.isfinite(rank), ((rank > thr) if p["side"] == "in_high" else (rank <= thr)).astype(float), np.nan)
    if p["combine"] != "none":
        k = int(p["coreLen"])
        sm = pd.Series(close).rolling(k, min_periods=k).mean().to_numpy()
        core = np.where(np.isfinite(sm), (close > sm).astype(float), np.nan)
        ok = np.isfinite(sig) & np.isfinite(core)
        sig = np.where(ok, np.minimum(sig, core) if p["combine"] == "and" else np.maximum(sig, core), np.nan)
    w = np.full(len(df), np.nan)
    w[pos] = sig
    w = pd.Series(w).ffill().to_numpy()
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p = spec["params"]
    mk = market_names(spec)
    s0, s1 = int(p["sessStart"]), (int(p["sessStart"]) + int(p["sessLen"])) % 24
    pct_ = round(100 * float(p["thr"]))
    rule = (f"It holds {mk}, but steps out while that share is higher than on {pct_} % of the past "
            f"{p['rankLen']} days." if p["side"] == "out_high" else
            f"It holds {mk} only while that share is higher than on {pct_} % of the past {p['rankLen']} days.")
    steps = [f"Every day at midnight UTC it measures which part of the last {p['shareLen']} days' euro turnover "
             f"traded between {s0:02d}:00 and {s1:02d}:00 UTC.", rule]
    if p["combine"] == "and":
        steps.append(f"It also needs the price above its {p['coreLen']}-day average.")
    elif p["combine"] == "or":
        steps.append(f"Above its {p['coreLen']}-day average it holds anyway.")
    return {
        "summary": f"Holds {mk} depending on what time of day the trading happens.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "When a shift in who trades (which time zone) comes before the price move.",
        "whenItLoses": "When the time-of-day mix shifts for reasons unrelated to price (holidays, new exchange users).",
    }
