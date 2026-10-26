"""core_rebound v2: SMA trend core plus a time-boxed rebound buy after a capitulation (agent-19).

The ablation of breadth_dip (findings #212/#213) showed that its BTC 1d edge needs both legs: an SMA trend core
that rides uptrends and a panic buy, held for weeks, that catches the V-shaped recoveries the SMA re-enters late.
breadth_dip measures the panic over today's top-10 list (hindsight in the coin list). This family asks whether the
same structure works with a panic signal that needs no coin list:

- source "own":  the traded coin's own signal;
- source "both": BTC-EUR and ETH-EUR must both signal (a two-coin market-wide panic);
- source "any":  either BTC-EUR or ETH-EUR signals.
- source "top10": at least breadthMin of today's top-10 list signal (breadth_dip's list: hindsight, the control);
- source "pit10": at least breadthMin of the point-in-time top 10 signal: the 10 coins of the universe.PIT_POOL
  with the largest trailing 90-day Bitvavo EUR volume, decided from the days before (no hindsight in the list).
(v2 added top10/pit10 and breadthMin; v1 results are own/both/any only.)

Signal (per coin, at the bar close):
- "rsi":      RSI(rsiPeriod) < rsiBelow;
- "drawdown": close at least ddMin below the highest close of the last ddLook candles (the current one included).

On a signal bar a market that is not in a rebound trade buys; the trade ends after holdBars candles or once the
coin's own RSI(rsiPeriod) closes above sellAbove (100 = never). Independently the market is held while its close
is above SMA(coreSma) (0 = no core). Every market gets maxWeight / len(markets) while held. Other markets are
aligned as of the bar time (latest candle at or before it): a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from .. import universe as uni
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "core_rebound"
VERSION = 2
TITLE = "Trend core + rebound buy"
BOT_READY = False
MULTI_MARKET = True
SIGNAL_MARKETS = ["BTC-EUR", "ETH-EUR"]
TOP10_MARKETS = ["BTC-EUR", "ETH-EUR", "XRP-EUR", "BNB-EUR", "SOL-EUR", "DOGE-EUR", "ADA-EUR", "TRX-EUR",
                 "LINK-EUR", "AVAX-EUR"]
MIN_BREADTH_COINS = 3


def default_params() -> dict:
    return {"coreSma": 130, "signal": "rsi", "source": "own", "rsiPeriod": 12, "rsiBelow": 35,
            "ddLook": 60, "ddMin": 0.3, "holdBars": 90, "sellAbove": 100.0, "breadthMin": 0.8}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "hold while the close is above this SMA (0 = no trend core)"},
        "signal": {"type": "choice", "values": ["rsi", "drawdown"],
                   "description": "capitulation signal: RSI under rsiBelow, or close ddMin under its ddLook high"},
        "source": {"type": "choice", "values": ["own", "both", "any", "top10", "pit10"],
                   "description": "whose signal counts: the traded coin's own, BTC and ETH both, either, or a "
                                  "breadthMin share of today's top 10 (top10) or of the point-in-time top 10 (pit10)"},
        "breadthMin": {"type": "float", "min": 0.2, "max": 1.0,
                       "description": "top10/pit10: share of the coins that must signal at once"},
        "rsiPeriod": {"type": "int", "min": 2, "max": 50, "description": "RSI length in candles"},
        "rsiBelow": {"type": "float", "min": 10, "max": 45, "description": "RSI capitulation level"},
        "ddLook": {"type": "int", "min": 5, "max": 400, "log": True,
                   "description": "candles in the recent high the drawdown is measured from"},
        "ddMin": {"type": "float", "min": 0.05, "max": 0.6, "description": "drawdown that counts as capitulation"},
        "holdBars": {"type": "int", "min": 2, "max": 500, "log": True,
                     "description": "candles a rebound buy is held at most"},
        "sellAbove": {"type": "float", "min": 50, "max": 100,
                      "description": "end the rebound trade early when the coin's RSI closes above this (100 = never)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["rsiBelow"]) >= float(p["sellAbove"]):
        return "rsiBelow must be below sellAbove"
    return None


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    s = int(p["rsiPeriod"]) if p.get("signal", "rsi") == "rsi" else int(p["ddLook"]) - 1
    return max(int(p["rsiPeriod"]), s, c - 1 if c > 0 else 0)


def _pool(source: str) -> list[str]:
    return {"own": [], "both": SIGNAL_MARKETS, "any": SIGNAL_MARKETS, "top10": TOP10_MARKETS,
            "pit10": uni.pit_pool()}[source]


def required_markets(spec: dict) -> list[str]:
    extra = _pool(spec["params"].get("source", "own"))
    return list(dict.fromkeys(list(spec["markets"]) + extra))


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _signal(df: pd.DataFrame, p: dict) -> np.ndarray:
    """1.0 / 0.0 per candle of df, NaN while undefined."""
    c = df["close"].to_numpy(np.float64)
    if p.get("signal", "rsi") == "rsi":
        r = ind.rsi(c, int(p["rsiPeriod"]))
        return np.where(np.isfinite(r), (r < float(p["rsiBelow"])).astype(np.float64), np.nan)
    look = int(p["ddLook"])
    hi = pd.Series(c).rolling(look, min_periods=look).max().to_numpy()
    return np.where(np.isfinite(hi), (c <= hi * (1.0 - float(p["ddMin"])) + 1e-12).astype(np.float64), np.nan)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    source = p.get("source", "own")
    shared = None
    if source in ("top10", "pit10"):
        pool = [m for m in _pool(source) if m in candles and len(candles[m])]
        if source == "pit10":
            daily = {m: candles[m] for m in pool} if spec.get("interval") == "1d" else None
            member = uni.pit_members(idx, pool, daily)
        else:
            member = np.ones((n, len(pool)), dtype=bool)
        low, defined = np.zeros(n), np.zeros(n)
        for j, m in enumerate(pool):
            f = _asof(candles[m], _signal(candles[m], p), idx)
            f = np.where(member[:, j], f, np.nan)
            low += np.nan_to_num(f, nan=0.0)
            defined += np.isfinite(f)
        frac = np.divide(low, defined, out=np.zeros(n), where=defined > 0)
        shared = np.where(defined >= MIN_BREADTH_COINS,
                          (frac >= float(p.get("breadthMin", 0.8)) - 1e-12).astype(float), np.nan)
    elif source != "own":
        sigs = [_asof(candles[m], _signal(candles[m], p), idx) for m in SIGNAL_MARKETS]
        a, b = sigs
        ok = np.isfinite(a) & np.isfinite(b)
        val = np.maximum(a, b) if source == "any" else np.minimum(a, b)
        shared = np.where(ok, val, np.nan)
    core_n, hold_n, sell_above = int(p.get("coreSma") or 0), int(p["holdBars"]), float(p["sellAbove"])
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        sig = shared if shared is not None else _asof(df, _signal(df, p), idx)
        r = _asof(df, ind.rsi(c, int(p["rsiPeriod"])), idx)
        if core_n:
            s = ind.sma(c, core_n)
            core = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            core = np.zeros(n)
        w = np.full(n, np.nan)
        ok = np.isfinite(sig) & np.isfinite(r) & np.isfinite(core)
        inside, held = False, 0
        sigl, rl, corel, okl = sig.tolist(), r.tolist(), core.tolist(), ok.tolist()
        for i in range(n):
            if not okl[i]:
                continue
            if not inside:
                if sigl[i] == 1.0:
                    inside, held = True, 0
            else:
                held += 1
                if held >= hold_n or rl[i] > sell_above:
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
    who = {"own": "the coin itself", "both": "both BTC and ETH at the same time",
           "any": "BTC or ETH",
           "top10": f"at least {pct(p.get('breadthMin', 0.8))} of today's ten biggest coins at once",
           "pit10": f"at least {pct(p.get('breadthMin', 0.8))} of the ten most traded coins of that time at once"}[
        p.get("source", "own")]
    if p.get("signal", "rsi") == "rsi":
        what = (f"the RSI over {bars_text(p['rsiPeriod'], iv)} (a 0-100 score of how hard the price has been "
                f"falling or rising) drops under {float(p['rsiBelow']):g}")
    else:
        what = (f"the price closes {pct(p['ddMin'])} or more below its highest close of the last "
                f"{bars_text(p['ddLook'], iv)}")
    steps = []
    if int(p.get("coreSma") or 0):
        steps.append(f"Trend core: it holds {mk} whenever the price is above its {bars_text(p['coreSma'], iv)} "
                     "average, so it rides uptrends.")
    steps.append(f"Rebound buy: when {what} for {who}, it buys {mk}"
                 + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "")
                 + f" and keeps it for up to {bars_text(p['holdBars'], iv)}"
                 + (f", selling earlier once the RSI climbs over {float(p['sellAbove']):g}."
                    if float(p["sellAbove"]) < 100 else ", even if the price is still below its average."))
    steps.append("Otherwise it holds euros.")
    return {
        "summary": f"Rides {mk} uptrends and buys sharp sell-offs early, before the trend average turns back up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets and V-shaped recoveries after crashes, which a plain trend filter re-enters late.",
        "whenItLoses": "Long bear markets where one sell-off follows another: each rebound buy can lose until the "
                       "time limit ends it.",
    }
