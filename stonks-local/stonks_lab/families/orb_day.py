"""orb_day v1 (agent-10): opening-range breakout day trade, flat at the end of every session.

The classic stock day-trading rule, never tried by the fleet: the first ``rangeHours`` of a session (starting at
``startHour`` UTC each day) set the opening range. After it, buy when a candle closes above the range high by more
than ``buffer``; sell at the close of the session's last candle, or earlier when a candle closes back under the
range low (``stopAtLow``). At most one trade per session. Optional daily trend filter: only trade while the close is
above its average over ``trendDays`` days (computed on the intraday closes). Works on 15m/30m/1h/2h candles.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "orb_day"
VERSION = 1
TITLE = "Opening-range breakout day trade"
BOT_READY = False
MULTI_MARKET = False

H_MS = 3_600_000
D_MS = 86_400_000


def default_params() -> dict:
    return {"startHour": 0, "rangeHours": 2, "buffer": 0.0, "sessionHours": 24, "stopAtLow": True, "trendDays": 0}


def param_space() -> dict:
    return {
        "startHour": {"type": "int", "min": 0, "max": 23, "description": "UTC hour the session (and its range) starts"},
        "rangeHours": {"type": "int", "min": 1, "max": 8, "description": "hours that make the opening range"},
        "buffer": {"type": "float", "min": 0.0, "max": 0.03,
                   "description": "close must beat the range high by this fraction to buy"},
        "sessionHours": {"type": "int", "min": 6, "max": 24,
                         "description": "session length in hours; flat at its last candle's close"},
        "stopAtLow": {"type": "bool", "description": "also sell when a candle closes under the range low"},
        "trendDays": {"type": "int", "min": 5, "max": 300, "zero": True, "log": True,
                      "description": "only trade while the close is above its average over this many days (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["rangeHours"]) >= int(p["sessionHours"]):
        return "rangeHours must be shorter than the session"
    return None


def warmup(p: dict) -> int:
    return 24 * max(1, int(p.get("trendDays") or 0))


def _step_ms(ts: np.ndarray) -> int:
    if len(ts) < 2:
        return H_MS
    return int(np.median(np.diff(ts[: min(len(ts), 500)])))


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    ts = np.asarray(df.index, dtype=np.int64)
    step = _step_ms(ts)
    c = df["close"].to_numpy(np.float64)
    hi = df["high"].to_numpy(np.float64)
    lo = df["low"].to_numpy(np.float64)
    sh, rh, sess = int(p["startHour"]), int(p["rangeHours"]), int(p["sessionHours"])
    buf, stop = float(p["buffer"]), bool(p["stopAtLow"])
    td = int(p.get("trendDays") or 0)
    if td > 0:
        n = max(2, int(round(td * D_MS / step)))
        sm = ind.sma(c, n)
        trend = np.where(np.isfinite(sm), c > sm, False)
        trend_ok = np.isfinite(sm)
    else:
        trend = np.ones(len(c), dtype=bool)
        trend_ok = np.ones(len(c), dtype=bool)
    # position of each candle inside its session: session = day key from startHour; offset in ms
    rel = ts - sh * H_MS
    day = rel // D_MS
    off = rel - day * D_MS                      # candle open offset inside the day
    end_off = off + step                        # its close offset
    range_end, sess_end = rh * H_MS, sess * H_MS
    w = np.full(len(c), np.nan)
    cur_day, r_hi, r_lo, state, traded = None, -np.inf, np.inf, 0.0, False
    for i in range(len(c)):
        if day[i] != cur_day:
            cur_day, r_hi, r_lo, traded = day[i], -np.inf, np.inf, False
            state = 0.0
        if end_off[i] <= range_end:
            r_hi, r_lo = max(r_hi, hi[i]), min(r_lo, lo[i])
            if trend_ok[i]:
                w[i] = 0.0
            continue
        if not trend_ok[i]:
            continue
        if end_off[i] >= sess_end:              # last candle of the session (or after it): flat
            state = 0.0
        elif state == 1.0:
            if stop and c[i] < r_lo:
                state = 0.0
        elif (not traded) and np.isfinite(r_hi) and trend[i] and c[i] > r_hi * (1.0 + buf):
            state, traded = 1.0, True
        w[i] = state
    return frame(ts, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p = spec["params"]
    mk = market_names(spec)
    sh, rh, sess = int(p["startHour"]), int(p["rangeHours"]), int(p["sessionHours"])
    steps = [f"Each day at {sh:02d}:00 UTC a trading session of {sess} hours starts; its first {rh} hour"
             f"{'s' if rh > 1 else ''} set the opening range (highest high, lowest low).",
             f"After that it buys {mk} once when a candle closes above the range high"
             + (f" by more than {pct(p['buffer'])}." if float(p["buffer"]) > 0 else "."),
             "It sells at the close of the session's last candle"
             + (", or earlier when a candle closes back under the range low." if p["stopAtLow"] else ".")]
    if int(p.get("trendDays") or 0):
        steps.append(f"It only trades while the price is above its {int(p['trendDays'])}-day average.")
    return {
        "summary": f"Day trades {mk}: buys a breakout above the first {rh} hours' range, flat by the session end.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Trending days that keep going after breaking the morning range.",
        "whenItLoses": "Choppy days and false breakouts; every trade pays two fees (about 0.3 % round trip).",
    }
