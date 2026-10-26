"""cost_basis v1 (agent-02): a turnover-weighted "cost basis" of each coin (a realized-price / MVRV proxy built from
Bitvavo EUR volume) as trend core and froth gauge.

On-chain analysts compare the price with the average price coins last moved at (realized price, MVRV). We have no
on-chain data, but every candle says how many coins changed hands at roughly what price. An exponentially decaying
volume-weighted average price (half-life `halfLife` candles) is the average entry price of recent buyers on the
exchange: weeks of heavy turnover (capitulations, blow-off tops) pull it hard, quiet drift barely moves it.
`weighting = "equal"` replaces it with the plain exponential average of the close (same half-life): the paired
ablation that tells whether the volume weighting adds anything over an ordinary moving average.

Per coin, at the bar close t (only candles up to t):
- CB_t = EWM(volume * close) / EWM(volume) with half-life halfLife (adjust=True; equal: EWM(close)); r_t = close / CB_t.
- Trend leg (trend=true): in once r_t > 1 + enterBand, out once r_t < 1 - exitBand, otherwise unchanged.
  trend=false: always in (hold), only the froth leg trades.
- Froth leg (topMult > 0): froth switches on when r_t >= topMult (price far above what recent buyers paid) and off
  again once r_t < topMult * (1 - topBand). While on, the coin is sold.
weight = maxWeight / len(markets) while in and not frothy, else 0. NaN before halfLife candles of the coin.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "cost_basis"
VERSION = 1
TITLE = "Turnover cost basis (realized-price proxy)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"halfLife": 60, "weighting": "volume", "trend": True, "enterBand": 0.0, "exitBand": 0.0,
            "topMult": 0.0, "topBand": 0.15}


def param_space() -> dict:
    return {
        "halfLife": {"type": "int", "min": 5, "max": 600, "log": True,
                     "description": "half-life in candles of the decaying average entry price"},
        "weighting": {"type": "choice", "values": ["volume", "equal"],
                      "description": "volume: weight each candle by its traded volume (cost basis); equal: plain "
                                     "exponential average of the close (ablation)"},
        "trend": {"type": "bool", "description": "hold only while the price is above the cost basis (false = hold "
                                                 "unless frothy)"},
        "enterBand": {"type": "float", "min": 0.005, "max": 0.2, "log": True, "zero": True,
                      "description": "buy only once the price is this fraction above the cost basis"},
        "exitBand": {"type": "float", "min": 0.005, "max": 0.3, "log": True, "zero": True,
                     "description": "sell only once the price is this fraction below the cost basis"},
        "topMult": {"type": "float", "min": 1.2, "max": 6.0, "log": True, "zero": True,
                    "description": "sell while the price is at least this multiple of the cost basis (0 = off)"},
        "topBand": {"type": "float", "min": 0.0, "max": 0.5,
                    "description": "froth ends once the multiple is this fraction under topMult"},
    }


def valid_params(p: dict) -> str | None:
    if not p.get("trend") and not float(p.get("topMult") or 0):
        return "with trend off and topMult 0 it would only hold"
    return None


def warmup(p: dict) -> int:
    return int(p["halfLife"])


def ratio(df: pd.DataFrame, p: dict) -> np.ndarray:
    """close / cost basis per candle of df, NaN for the first halfLife candles."""
    c = df["close"].to_numpy(np.float64)
    h = float(p["halfLife"])
    if p.get("weighting", "volume") == "volume":
        v = np.nan_to_num(df["volume"].to_numpy(np.float64), nan=0.0)
        num = pd.Series(v * c).ewm(halflife=h, adjust=True).mean().to_numpy()
        den = pd.Series(v).ewm(halflife=h, adjust=True).mean().to_numpy()
        with np.errstate(invalid="ignore", divide="ignore"):
            cb = np.where(den > 0, num / np.where(den > 0, den, 1.0), np.nan)
    else:
        cb = pd.Series(c).ewm(halflife=h, adjust=True).mean().to_numpy()
    r = c / cb
    r[: int(p["halfLife"])] = np.nan
    return r


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def _states(r: np.ndarray, p: dict) -> np.ndarray:
    trend = bool(p.get("trend"))
    up, dn = 1.0 + float(p.get("enterBand") or 0), 1.0 - float(p.get("exitBand") or 0)
    top = float(p.get("topMult") or 0)
    back = top * (1.0 - float(p.get("topBand") or 0))
    out = np.full(len(r), np.nan)
    inside, froth = None, False
    for i, x in enumerate(r.tolist()):
        if not np.isfinite(x):
            continue
        if trend:
            if inside is None:
                inside = x > 1.0
            elif x > up:
                inside = True
            elif x < dn:
                inside = False
        else:
            inside = True
        if top > 0:
            if x >= top:
                froth = True
            elif x < back:
                froth = False
        out[i] = 1.0 if (inside and not froth) else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        st = _states(ratio(df, p), p)
        t = np.asarray(df.index, dtype=np.int64)
        w = _asof(df, st, idx) * each
        w[idx < t[0]] = np.nan
        cols[m] = w
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else len(idx)
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    hl = bars_text(p["halfLife"], iv)
    vol = p.get("weighting", "volume") == "volume"
    basis = (f"the average price recent buyers of {mk} paid on the exchange: every candle's price weighted by how "
             f"much was traded, with older trades fading out (half of the weight is older than {hl})" if vol else
             f"the exponential average of {mk}'s closing price (half of the weight is older than {hl})")
    steps = [f"After every {iv} candle it computes {basis}."]
    if p.get("trend"):
        eb, xb = float(p.get("enterBand") or 0), float(p.get("exitBand") or 0)
        steps.append("Trend: it holds the coin while the price is above that cost basis"
                     + (f" (buying only {pct(eb)} above it" if eb else " (buying as soon as it is above it")
                     + (f", selling only {pct(xb)} below it)" if xb else ", selling as soon as it drops below)")
                     + ": recent buyers are in profit, so dips get bought instead of sold.")
    else:
        steps.append(f"It holds {mk} by default.")
    top = float(p.get("topMult") or 0)
    if top:
        steps.append(f"Froth: when the price is {top:.2f} times the cost basis or more, recent buyers sit on huge "
                     f"gains and it sells; it buys back once the multiple falls under "
                     f"{top * (1 - float(p.get('topBand') or 0)):.2f}.")
    steps.append("Otherwise it holds euros" + (" (each coin gets an equal share of the money)." if
                                                len(spec.get("markets") or []) > 1 else "."))
    return {
        "summary": f"Holds {mk} while the price is above what recent buyers paid on average"
                   + (" and steps aside when it runs far above it." if top else "."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends after a crash, where the high-volume capitulation pulls the cost basis down and "
                      "the price stays above it, and blow-off tops far above the cost basis.",
        "whenItLoses": "Choppy markets that cross the cost basis again and again (each crossing costs fees), and "
                       "bull runs that keep going after the froth exit.",
    }
