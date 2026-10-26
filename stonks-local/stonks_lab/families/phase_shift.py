"""phase_shift v1 (agent-10): a fleet leader on daily candles that close at a chosen UTC hour, not at midnight.

Every daily result in the registry uses Bitvavo's 1d candles, which close at 00:00 UTC. That hour is arbitrary: a
trader could just as well decide every day at 08:00 or 16:00 UTC. If a daily leader's score depends on the decision
hour, part of its edge is sampling luck. This family tests that.

On 1h candles it builds daily candles that open at ``hour`` UTC (open = first hour, high/low = extremes, close = last
hour, volume = sum), runs a fixed preset (one of the fleet's daily leaders, params frozen) on them as interval 1d,
and places each day's decision at the close of that day's last hourly candle. Between decisions the targets are NaN
(no decision: the position is left alone), so it trades at most once a day like the original. ``hour`` 0 is the
native 1d candle. A day counts only once data reaches its last hour (an unfinished day is never used).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, risk_steps, union_index

NAME = "phase_shift"
VERSION = 1
TITLE = "Daily leader with a shifted daily close"
BOT_READY = False
MULTI_MARKET = True

H_MS = 3_600_000
D_MS = 86_400_000

PRESETS = {
    # plain SMA 130-day trend core (stale exit off)
    "sma130": ("stale_trend", {"coreLen": 130, "hiLook": 60, "staleBars": 0}),
    # froth_dip BTC 1d leader eb8cc3e816
    "froth_dip": ("froth_dip", {"breadthMin": 0.85, "coreSma": 132, "frothBand": 0.05, "frothLook": 120,
                                "frothThr": 0.1, "maxHold": 97, "rsiBelow": 36.5, "rsiPeriod": 12, "sellAbove": 85}),
    # vote_blend ETH 1d lead 0707d81578 (MACD 12/182/30 + alt-froth calm, averaged)
    "vote_blend": ("vote_blend", {"breadthMin": 0.85, "coreSma": 132, "frothBand": 0.05, "frothLook": 120,
                                  "frothThr": 0.1, "macdFast": 12, "macdSignal": 30, "macdSlow": 182, "maxHold": 90,
                                  "mode": "avg", "panic": "off", "rsiBelow": 37, "rsiPeriod": 25, "sellAbove": 85,
                                  "useCore": False, "useFroth": True, "useMacd": True}),
    # turnover_panic BTC+ETH 1d plateau 041809012e
    "turnover_panic": ("turnover_panic", {"coreSma": 132, "dropLook": 7, "dropMin": 0.15, "extend": False,
                                          "holdBars": 97, "source": "own", "volLook": 90, "volMult": 3}),
    # alt_froth BTC 1d lead be006bebdb
    "alt_froth": ("alt_froth", {"band": 0.05, "lookback": 120, "minOut": 0, "threshold": 0.1, "trendSma": 0}),
    # macd_trend ETH 1d 12/182/30 (the 'cliff' of finding #31)
    "macd": ("macd_trend", {"fast": 12, "slow": 182, "signal": 30, "requirePositive": False}),
    # core_dip BTC 1d lead 56686c4a38 (pair scope: BTC+ETH data only)
    "core_dip": ("core_dip", {"coreSma": 58, "maxHold": 86, "rsiBelow": 37.2934, "rsiPeriod": 25, "scope": "pair",
                              "sellAbove": 44.5613}),
    # vol_panic_core BTC 1d lead 003cf11da9 (BTC+ETH data only)
    "vol_panic": ("vol_panic_core", {"coreBand": 0, "coreLen": 130, "coreType": "sma", "dropLook": 6,
                                     "dropMin": 0.08, "holdBars": 98, "source": "both", "volLong": 41,
                                     "volRatio": 1.15, "volShort": 8}),
    # dmi_core ETH 1d peak 9a155f9d0d
    "dmi": ("dmi_core", {"diBand": 0, "dmiLen": 13, "entryAdx": 25, "exitAdx": 25}),
}
# froth family (wave 7): 1h candles of the 2019 alt pool are now in the lab.
PRESETS.update({
    # flow_froth BTC+ETH 1d 40e5de771a
    "flow_froth": ("flow_froth", {"baseLen": 365, "lookback": 180, "minOut": 0, "mode": "and", "threshold": 0.1,
                                  "turnLen": 30, "zMin": 0.1}),
})
# Presets of 12h leaders: candles of PERIOD_H hours that open at ``hour`` and ``hour + 12`` UTC (so hours h and
# h + 12 are the same spec; 0-11 cover every phase).
PRESETS_12H = {
    # froth_dip BTC 12h leader b488d9dfab
    "froth_dip12": ("froth_dip", {"breadthMin": 0.85, "coreSma": 264, "frothBand": 0.05, "frothLook": 240,
                                  "frothThr": 0.1, "maxHold": 194, "rsiBelow": 36.5, "rsiPeriod": 16,
                                  "sellAbove": 85}),
    # froth_bag BTC 12h 4d5f46d25c
    "froth_bag12": ("froth_bag", {"breadthMin": 0.85, "coreSma": 264, "frothBand": 0.05, "frothLook": 240,
                                  "frothThr": 0.1, "maxHold": 194, "members": 16, "rsiBelow": 36.5, "rsiPeriod": 16,
                                  "sellAbove": 85, "spread": 0.2, "step": 0.25}),
    # vote_blend ETH 12h 1c9e929a89
    "vote_blend12": ("vote_blend", {"breadthMin": 0.85, "coreSma": 264, "frothBand": 0.05, "frothLook": 240,
                                    "frothThr": 0.1, "macdFast": 24, "macdSignal": 60, "macdSlow": 364, "maxHold": 90,
                                    "mode": "avg", "panic": "off", "rsiBelow": 37, "rsiPeriod": 25, "sellAbove": 85,
                                    "useCore": False, "useFroth": True, "useMacd": True}),
}
PRESETS.update(PRESETS_12H)


def period_hours(preset: str) -> int:
    """Candle length of a preset in hours (24 = daily, 12 for the 12h leaders)."""
    return 12 if preset in PRESETS_12H else 24


def default_params() -> dict:
    return {"preset": "sma130", "hour": 0}


def param_space() -> dict:
    return {
        "preset": {"type": "choice", "values": list(PRESETS),
                   "description": "which fleet leader runs (its params are frozen)"},
        "hour": {"type": "int", "min": 0, "max": 23,
                 "description": "UTC hour at which each daily candle opens and the previous one closes"},
    }


def _inner(spec: dict) -> tuple:
    name, params = PRESETS[spec["params"]["preset"]]
    fam = get_family(name)
    iv = "12h" if period_hours(spec["params"]["preset"]) == 12 else "1d"
    inner = normalize_spec({"family": name, "markets": list(spec.get("markets") or []), "interval": iv,
                            "params": dict(params), "risk": {"maxWeight": max_weight(spec)}}, fam)
    return fam, inner


def warmup(p: dict) -> int:
    name, params = PRESETS[p["preset"]]
    fam = get_family(name)
    return period_hours(p["preset"]) * (int(fam.warmup({**fam.default_params(), **params})) + 2)


def required_markets(spec: dict) -> list[str]:
    fam, inner = _inner(spec)
    return fam.markets_needed(inner)


def daily_candles(df: pd.DataFrame, hour: int, period: int = 24) -> tuple[pd.DataFrame, np.ndarray]:
    """Daily (or ``period``-hour) candles opening at ``hour`` UTC from 1h candles; plus each candle's last-hour
    timestamp (decision time).

    A candle is kept only when the data reaches its last hour (so an unfinished one is never used)."""
    ts = np.asarray(df.index, dtype=np.int64)
    if len(ts) == 0:
        return df.iloc[:0], np.zeros(0, dtype=np.int64)
    P_MS = period * H_MS
    hour = hour % period
    key = (ts - hour * H_MS) // P_MS
    g = df.groupby(key, sort=True)
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    k = out.index.to_numpy(np.int64)
    last_hour = k * P_MS + hour * H_MS + (period - 1) * H_MS
    keep = last_hour <= ts[-1]
    out = out[keep]
    out.index = pd.Index(k[keep] * P_MS + hour * H_MS, name="ts")
    return out, last_hour[keep]


def targets(candles, spec, start_time=None):
    p = spec["params"]
    hour = int(p["hour"])
    period = period_hours(p["preset"])
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    fam, inner = _inner(spec)
    daily, decide_at = {}, None
    for m in fam.markets_needed(inner):
        if m not in candles:
            continue
        d, last = daily_candles(candles[m], hour, period)
        daily[m] = d
        if m == markets[0]:
            decide_at = pd.Series(last, index=d.index)
    w = fam.targets(daily, inner)
    out = {m: np.full(len(idx), np.nan) for m in markets}
    if decide_at is None or len(w) == 0:
        return frame(idx, out)
    # decision of the candle opening at ts D is known at D + (period-1)h (close of its last hourly candle)
    dts = np.asarray(w.index, dtype=np.int64) + (period - 1) * H_MS
    pos = np.searchsorted(idx, dts, side="left")
    ok = pos < len(idx)
    for m in markets:
        col = w[m].to_numpy(np.float64) if m in w.columns else np.zeros(len(w))
        arr = out[m]
        arr[pos[ok]] = col[ok]
    return frame(idx, out)


def explain(spec) -> dict:
    p = spec["params"]
    name, _ = PRESETS[p["preset"]]
    try:
        fam, inner = _inner(spec)
        inner_ex = fam.explain(inner)
        inner_steps = list(inner_ex.get("howItWorks") or [])[:4]
        wins, loses = inner_ex.get("whenItWins", ""), inner_ex.get("whenItLoses", "")
    except Exception:  # pragma: no cover - explanation must never break publishing
        inner_steps, wins, loses = [], "", ""
    mk = market_names(spec)
    steps = [f"It runs the fleet strategy '{name}' on {mk} with fixed settings, on daily candles.",
             (f"Its days start and end at {int(p['hour']):02d}:00 UTC instead of midnight, so it decides once a day "
              "at that hour." if period_hours(p["preset"]) == 24 else
              f"Its 12-hour candles start at {int(p['hour']) % 12:02d}:00 and {int(p['hour']) % 12 + 12:02d}:00 UTC "
              "instead of 00:00 and 12:00, so it decides twice a day at those hours."), *inner_steps]
    return {
        "summary": f"The daily strategy '{name}' on {mk}, deciding at {int(p['hour']):02d}:00 UTC each day.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": wins or "Same as the daily strategy it wraps.",
        "whenItLoses": loses or "Same as the daily strategy it wraps; plus luck in the hour it decides.",
    }
