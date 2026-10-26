"""regime_gate v1: hold each market only while every enabled regime gate is open (agent-07).

Gates, each optional (0 = off), all evaluated at the bar close on candles up to and including that bar:

- own trend:  the market's close > SMA(trendSma) of its own closes
- BTC trend:  BTC-EUR's latest close > SMA(btcSma) of BTC closes (the market leader decides for everyone)
- low vol:    realised volatility of the market (population std of log returns over volWindow candles) is at most
              volRatioMax times its own average over the last volLong candles (calm compared to usual)
- breadth:    at least breadthMin of the top-10 coins (those with enough history) close above their own
              SMA(breadthSma)

Every market in spec.markets gets maxWeight/len(markets) while its gates are open, otherwise 0 (cash). At least one
gate must be enabled (all off would be buy and hold). Series of other markets are aligned "as of" the bar time
(latest candle at or before it), so nothing looks ahead.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "regime_gate"
VERSION = 1
TITLE = "Regime gate"
BOT_READY = False
MULTI_MARKET = True
BTC = "BTC-EUR"
BREADTH_MARKETS = ["BTC-EUR", "ETH-EUR", "XRP-EUR", "BNB-EUR", "SOL-EUR", "DOGE-EUR", "ADA-EUR", "TRX-EUR",
                   "LINK-EUR", "AVAX-EUR"]
MIN_BREADTH_COINS = 3


def default_params() -> dict:
    return {"trendSma": 0, "btcSma": 200, "volWindow": 20, "volLong": 200, "volRatioMax": 0,
            "breadthSma": 50, "breadthMin": 0}


def param_space() -> dict:
    return {
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "only hold while the market's own close is above this SMA (0 = off)"},
        "btcSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                   "description": "only hold while bitcoin closes above this SMA (0 = off)"},
        "volWindow": {"type": "int", "min": 5, "max": 200, "log": True,
                      "description": "candles in the short-term volatility estimate"},
        "volLong": {"type": "int", "min": 20, "max": 1000, "log": True,
                    "description": "candles over which the usual volatility is averaged"},
        "volRatioMax": {"type": "float", "min": 0.3, "max": 3.0, "zero": True,
                        "description": "only hold while short-term volatility is at most this multiple of usual "
                                       "(0 = off)"},
        "breadthSma": {"type": "int", "min": 10, "max": 400, "log": True,
                       "description": "SMA each top-10 coin is compared with for the breadth gate"},
        "breadthMin": {"type": "float", "min": 0.1, "max": 1.0, "zero": True,
                       "description": "only hold while at least this fraction of the top 10 is above its SMA "
                                      "(0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if not (int(p["trendSma"]) or int(p["btcSma"]) or float(p["volRatioMax"]) or float(p["breadthMin"])):
        return "enable at least one gate (all off is buy and hold)"
    if float(p["volRatioMax"]) and int(p["volLong"]) <= int(p["volWindow"]):
        return "volLong must be longer than volWindow"
    return None


def warmup(p: dict) -> int:
    w = [int(p["trendSma"]), int(p["btcSma"])]
    if float(p["volRatioMax"]):
        w.append(int(p["volWindow"]) + int(p["volLong"]))
    if float(p["breadthMin"]):
        w.append(int(p["breadthSma"]))
    return max(w)


def required_markets(spec: dict) -> list[str]:
    p = {**default_params(), **(spec.get("params") or {})}
    out = []
    if int(p["btcSma"]):
        out.append(BTC)
    if float(p["breadthMin"]):
        out += [m for m in BREADTH_MARKETS if m not in out]
    return out


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """values (on df's own index) as of each time in idx: the latest candle at or before it."""
    s = pd.Series(np.asarray(values, dtype=np.float64), index=np.asarray(df.index, dtype=np.int64))
    pos = np.searchsorted(s.index.to_numpy(), idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = s.to_numpy()[pos[ok]]
    return out


def _flag(cond: np.ndarray, defined: np.ndarray) -> np.ndarray:
    """1.0 where cond, 0.0 where not, NaN where undefined."""
    return np.where(defined, cond.astype(np.float64), np.nan)


def _vol_ratio(c: np.ndarray, short: int, long: int) -> np.ndarray:
    lr = np.full(len(c), np.nan)
    if len(c) > 1:
        lr[1:] = np.log(c[1:] / c[:-1])
    rv = ind.std_pop(lr, short)
    return rv / ind.sma(rv, long)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    trend_n, btc_n = int(p["trendSma"]), int(p["btcSma"])
    vmax, bmin = float(p["volRatioMax"]), float(p["breadthMin"])

    shared = np.ones(n)  # gates that are the same for every market (NaN = undefined)
    if btc_n:
        if BTC not in candles:
            raise KeyError(f"regime_gate with btcSma needs {BTC} candles")
        b = candles[BTC]["close"].to_numpy(np.float64)
        s = ind.sma(b, btc_n)
        shared = shared * _asof(candles[BTC], _flag(b > s, np.isfinite(s)), idx)
    if bmin:
        above, defined = np.zeros(n), np.zeros(n)
        for m in BREADTH_MARKETS:
            if m not in candles or len(candles[m]) == 0:
                continue
            c = candles[m]["close"].to_numpy(np.float64)
            s = ind.sma(c, int(p["breadthSma"]))
            f = _asof(candles[m], _flag(c > s, np.isfinite(s)), idx)
            above += np.nan_to_num(f, nan=0.0)
            defined += np.isfinite(f)
        frac = np.divide(above, defined, out=np.zeros(n), where=defined > 0)
        shared = shared * np.where(defined >= MIN_BREADTH_COINS, (frac >= bmin - 1e-12).astype(float), np.nan)

    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        g = np.ones(len(c))
        if trend_n:
            s = ind.sma(c, trend_n)
            g = g * _flag(c > s, np.isfinite(s))
        if vmax:
            r = _vol_ratio(c, int(p["volWindow"]), int(p["volLong"]))
            g = g * _flag(r <= vmax, np.isfinite(r))
        own = _asof(df, g, idx)
        cols[m] = own * shared * each
    # NaN until every market and every gate is defined; afterwards no NaN (rule of the target contract).
    W = np.column_stack([cols[m] for m in markets])
    ok = np.isfinite(W).all(axis=1)
    first = int(np.argmax(ok)) if ok.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    gates = []
    if int(p["trendSma"]):
        gates.append(f"the coin's own price is above its {bars_text(p['trendSma'], iv)} average")
    if int(p["btcSma"]):
        gates.append(f"bitcoin is above its {bars_text(p['btcSma'], iv)} average price (the whole market is in an "
                     "uptrend)")
    if float(p["volRatioMax"]):
        gates.append(f"the coin is calm: its price swings over the last {bars_text(p['volWindow'], iv)} are at most "
                     f"{float(p['volRatioMax']):.2f} times their usual size over {bars_text(p['volLong'], iv)}")
    if float(p["breadthMin"]):
        gates.append(f"at least {pct(p['breadthMin'])} of the ten biggest coins trade above their own "
                     f"{bars_text(p['breadthSma'], iv)} average (most of the market is rising)")
    steps = [f"After every {iv} candle it checks the market climate for {mk}."]
    steps += [f"Condition: {g}." for g in gates]
    steps.append(f"While every condition holds it holds the coin with {100 / max(k, 1):.0f} % of the money"
                 + (" per coin" if k > 1 else "") + "; as soon as one fails it sells and waits in euros.")
    return {
        "summary": f"Holds {mk} only in a friendly market climate and sits in euros otherwise.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bull markets and crashes: it rides the uptrend and is in euros for most of a bear market.",
        "whenItLoses": "Sideways markets that flip the conditions on and off (fees, buying back higher) and fast "
                       "V-shaped recoveries it re-enters late.",
    }
