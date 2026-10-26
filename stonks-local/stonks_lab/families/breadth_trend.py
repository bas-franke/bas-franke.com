"""breadth_trend v1: hold BTC/ETH while the top-10 crypto market as a whole is trending up (agent-20).

The market climate is read from the ten biggest coins (those with candles up to the bar, at least 3):

- signal "sma":    breadth = fraction of the top 10 whose close is above its own SMA(length)
- signal "mom":    breadth = fraction of the top 10 whose close is above its close `length` candles ago
- signal "basket": an equal-weight top-10 basket (mean of the coins' per-candle log returns, chained); the climate
                   is good while the basket's log level is above its SMA(length) by more than basketBand

Unlike regime_gate's single threshold, the breadth signals use hysteresis: the strategy switches on when breadth
reaches enterAt and only switches off when it falls under exitAt (exitAt <= enterAt), which avoids flipping in and
out on every wobble. For the basket the band does the same (on above +band, off below -band).

sizing "full": every market in spec.markets gets maxWeight/len(markets) while on. sizing "graded" (breadth signals
only): while on, the weight is that share times the breadth fraction rounded down to quarters, so a narrow rally is
held small and a broad one in full. Optional own-trend filter: a market is only held while its close is above its
SMA(trendSma). Other markets are aligned "as of" the bar time (latest candle at or before it): no look-ahead.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "breadth_trend"
VERSION = 1
TITLE = "Market breadth trend"
BOT_READY = False
MULTI_MARKET = True
BREADTH_MARKETS = ["BTC-EUR", "ETH-EUR", "XRP-EUR", "BNB-EUR", "SOL-EUR", "DOGE-EUR", "ADA-EUR", "TRX-EUR",
                   "LINK-EUR", "AVAX-EUR"]
MIN_BREADTH_COINS = 3


def default_params() -> dict:
    return {"signal": "sma", "length": 20, "enterAt": 0.7, "exitAt": 0.4, "basketBand": 0.0, "trendSma": 0,
            "sizing": "full"}


def param_space() -> dict:
    return {
        "signal": {"type": "choice", "values": ["sma", "mom", "basket"],
                   "description": "climate signal: share of the top 10 above their SMA (sma), share with a positive "
                                  "return over `length` (mom), or an equal-weight top-10 basket above its SMA "
                                  "(basket)"},
        "length": {"type": "int", "min": 5, "max": 400, "log": True,
                   "description": "candles in the SMA / momentum window of the climate signal"},
        "enterAt": {"type": "float", "min": 0.3, "max": 1.0,
                    "description": "breadth signals: switch on when at least this share of the top 10 is rising"},
        "exitAt": {"type": "float", "min": 0.0, "max": 0.9,
                   "description": "breadth signals: switch off when fewer than this share is rising (<= enterAt)"},
        "basketBand": {"type": "float", "min": 0.005, "max": 0.2, "log": True, "zero": True,
                       "description": "basket signal: on above SMA + band, off below SMA - band (log terms)"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "only hold a market while its own close is above this SMA (0 = off)"},
        "sizing": {"type": "choice", "values": ["full", "graded"],
                   "description": "full: whole share while on; graded: share times breadth (in quarters)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["exitAt"]) > float(p["enterAt"]):
        return "exitAt must be at most enterAt"
    if p["signal"] == "basket" and p["sizing"] == "graded":
        return "graded sizing needs a breadth signal (sma or mom)"
    return None


def warmup(p: dict) -> int:
    return max(int(p["length"]) + 1, int(p["trendSma"]))


def required_markets(spec: dict) -> list[str]:
    return list(BREADTH_MARKETS)


def _asof(df, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _flag(cond: np.ndarray, defined: np.ndarray) -> np.ndarray:
    return np.where(defined, cond.astype(np.float64), np.nan)


def _breadth(candles, p, idx) -> np.ndarray:
    """Share of the top 10 that is rising at each bar; NaN while fewer than 3 coins are defined."""
    n, L = len(idx), int(p["length"])
    up, defined = np.zeros(n), np.zeros(n)
    for m in BREADTH_MARKETS:
        if m not in candles or len(candles[m]) == 0:
            continue
        c = candles[m]["close"].to_numpy(np.float64)
        if p["signal"] == "sma":
            s = ind.sma(c, L)
            f = _flag(c > s, np.isfinite(s))
        else:
            prev = np.full(len(c), np.nan)
            if len(c) > L:
                prev[L:] = c[:-L]
            f = _flag(c > prev, np.isfinite(prev))
        a = _asof(candles[m], f, idx)
        up += np.nan_to_num(a, nan=0.0)
        defined += np.isfinite(a)
    frac = np.divide(up, defined, out=np.zeros(n), where=defined > 0)
    return np.where(defined >= MIN_BREADTH_COINS, frac, np.nan)


def _basket_gap(candles, p, idx) -> np.ndarray:
    """Basket log level minus its SMA(length); NaN until defined."""
    n = len(idx)
    rets = []
    for m in BREADTH_MARKETS:
        if m not in candles or len(candles[m]) == 0:
            continue
        c = _asof(candles[m], candles[m]["close"].to_numpy(np.float64), idx)
        r = np.full(n, np.nan)
        if n > 1:
            with np.errstate(divide="ignore", invalid="ignore"):
                r[1:] = np.log(c[1:] / c[:-1])
        rets.append(r)
    if not rets:
        return np.full(n, np.nan)
    R = np.column_stack(rets)
    cnt = np.isfinite(R).sum(axis=1)
    mean = np.divide(np.nansum(R, axis=1), cnt, out=np.zeros(n), where=cnt > 0)
    ok = cnt >= MIN_BREADTH_COINS
    if not ok.any():
        return np.full(n, np.nan)
    start = int(np.argmax(ok))
    level = np.full(n, np.nan)
    level[start:] = np.cumsum(np.where(ok[start:], mean[start:], 0.0))
    gap = np.full(n, np.nan)
    seg = level[start:]
    s = ind.sma(seg, int(p["length"]))
    gap[start:] = seg - s
    return gap


def _state(sig: np.ndarray, on_at: float, off_at: float, strict_off: bool) -> np.ndarray:
    """Hysteresis switch: on when sig >= on_at, off when sig < off_at (strict_off) / <= off_at. NaN where sig is."""
    out = np.full(len(sig), np.nan)
    on = False
    for i, v in enumerate(sig.tolist()):
        if v != v:
            continue
        if not on and v >= on_at - 1e-12:
            on = True
        elif on and (v < off_at - 1e-12 if strict_off else v <= off_at):
            on = False
        out[i] = 1.0 if on else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    if p["signal"] == "basket":
        band = float(p["basketBand"])
        gap = _basket_gap(candles, p, idx)
        state = _state(gap, band, -band, strict_off=False) if band else \
            np.where(np.isfinite(gap), (gap > 0).astype(np.float64), np.nan)
        size = state
    else:
        frac = _breadth(candles, p, idx)
        state = _state(frac, float(p["enterAt"]), float(p["exitAt"]), strict_off=True)
        if p["sizing"] == "graded":
            size = state * np.floor(np.nan_to_num(frac, nan=0.0) * 4 + 1e-9) / 4
            size = np.where(np.isfinite(state), size, np.nan)
        else:
            size = state

    each = max_weight(spec) / len(markets)
    trend_n = int(p["trendSma"])
    cols = {}
    for m in markets:
        df = candles[m]
        if trend_n:
            c = df["close"].to_numpy(np.float64)
            s = ind.sma(c, trend_n)
            own = _asof(df, _flag(c > s, np.isfinite(s)), idx)
        else:
            own = np.ones(n)
        cols[m] = size * own * each
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
    L = bars_text(p["length"], iv)
    if p["signal"] == "basket":
        band = float(p["basketBand"])
        steps = [f"After every {iv} candle it tracks an equal-weight basket of the ten biggest coins and compares "
                 f"it with the basket's own {L} average.",
                 "It buys when the basket is above that average"
                 + (f" by more than {pct(band)} and sells when it falls more than {pct(band)} below it."
                    if band else " and sells as soon as it is below it.")]
    else:
        what = (f"trade above their own {L} average" if p["signal"] == "sma"
                else f"are higher than {L} ago")
        steps = [f"After every {iv} candle it counts how many of the ten biggest coins {what}.",
                 f"It buys once at least {pct(p['enterAt'])} of them do (most of the market is rising) and keeps "
                 f"holding until fewer than {pct(p['exitAt'])} do, then it sells and waits in euros."]
        if p["sizing"] == "graded":
            steps.append("While invested, the position size follows how broad the rally is: with 50 % of the coins "
                         "rising it holds half its share, with all of them rising its full share.")
    if int(p["trendSma"]):
        steps.append(f"It only holds a coin while that coin itself is above its {bars_text(p['trendSma'], iv)} "
                     "average.")
    steps.append(f"It holds {mk}" + (f" with {100 / k:.0f} % of the money per coin." if k > 1 else "."))
    return {
        "summary": f"Holds {mk} while most of the top-10 crypto market is rising and sits in euros otherwise.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Broad bull markets (it stays in) and long bear markets (it is in euros most of the time).",
        "whenItLoses": "Choppy sideways markets where breadth swings around the thresholds, and sharp rebounds it "
                       "re-enters late.",
    }
