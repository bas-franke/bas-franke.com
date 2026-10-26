"""turnover_panic v1 (agent-04): an SMA trend core plus a time-boxed panic buy, where "panic" is a spike in EUR
turnover on a falling price (a capitulation flush), measured on BTC-EUR / ETH-EUR only.

breadth_dip's BTC edge needs both legs (findings #212/#213): an SMA core that rides uptrends and a panic buy, held
for weeks, that catches the V-recoveries the SMA re-enters late. Its panic signal is RSI breadth over today's top-10
list (hindsight); RSI panics from BTC/ETH alone hinge on 3-5 days (#254). Capitulations also show up as volume:
sellers dump at any price and the day's turnover is a multiple of normal. This family asks whether that signal,
which needs no coin list, carries the rebound leg.

Per coin, at the bar close:
- turnover_t = volume_t * close_t (EUR);
- usual_t = median turnover of the volLook candles before t (t itself excluded);
- the coin flushes on bar t when turnover_t >= volMult * usual_t AND ln(close_t / close_{t-dropLook}) <= -dropMin
  (and < 0): heavy selling into a falling price.
- source "own": the traded coin's own flush; "both": BTC-EUR and ETH-EUR flush on the same bar; "any": either.

On a flush bar a market that is not in a panic trade buys and holds it for holdBars candles (extend=true: a new
flush inside the trade restarts the clock). Independently the market is held while its close is above
SMA(coreSma) (0 = no core). Every market gets maxWeight / len(markets) while held. Other markets are aligned as of
the bar time (latest candle at or before it): a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "turnover_panic"
VERSION = 1
TITLE = "Trend core + volume-flush buy"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]


def default_params() -> dict:
    return {"coreSma": 130, "source": "own", "volLook": 90, "volMult": 2.5, "dropLook": 7, "dropMin": 0.12,
            "holdBars": 90, "extend": False}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "hold while the close is above this SMA (0 = no trend core)"},
        "source": {"type": "choice", "values": ["own", "both", "any"],
                   "description": "whose flush counts: the traded coin's own, BTC and ETH on the same candle, or either"},
        "volLook": {"type": "int", "min": 10, "max": 400, "log": True,
                    "description": "candles before the current one whose median EUR turnover counts as usual"},
        "volMult": {"type": "float", "min": 1.3, "max": 8.0, "log": True,
                    "description": "a flush needs at least this multiple of the usual turnover"},
        "dropLook": {"type": "int", "min": 1, "max": 60, "log": True,
                     "description": "candles over which the price must have fallen"},
        "dropMin": {"type": "float", "min": 0.02, "max": 0.4, "zero": True, "log": True,
                    "description": "the price must be at least this log return lower than dropLook candles ago (0 = any fall)"},
        "holdBars": {"type": "int", "min": 2, "max": 500, "log": True,
                     "description": "candles a flush buy is held"},
        "extend": {"type": "bool", "description": "a new flush inside a panic trade restarts its clock"},
    }


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    return max(int(p["volLook"]), int(p["dropLook"]), c - 1 if c > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    extra = [] if spec["params"].get("source", "own") == "own" else PAIR
    return list(dict.fromkeys(list(spec["markets"]) + extra))


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def flush(df: pd.DataFrame, p: dict) -> np.ndarray:
    """1.0 / 0.0 per candle of df, NaN while undefined."""
    c = df["close"].to_numpy(np.float64)
    turn = pd.Series(df["volume"].to_numpy(np.float64) * c)
    look = int(p["volLook"])
    usual = turn.rolling(look, min_periods=look).median().shift(1).to_numpy()
    dl = int(p["dropLook"])
    lc = np.log(c)
    ret = np.full(len(c), np.nan)
    if len(c) > dl:
        ret[dl:] = lc[dl:] - lc[:-dl]
    t = turn.to_numpy()
    ok = np.isfinite(usual) & np.isfinite(ret) & (usual > 0)
    drop = float(p.get("dropMin") or 0.0)
    hit = ok & (t >= float(p["volMult"]) * np.where(ok, usual, 0.0)) & (ret <= -drop) & (ret < 0)
    return np.where(ok, hit.astype(np.float64), np.nan)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    source = p.get("source", "own")
    shared = None
    if source != "own":
        a, b = [_asof(candles[m], flush(candles[m], p), idx) for m in PAIR]
        ok = np.isfinite(a) & np.isfinite(b)
        val = np.maximum(a, b) if source == "any" else np.minimum(a, b)
        shared = np.where(ok, val, np.nan)
    core_n, hold_n, extend = int(p.get("coreSma") or 0), int(p["holdBars"]), bool(p.get("extend"))
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        sig = shared if shared is not None else _asof(df, flush(df, p), idx)
        if core_n:
            s = ind.sma(c, core_n)
            core = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            core = np.zeros(n)
        w = np.full(n, np.nan)
        ok = (np.isfinite(sig) & np.isfinite(core)).tolist()
        sigl, corel = sig.tolist(), core.tolist()
        inside, held = False, 0
        for i in range(n):
            if not ok[i]:
                continue
            if not inside:
                if sigl[i] == 1.0:
                    inside, held = True, 0
            else:
                held += 1
                if extend and sigl[i] == 1.0:
                    held = 0
                if held >= hold_n:
                    inside = False
            w[i] = each if (inside or corel[i] == 1.0) else 0.0
        cols[m] = w
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
    who = {"own": "the coin itself", "both": "both BTC and ETH on the same candle", "any": "BTC or ETH"}[
        p.get("source", "own")]
    drop = float(p.get("dropMin") or 0.0)
    fall = (f"the price is at least {pct(drop)} lower than {bars_text(p['dropLook'], iv)} ago" if drop
            else f"the price is lower than {bars_text(p['dropLook'], iv)} ago")
    steps = []
    if int(p.get("coreSma") or 0):
        steps.append(f"Trend core: it holds {mk} whenever the price is above its {bars_text(p['coreSma'], iv)} "
                     "average, so it rides uptrends.")
    steps.append(f"Flush buy: when {who} trades at least {float(p['volMult']):.1f} times its usual euro volume "
                 f"(the median of the previous {bars_text(p['volLook'], iv)}) while {fall}, sellers are dumping at "
                 f"any price; it buys {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "")
                 + f" and keeps it for {bars_text(p['holdBars'], iv)}"
                 + (", starting the clock again on every new flush." if p.get("extend") else
                    ", even if the price is still below its average."))
    steps.append("Otherwise it holds euros.")
    return {
        "summary": f"Rides {mk} uptrends and buys the high-volume sell-offs that often mark the bottom of a crash.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets and sharp V-shaped recoveries after capitulation days, which a plain trend "
                      "filter re-enters late.",
        "whenItLoses": "Bear markets with several flushes in a row (2022): each flush buy can lose until its time "
                       "limit ends it.",
    }
