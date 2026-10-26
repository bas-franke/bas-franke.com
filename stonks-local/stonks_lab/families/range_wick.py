"""range_wick v1 (agent-21, breakout lane): wide-range candles, read by which wick is long.

Pre-holdout signal study (2019-03..2025-10, 1d, unrecorded): a candle whose range (high - low) is at least
``rangeMult`` x the median range of the last ``rangeLook`` candles AND whose upper wick is at least ``wickMin`` of
that range (a wide "shooting star") was followed by HIGHER 10-day returns than other days in the same trend state
(BTC +2..+5 %, 7/7 years positive; ETH +2..+9 %), the opposite of the candlestick folklore. A wide candle with a
long lower wick (a wide "hammer") was followed by lower returns (ETH 6/7 years negative, BTC 4/7). Without the
wide-range condition the effect is noise (finding #449).

Per market (own candles), decided at each bar's close:

* bull event at bar t: range_t >= rangeMult x median(range over the last rangeLook candles, incl. t) and
  upper wick_t / range_t >= wickMin;
* bear event: same width test and lower wick_t / range_t >= wickMin (only used when ``blockBars`` > 0);
* the latest event decides for a while: a bull event holds the coin for ``holdBars`` candles (t included), a bear
  event holds euros for ``blockBars`` candles; a newer event replaces an older one;
* otherwise the ``base`` rule decides: ``cash`` (only event trades), ``hold`` (always in), or ``sma`` (in while the
  close is above SMA(``smaLen``)).

Range is measured relative to the close (high - low) / close. Multi-market: equal slots of maxWeight.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "range_wick"
VERSION = 1
TITLE = "Wide-candle wick events"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"rangeLook": 20, "rangeMult": 1.3, "wickMin": 0.5, "holdBars": 10, "blockBars": 0,
            "base": "sma", "smaLen": 100}


def param_space() -> dict:
    return {
        "rangeLook": {"type": "int", "min": 5, "max": 120, "log": True,
                      "description": "candles in the median range a wide candle is compared with"},
        "rangeMult": {"type": "float", "min": 1.0, "max": 3.0,
                      "description": "a candle is wide when its range is at least this x the median range"},
        "wickMin": {"type": "float", "min": 0.3, "max": 0.8,
                    "description": "share of the candle's range the upper (bull) or lower (bear) wick must take"},
        "holdBars": {"type": "int", "min": 1, "max": 60, "log": True, "zero": True,
                     "description": "candles to hold the coin after a wide long-upper-wick candle (0 = off)"},
        "blockBars": {"type": "int", "min": 1, "max": 60, "log": True, "zero": True,
                      "description": "candles in euros after a wide long-lower-wick candle (0 = off)"},
        "base": {"type": "choice", "values": ["cash", "sma", "hold"],
                 "description": "what it does without a recent event: euros, SMA trend core, or hold"},
        "smaLen": {"type": "int", "min": 20, "max": 400, "log": True,
                   "description": "SMA length of the trend core (base = sma)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["holdBars"] or 0) == 0 and int(p["blockBars"] or 0) == 0:
        return "holdBars and blockBars can't both be 0 (that is the plain base rule)"
    if p["base"] == "hold" and int(p["blockBars"] or 0) == 0:
        return "base hold without bear blocks is buy and hold"
    if p["base"] == "cash" and int(p["holdBars"] or 0) == 0:
        return "base cash without bull holds never trades"
    return None


def warmup(p: dict) -> int:
    w = int(p["rangeLook"])
    if p["base"] == "sma":
        w = max(w, int(p["smaLen"]))
    return w


def _ohlc(candles, m, idx):
    df = candles[m]
    out = {}
    for k in ("open", "high", "low", "close"):
        s = pd.Series(df[k].to_numpy(np.float64), index=np.asarray(df.index, dtype=np.int64))
        out[k] = s.reindex(idx).to_numpy(np.float64)
    # a missing bar is a flat candle at the previous close
    c = pd.Series(out["close"]).ffill().to_numpy(np.float64)
    miss = ~np.isfinite(out["close"])
    for k in ("open", "high", "low"):
        out[k] = np.where(miss, c, out[k])
    out["close"] = c
    return out


def event_weights(o, h, l, c, p: dict) -> np.ndarray:
    """1/0 per bar (NaN before warm-up or listing)."""
    n = len(c)
    w = np.full(n, np.nan)
    ok = np.isfinite(c) & (c > 0)
    if not ok.any():
        return w
    s0 = int(np.argmax(ok))
    o, h, l, c = o[s0:], h[s0:], l[s0:], c[s0:]
    rng = np.maximum(h - l, 0.0)
    rp = rng / c
    look = int(p["rangeLook"])
    med = pd.Series(rp).rolling(look, min_periods=look).median().to_numpy()
    wide = np.isfinite(med) & (rp > 0) & (rp >= float(p["rangeMult"]) * med)
    safe = np.where(rng > 0, rng, 1.0)
    uw = (h - np.maximum(o, c)) / safe
    lw = (np.minimum(o, c) - l) / safe
    wm = float(p["wickMin"])
    hb, bb = int(p["holdBars"] or 0), int(p["blockBars"] or 0)
    bull = wide & (uw >= wm) & (hb > 0)
    bear = wide & (lw >= wm) & (bb > 0)
    base = p["base"]
    if base == "sma":
        ma = np.asarray(ind.sma(c, int(p["smaLen"])), dtype=np.float64)
        base_on = np.where(np.isfinite(ma), (c > ma).astype(np.float64), np.nan)
    elif base == "hold":
        base_on = np.ones(len(c))
    else:
        base_on = np.zeros(len(c))
    warm = max(look - 1, 0)
    kind, until = 0, -1
    out = np.full(len(c), np.nan)
    for i in range(len(c)):
        if bull[i] and bear[i]:
            pass  # both wicks long on a wide candle: no information
        elif bull[i]:
            kind, until = 1, i + hb
        elif bear[i]:
            kind, until = -1, i + bb
        if i < warm or not np.isfinite(base_on[i]):
            continue
        if i < until:
            out[i] = 1.0 if kind == 1 else 0.0
        else:
            out[i] = base_on[i]
    w[s0:] = out
    return w


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    slot = max_weight(spec) / len(markets)
    cols = []
    for m in markets:
        d = _ohlc(candles, m, idx)
        cols.append(slot * event_weights(d["open"], d["high"], d["low"], d["close"], p))
    W = np.column_stack(cols)
    any_dec = np.isfinite(W).any(axis=1)
    W = np.where(np.isnan(W) & any_dec[:, None], 0.0, W)
    return frame(idx, {m: W[:, k] for k, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    wide = (f"a candle is 'wide' when its high-low range is at least {float(p['rangeMult']):.1f}x the typical "
            f"(median) range of the last {bars_text(int(p['rangeLook']), iv)}")
    base = {"cash": "it keeps euros",
            "hold": f"it holds {mk}",
            "sma": f"it holds {mk} while the price is above its {bars_text(int(p['smaLen']), iv)} average, "
                   "otherwise euros"}[p["base"]]
    steps = [f"After every {iv} candle it checks whether {wide}."]
    if int(p["holdBars"] or 0):
        steps.append(f"A wide candle whose upper wick takes at least {int(100 * float(p['wickMin']))} % of its range "
                     f"(the price spiked up during the candle) is read as strength: it buys and holds for "
                     f"{bars_text(int(p['holdBars']), iv)}.")
    if int(p["blockBars"] or 0):
        steps.append(f"A wide candle whose lower wick takes at least {int(100 * float(p['wickMin']))} % of its range "
                     f"(a deep intraday sell-off) is read as weakness: it sells and waits "
                     f"{bars_text(int(p['blockBars']), iv)}.")
    steps.append(f"Without a recent wide candle {base}.")
    return {
        "summary": f"Trades {mk} on unusually wide candles: a big upward spike is a buy, a deep intraday "
                   "sell-off a reason to step aside (the reverse of the classic candlestick reading).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Volatile up-moves that keep going for a week or two, and sell-offs that keep sliding.",
        "whenItLoses": "Spikes that fade straight away and sell-off wicks that mark the bottom; quiet markets "
                       "give few signals.",
    }
