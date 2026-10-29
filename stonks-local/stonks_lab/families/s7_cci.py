"""s7_cci: Dip and breakout with a daily CCI washout dip, confirmed by the daily CMO.

Built on s6_hourbars (Session 6 #1, 1h candles): breakout ride with banking, snap dip, slow dip and slow MACD ride,
all unchanged. New here is one layer:
  ddip   a multi-day washout: when the ddip_days-day CCI (TAAPI cci on completed daily candles) is deeply negative
         AND the same-length Chande Momentum Oscillator (TAAPI cmo) is oversold too, buy s_ddip; sell when the daily
         CCI is back at ddip_out. The hourly dips catch hour-long panics; this one catches the week-long sell-offs
         that bounce, which the hourly dips sell too early and the rides only rejoin at a new high.
Normalized readings come from _ta.compute: CCI/200 (so -1.3 = CCI -260), CMO (CMO/100) x 1.8 (so -0.8 = CMO -44).
The book holds the largest position any layer asks for. Strictly causal (daily readings are used from the first
bar after the day closes).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import STRETCH, compute

NAME = "s7_cci"
VERSION = 1
TITLE = "Dip and breakout CCI"
BOT_READY = False
MULTI_MARKET = False
INTERVAL = "1h"

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0
STEP = 0.25
GATE = "cmo"   # the daily dip's confirming oscillator


def default_params() -> dict:
    return {
        "s_break": 1.0, "s_snap": 1.0, "s_vdip": 1.0, "s_macd": 1.0, "s_ddip": 0.75,
        "high_days": 27.0, "giveback": 3.6, "hvol_days": 11.0, "target_vol": 0.6,
        "take_gain": 0.15, "take_frac": 0.5,
        "snap_hours": 4.0, "snap_vol_days": 55.0, "z_up": 3.3, "z_down": 4.4, "snap_trend_days": 60.0,
        "exit_rsi": 50.0,
        "vdip_hours": 40.0, "vdip_z": 2.2,
        "macd_days": 26.0, "stretch": 1.0, "macd_vol": 0.45,
        "ddip_days": 20.0, "ddip_buy": -1.3, "ddip_out": 0.3, "ddip_cmo": -0.8,
    }


def param_space() -> dict:
    share = lambda what: {"type": "float", "min": 0.0, "max": 1.0, "description": f"position the {what} layer takes (0 = off)"}  # noqa: E731
    return {
        "s_break": share("breakout ride"),
        "s_snap": share("oversold snap"),
        "s_vdip": share("slow dip"),
        "s_macd": share("MACD ride"),
        "s_ddip": share("daily CCI washout dip"),
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends this many daily swings below its peak"},
        "hvol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history that set the daily swing of the ride exit"},
        "target_vol": {"type": "float", "min": 0.1, "max": 3.0, "description": "yearly volatility a full ride may carry; wilder coins ride smaller"},
        "take_gain": {"type": "float", "min": 0.02, "max": 2.0, "description": "log gain of a ride (peak over buy) at which part of it is banked; again at twice it"},
        "take_frac": {"type": "float", "min": 0.0, "max": 0.9, "description": "share of what still rides that each of the two banking steps sells"},
        "snap_hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the snap sell-off and of its exit RSI"},
        "snap_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the snap's normal move"},
        "z_up": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves above the daily trend"},
        "z_down": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves below the daily trend"},
        "snap_trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend that sets the snap depth"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level that sells the snap"},
        "vdip_hours": {"type": "float", "min": 6.0, "max": 240.0, "description": "hours in the average the slow dip is measured against"},
        "vdip_z": {"type": "float", "min": 0.5, "max": 5.0, "description": "volatility units under that average that buy the slow dip"},
        "macd_days": {"type": "float", "min": 10.0, "max": 60.0, "description": "days in the MACD ride"},
        "stretch": {"type": "float", "min": 0.0, "max": 1.2, "description": "how high the MACD histogram must have been before a cross under zero sells"},
        "macd_vol": {"type": "float", "min": 0.0, "max": 3.0, "description": "yearly volatility a full MACD ride may carry (0 = always its full share)"},
        "ddip_days": {"type": "float", "min": 5.0, "max": 60.0, "description": "days in the daily CCI and CMO of the washout dip"},
        "ddip_buy": {"type": "float", "min": -1.5, "max": -0.2, "description": "daily CCI/200 at or under which the washout dip buys (-1.3 = CCI -260)"},
        "ddip_out": {"type": "float", "min": -1.0, "max": 1.2, "description": "daily CCI/200 at which the washout dip sells"},
        "ddip_cmo": {"type": "float", "min": -1.5, "max": 1.5, "description": "the washout dip only buys while the daily CMO (x1.8/100) is at or under this (1.5 = always)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["ddip_out"]) <= float(p["ddip_buy"]):
        return "ddip_out must be above ddip_buy, or the washout dip would sell the day it buys"
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, BASE_DAYS, 3 * float(p["macd_days"]),
                   2 * float(p["ddip_days"]) + 2) * 24)


def _step(index) -> float:
    ts = np.asarray(index, dtype=np.int64)
    return max(float(np.median(np.diff(ts))), 1.0) if len(ts) > 1 else 3_600_000.0


def _bars(step: float, hours: float) -> int:
    return max(2, int(round(hours * _HOUR / step)))


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(x).ewm(span=max(1, int(span)), adjust=False).mean().to_numpy(np.float64)


def _prev_day_ema(ts: np.ndarray, c: np.ndarray, days: float) -> np.ndarray:
    """EMA of completed daily closes (UTC days), known from the first bar of the next day."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    e = ind.ema(dc, max(2, int(round(days))))
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, e[np.clip(pos, 0, None)], np.nan)


def _daily(ts, df, name, n) -> np.ndarray:
    """TAAPI ``name`` (normalized like _ta) on completed UTC daily candles, known from the first bar of the next day."""
    d = ts // _DAY
    g = pd.DataFrame({"d": d, "o": df["open"].to_numpy(np.float64), "h": df["high"].to_numpy(np.float64),
                      "l": df["low"].to_numpy(np.float64), "c": df["close"].to_numpy(np.float64),
                      "v": df["volume"].to_numpy(np.float64)}).groupby("d", sort=True)
    day = pd.DataFrame({"open": g["o"].first(), "high": g["h"].max(), "low": g["l"].min(), "close": g["c"].last(),
                        "volume": g["v"].sum()})
    x = compute(name, day, n)
    pos = np.searchsorted(day.index.to_numpy(), d, side="left") - 1
    return np.where(pos >= 0, x[np.clip(pos, 0, None)], np.nan)


def _breakout(lc, step, size, p) -> np.ndarray:
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    give, tg, tf = float(p["giveback"]), float(p["take_gain"]), float(p["take_frac"])
    w = np.zeros(n)
    ride = level = 0
    peak = entry = sz = 0.0
    ll, hl, sl, zl = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist()
    for i in range(n):
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i] and zl[i] > 0:
                ride, peak, entry, level, sz = 1, ll[i], ll[i], 0, zl[i]
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * sl[i]:
                ride = 0
            else:
                while level < 2 and peak - entry >= tg * (level + 1):
                    level += 1
        w[i] = sz * (1.0 - tf) ** level if ride else 0.0
    return w


def _snap(ts, c, lc, step, p) -> np.ndarray:
    n = len(c)
    per_hour = _HOUR / step
    k = max(1, int(round(float(p["snap_hours"]) * per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    r1 = np.r_[np.nan, np.diff(lc)]
    sig = np.sqrt(pd.Series(r1 * r1).ewm(span=span, min_periods=span).mean().to_numpy())
    dk = np.full(n, np.nan)
    if n > k:
        dk[k:] = lc[k:] - lc[:-k]
    z = dk / (sig * np.sqrt(k))
    rsi = ind.rsi(c, max(2, k))
    trend = lc - np.log(_prev_day_ema(ts, c, float(p["snap_trend_days"])))
    zu, zd, er = float(p["z_up"]), float(p["z_down"]), float(p["exit_rsi"])
    w = np.zeros(n)
    held = False
    zl, rl, tl = z.tolist(), rsi.tolist(), trend.tolist()
    for i in range(n):
        zi, ri, ti = zl[i], rl[i], tl[i]
        if zi == zi and ri == ri and ti == ti:
            if not held:
                if zi < -(zu if ti > 0.0 else zd):
                    held = True
            elif ri > er:
                held = False
        w[i] = 1.0 if held else 0.0
    return w


def _vdip(c, lc, step, vol, p) -> np.ndarray:
    n = len(c)
    nb = _bars(step, float(p["vdip_hours"]))
    z = (lc - np.log(_ema(c, nb))) / (vol * np.sqrt(nb))
    dz = float(p["vdip_z"])
    w = np.zeros(n)
    rev = False
    zl = z.tolist()
    for i in range(_bars(step, 24.0 * BASE_DAYS), n):
        if rev:
            if zl[i] > 0:
                rev = False
        elif zl[i] < -dz:
            rev = True
        w[i] = 1.0 if rev else 0.0
    return w


def _macd(df, lc, step, p) -> np.ndarray:
    reading = compute("macd", df, max(2, int(round(float(p["macd_days"]) * _DAY / step))))
    level = float(p["stretch"])
    w = np.zeros(len(reading))
    held = False
    peak, prev = -1e9, np.nan
    for i, v in enumerate(np.asarray(reading, float).tolist()):
        if v != v:
            prev = np.nan
            continue
        if not held:
            if v > 0.0 and not (prev > 0.0):
                held, peak = True, v
        else:
            peak = max(peak, v)
            if prev > 0.0 and v <= 0.0 and peak >= level:
                held, peak = False, -1e9
        w[i] = 1.0 if held else 0.0
        prev = v
    return w


def _ddip(dc, gate, p) -> np.ndarray:
    """In when the daily CCI is at or under ddip_buy and the gate oscillator is oversold; out at ddip_out."""
    b, ex, gm = float(p["ddip_buy"]), float(p["ddip_out"]), float(p["ddip_cmo"])
    gl = gate.tolist()
    w = np.zeros(len(dc))
    held = False
    for i, v in enumerate(dc.tolist()):
        if v == v:
            if not held:
                held = v <= b and gl[i] <= gm
            elif v >= ex:
                held = False
        w[i] = 1.0 if held else 0.0
    return w


LAYERS = ("break", "snap", "vdip", "macd", "ddip")


def layer_weights(df, p) -> dict[str, np.ndarray]:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    out = {k: np.zeros(n) for k in LAYERS}
    if n < 3:
        return out
    step = _step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_bars(step, 24.0 * 365.0))
    size = np.floor(np.clip(float(p["target_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP
    if float(p["s_break"]) > 0:
        out["break"] = _breakout(lc, step, size, p) * float(p["s_break"])
    if float(p["s_snap"]) > 0:
        out["snap"] = _snap(ts, c, lc, step, p) * float(p["s_snap"])
    if float(p["s_vdip"]) > 0:
        out["vdip"] = _vdip(c, lc, step, vol, p) * float(p["s_vdip"])
    if float(p["s_macd"]) > 0:
        ms = float(p["s_macd"])
        if float(p["macd_vol"]) > 0:
            ms = np.minimum(ms, np.floor(np.clip(float(p["macd_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP)
        out["macd"] = _macd(df, lc, step, p) * ms
    if float(p["s_ddip"]) > 0:
        nd = max(2, int(round(float(p["ddip_days"]))))
        out["ddip"] = _ddip(_daily(ts, df, "cci", nd), _daily(ts, df, GATE, nd), p) * float(p["s_ddip"])
    return out


def _weights(df, p) -> np.ndarray:
    lw = layer_weights(df, p)
    w = np.zeros(len(df))
    for k in LAYERS:
        w = np.maximum(w, lw[k])
    return np.clip(w, 0.0, 1.0)


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    w = _weights(df, spec["params"])
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    pct = lambda k: f"{round(100 * float(p[k]))} %"  # noqa: E731
    steps = [f"Decides once an hour, on 1-hour candles of {mk}."]
    if float(p["s_break"]) > 0:
        steps.append(
            f"Ride: a close above the highest close of the last {p['high_days']:g} days buys up to {pct('s_break')}, "
            f"scaled down to {p['target_vol']:g} divided by the coin's yearly volatility. It ends when price falls "
            f"{p['giveback']:g} daily swings below its best since the buy.")
        if float(p["take_frac"]) > 0:
            g = float(p["take_gain"])
            steps.append(f"Banking: at {(np.exp(g) - 1) * 100:.0f} % and {(np.exp(2 * g) - 1) * 100:.0f} % above the "
                         f"buy, {pct('take_frac')} of what still rides is sold.")
    if float(p["s_snap"]) > 0:
        steps.append(
            f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves ({p['z_down']:g} under the "
            f"{p['snap_trend_days']:g}-day trend) buys {pct('s_snap')}; it sells when the {p['snap_hours']:g}-hour RSI "
            f"tops {p['exit_rsi']:g}.")
    if float(p["s_vdip"]) > 0:
        steps.append(f"Slow dip: {p['vdip_z']:g} volatility units under the {p['vdip_hours']:g}-hour average buys "
                     f"{pct('s_vdip')}; it sells once price is back at that average.")
    if float(p["s_macd"]) > 0:
        cap = (f", at most {p['macd_vol']:g} divided by the coin's yearly volatility" if float(p["macd_vol"]) > 0 else "")
        steps.append(f"MACD ride: {pct('s_macd')}{cap} while the {p['macd_days']:g}-day MACD is positive, sold on a "
                     f"cross under zero after it reached {p['stretch']:g}.")
    if float(p["s_ddip"]) > 0:
        cmo = 100 * float(p["ddip_cmo"]) / STRETCH.get(GATE, 1.0)
        steps.append(
            f"Washout dip: when the {p['ddip_days']:g}-day CCI of daily candles is at or under "
            f"{200 * float(p['ddip_buy']):+.0f} and the {p['ddip_days']:g}-day Chande momentum is at or under "
            f"{cmo:+.0f} (a sell-off that has run for days), buy {pct('s_ddip')}. Sell when that CCI is back at "
            f"{200 * float(p['ddip_out']):+.0f}.")
    steps.append("The book holds the largest position any layer asks for.")
    return {
        "summary": (f"Dip and breakout on {mk}, hourly: rides breakouts and a slow MACD trend with volatility-sized "
                    "positions, buys hour-long panic dips for the bounce, and buys multi-day washouts that the daily "
                    "CCI and Chande momentum call oversold."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long climbs that keep making new highs, panic flushes that bounce within hours, and week-long "
                      "sell-offs that turn back up.",
        "whenItLoses": "Breakouts that fail right after the buy, and crashes that keep falling after the daily CCI "
                       "is already deeply oversold.",
    }
