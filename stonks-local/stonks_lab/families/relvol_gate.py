"""relvol_gate v1 (agent-19, rotation lane): ETH's volatility relative to BTC's as a speculation-appetite gate.

ETH is the riskier of the two big coins. When speculation is alive, ETH swings much more than BTC; when appetite
dies, ETH trades almost like BTC. This family measures, at bar t (closes up to and including t only):

    vr_t = stdev(ETH log returns, volLen) / stdev(BTC log returns, volLen)
    s_t  = vr_t / median(vr over the last baseLen bars) - 1      (baseLen 0: s_t = vr_t - 1, the raw ratio)

and keeps an "appetite on" state with hysteresis: on when s >= sIn, off when s < sOut (sOut <= sIn).

Pre-holdout signal study (agent-19, 1d 2019-2025-10, forward 30 days, within-year top-minus-bottom tercile after
sorting by 60d momentum): the 120-day ratio was positive in 5 of 5 full years for BTC (+28, +34, +13, +7, +1 log-pct)
and for ETH (+29, +29, +22, +5, +20); low ratio (ETH as calm as BTC) preceded weak returns for both. The edge
shrank year by year on BTC.

Modes: ``gate`` holds while appetite is on; ``or_sma`` holds while the close is above SMA(smaLen) OR appetite is on;
``and_sma`` holds only while both. ``minHold`` keeps a new position at least that many bars. The signal is shared;
the SMA is each traded coin's own. Every traded market gets maxWeight / len(markets) while held. Needs BTC-EUR and
ETH-EUR candles whatever is traded.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "relvol_gate"
VERSION = 1
TITLE = "ETH/BTC volatility-ratio appetite gate"
BOT_READY = False
MULTI_MARKET = True
BTC, ETH = "BTC-EUR", "ETH-EUR"


def default_params() -> dict:
    return {"volLen": 120, "baseLen": 365, "sIn": 0.0, "sOut": -0.1, "mode": "gate", "smaLen": 130, "minHold": 0}


def param_space() -> dict:
    return {
        "volLen": {"type": "int", "min": 10, "max": 300, "log": True,
                   "description": "candles of log returns in each coin's volatility"},
        "baseLen": {"type": "int", "min": 90, "max": 1000, "log": True, "zero": True,
                    "description": "candles in the rolling median the ratio is compared with (0 = raw ratio vs 1)"},
        "sIn": {"type": "float", "min": -0.4, "max": 0.6,
                "description": "appetite on when the ratio is at least this far above its median (fraction)"},
        "sOut": {"type": "float", "min": -0.6, "max": 0.5,
                 "description": "appetite off when the ratio falls below this (<= sIn)"},
        "mode": {"type": "choice", "values": ["gate", "or_sma", "and_sma"],
                 "description": "gate: appetite alone; or_sma: own SMA or appetite; and_sma: both"},
        "smaLen": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "own SMA core length for or_sma / and_sma"},
        "minHold": {"type": "int", "min": 1, "max": 60, "zero": True, "log": True,
                    "description": "keep a new position at least this many candles (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["sOut"]) > float(p["sIn"]):
        return "sOut must not exceed sIn"
    return None


def warmup(p: dict) -> int:
    n = int(p["volLen"]) + int(p.get("baseLen") or 0)
    if p.get("mode", "gate") != "gate":
        n = max(n, int(p["smaLen"]))
    return n


def required_markets(spec: dict) -> list[str]:
    return [BTC, ETH]


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def appetite(candles, idx: np.ndarray, p: dict) -> np.ndarray:
    """s_t on ``idx`` (NaN until both coins have volLen returns and the baseline is full)."""
    n = int(p["volLen"])
    base = int(p.get("baseLen") or 0)
    sd = {}
    for m in (BTC, ETH):
        c = pd.Series(_asof(candles[m], candles[m]["close"].to_numpy(np.float64), idx))
        sd[m] = np.log(c).diff().rolling(n, min_periods=n).std(ddof=0)
    vr = sd[ETH] / sd[BTC].where(sd[BTC] > 0)
    if base > 0:
        med = vr.rolling(base, min_periods=base).median()
        s = vr / med - 1.0
    else:
        s = vr - 1.0
    return s.to_numpy(np.float64)


def _held(close: np.ndarray, s: np.ndarray, p: dict) -> np.ndarray:
    n = len(close)
    out = np.full(n, np.nan)
    mode = p.get("mode", "gate")
    sma = ind.sma(close, int(p["smaLen"])) if mode != "gate" else None
    s_in, s_out = float(p["sIn"]), float(p["sOut"])
    min_hold = int(p.get("minHold") or 0)
    on = held = False
    age = 0
    for t in range(n):
        if np.isnan(s[t]) or np.isnan(close[t]) or (sma is not None and np.isnan(sma[t])):
            continue
        if on:
            if s[t] < s_out:
                on = False
        elif s[t] >= s_in:
            on = True
        if mode == "gate":
            want = on
        elif mode == "or_sma":
            want = on or close[t] > sma[t]
        else:
            want = on and close[t] > sma[t]
        if held and not want and min_hold and age < min_hold:
            want = True
        if want and not held:
            age = 0
        held = want
        age += 1
        out[t] = 1.0 if held else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets + [BTC, ETH])
    n = len(idx)
    s = appetite(candles, idx, p)
    each = max_weight(spec) / len(markets)
    cols = []
    for m in markets:
        c = _asof(candles[m], candles[m]["close"].to_numpy(np.float64), idx)
        cols.append(_held(c, s, p) * each)
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
    mode = p.get("mode", "gate")
    look = bars_text(p["volLen"], iv)
    base = int(p.get("baseLen") or 0)
    ref = f"its usual level (median of the last {bars_text(base, iv)})" if base else "BTC's own swings"
    app = (f"ETH is swinging clearly more than BTC (ETH's volatility over the last {look} divided by BTC's, compared "
           f"with {ref}; on at {float(p['sIn']):+.0%}, off below {float(p['sOut']):+.0%})")
    avg = f"its average of the last {bars_text(p['smaLen'], iv)}"
    if mode == "gate":
        rule = f"It holds {mk} while {app}; when ETH calms down to move like BTC, it goes to cash."
    elif mode == "or_sma":
        rule = f"It holds {mk} while the price is above {avg}, and also below it while {app}."
    else:
        rule = f"It holds {mk} only while the price is above {avg} and {app}."
    steps = [rule + (f" ({100 / k:.0f} % of the money per coin.)" if k > 1 else "")]
    mh = int(p.get("minHold") or 0)
    if mh:
        steps.append(f"After buying it keeps the position at least {bars_text(mh, iv)}.")
    return {
        "summary": f"Holds {mk} while speculation is alive, read from how much wilder ETH moves than BTC.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Speculative bull phases (ETH far more volatile than BTC) and quiet, appetite-less bear "
                      "markets it sits out.",
        "whenItLoses": "BTC-led rallies in which ETH stays calm, and crashes in which ETH's extra volatility comes "
                       "from falling faster.",
    }
