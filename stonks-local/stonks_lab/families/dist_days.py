"""dist_days v1 (agent-20, regime lane): distribution-day count exit + follow-through-day re-entry (IBD style).

The classic stock-market timing method of Investor's Business Daily, applied to each coin's own candles:

- a *distribution day* is a candle that closes at least ``distRet`` lower than the previous close on rising volume
  (``volRule`` "prev": more volume than the previous candle; "avg": at least ``volMult`` x the 50-candle average
  volume; "none": any volume). It marks big holders selling.
- a distribution day *expires* after ``window`` candles, or (``expireGain`` > 0) once the close has risen that far
  above the distribution day's close since.
- hold by default. Step aside when ``maxDist`` or more live distribution days have piled up since the last buy.
- *follow-through day* (re-entry): while out, track the lowest low since the exit; a new low restarts the "rally
  attempt". On day ``ftdDay`` or later of the attempt, a close at least ``ftdRet`` above the previous close on higher
  volume than the previous candle buys back. Distribution days before the buy no longer count.
- optional fallback re-entry (``reenterSma`` > 0): also buy back when the close is back above this SMA.

Each market gets maxWeight/len(markets) while held. Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "dist_days"
VERSION = 1
TITLE = "Distribution days and follow-through"
BOT_READY = False
MULTI_MARKET = True
ANCHORED = False

VOL_AVG = 50


def default_params() -> dict:
    return {"distRet": 0.02, "volRule": "prev", "volMult": 1.0, "window": 25, "maxDist": 5, "expireGain": 0.0,
            "ftdDay": 4, "ftdRet": 0.03, "reenterSma": 0}


def param_space() -> dict:
    return {
        "distRet": {"type": "float", "min": 0.003, "max": 0.08, "log": True,
                    "description": "a distribution day closes at least this fraction under the previous close"},
        "volRule": {"type": "choice", "values": ["prev", "avg", "none"],
                    "description": "volume test: above the previous candle, above volMult x the 50-candle average, or none"},
        "volMult": {"type": "float", "min": 0.8, "max": 3.0,
                    "description": "multiple of the 50-candle average volume for volRule 'avg'"},
        "window": {"type": "int", "min": 5, "max": 120, "log": True,
                   "description": "candles a distribution day stays counted"},
        "maxDist": {"type": "int", "min": 2, "max": 12,
                    "description": "step aside when this many distribution days are live"},
        "expireGain": {"type": "float", "min": 0.02, "max": 0.3, "log": True, "zero": True,
                       "description": "a distribution day expires once the close rises this far above it (0 = off)"},
        "ftdDay": {"type": "int", "min": 1, "max": 15,
                   "description": "earliest day of a rally attempt (candles since its low) that can follow through"},
        "ftdRet": {"type": "float", "min": 0.005, "max": 0.1, "log": True,
                   "description": "a follow-through day closes at least this fraction above the previous close"},
        "reenterSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                       "description": "also buy back when the close is above this SMA (0 = follow-through only)"},
    }


def warmup(p: dict) -> int:
    return max(VOL_AVG, int(p["window"]), int(p["reenterSma"] or 0)) + 1


def _weights(df, p) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    lo = df["low"].to_numpy(np.float64)
    v = df["volume"].to_numpy(np.float64)
    n = len(c)
    ret = np.full(n, np.nan)
    ret[1:] = c[1:] / c[:-1] - 1.0
    vprev = np.full(n, np.nan)
    vprev[1:] = v[:-1]
    vavg = ind.sma(v, VOL_AVG)
    rule = p["volRule"]
    if rule == "prev":
        volok = v > vprev
    elif rule == "avg":
        volok = v >= float(p["volMult"]) * vavg
    else:
        volok = np.ones(n, dtype=bool)
    dist = (ret <= -float(p["distRet"])) & volok
    rs = int(p["reenterSma"] or 0)
    sma = ind.sma(c, rs) if rs else np.zeros(n)
    win, mx, eg = int(p["window"]), int(p["maxDist"]), float(p.get("expireGain") or 0)
    fday, fret = int(p["ftdDay"]), float(p["ftdRet"])
    start = warmup(p) - 1
    w = np.full(n, np.nan)
    held = True
    since = start           # distribution days count only after the last buy
    low_v, low_i = np.inf, -1
    for i in range(start, n):
        if not (np.isfinite(ret[i]) and np.isfinite(sma[i])):
            continue
        if held:
            cnt = 0
            for d in range(max(since + 1, i - win + 1), i + 1):
                if dist[d] and not (eg and c[d:i + 1].max() >= c[d] * (1 + eg)):
                    cnt += 1
            if cnt >= mx:
                held = False
                low_v, low_i = lo[i], i
        else:
            if lo[i] < low_v:
                low_v, low_i = lo[i], i
            ftd = (i - low_i >= fday) and ret[i] >= fret and v[i] > vprev[i]
            if ftd or (rs and c[i] > sma[i]):
                held = True
                since = i
        w[i] = 1.0 if held else 0.0
    return w


def _asof(df, values, idx):
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
    W = np.column_stack([_asof(candles[m], _weights(candles[m], p), idx) * each for m in markets]) \
        if markets else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    vr = {"prev": " on more volume than the candle before",
          "avg": f" on at least {float(p['volMult']):g} times the usual volume", "none": ""}[p["volRule"]]
    eg = float(p.get("expireGain") or 0)
    rs = int(p["reenterSma"] or 0)
    steps = [
        f"It holds {mk} by default and counts 'distribution days': {iv} candles that close at least "
        f"{pct(p['distRet'])} lower{vr}, a sign that big holders are selling.",
        f"Each one counts for {bars_text(p['window'], iv)}"
        + (f", or until the price has risen {pct(eg)} above it." if eg else "."),
        f"When {int(p['maxDist'])} or more are counted, it sells and waits.",
        f"It buys back on a 'follow-through day': at least {int(p['ftdDay'])} candles after the lowest point since "
        f"selling, a candle closes {pct(p['ftdRet'])} or more higher on rising volume"
        + (f", or when the price is back above its {bars_text(rs, iv)} average." if rs else "."),
    ]
    return {
        "summary": f"Holds {mk} until heavy-volume down days pile up, then waits for a strong up day after the low.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Tops that form slowly with repeated heavy selling, followed by a clear rebound day.",
        "whenItLoses": "Volatile bull markets with many sharp down days that don't end the trend, and crashes that "
                       "happen in one or two candles.",
    }
