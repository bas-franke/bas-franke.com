"""s6_relbtc: judge every coin against bitcoin.

Built on s5_union3 (breakout ride sized by volatility, oversold snap, slow dip). On top of it, each altcoin is read
against BTC-EUR (loaded with ``..data`` and sampled causally: the BTC candle with the same or an earlier open time):
  rel ride   ride the coin while it is beating BTC (its price ratio to BTC is well above its own average) and BTC
             itself is not falling (BTC above its daily trend)
  rel dip    buy when the coin has fallen much further than BTC over a few hours (an over-reaction, measured in
             the ratio's own normal moves); sell on the RSI bounce or when the gap has closed
  catch-up   buy (75 %) when the coin's price in BTC is far below its own average (it fell much further than BTC
             over weeks) while BTC is not falling; sell when the ratio is back at its average or BTC turns down
  lag veto   no breakout ride while BTC is falling (with veto_rs=99 the coin's lag is not needed)
Searched in Session 6: the relative ride and the few-hour relative dip lost points and are off (size 0); the
catch-up layer and the veto are what earned their place.
For BTC itself the book is the plain s5_union3 rules. Strictly causal.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import data
from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s6_relbtc"
VERSION = 1
TITLE = "Judged against bitcoin"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0
STEP = 0.25
BTC = "BTC-EUR"


def default_params() -> dict:
    return {
        "high_days": 27.0, "giveback": 3.0, "hvol_days": 8.25, "target_vol": 0.6,
        "snap_hours": 4.0, "snap_vol_days": 48.0, "z_up": 3.2, "z_down": 5.3, "snap_trend_days": 60.0,
        "exit_rsi": 55.0,
        "vdip_hours": 50.0, "vdip_z": 2.2,
        # against BTC
        "btc_days": 35.0, "btc_tol": 0.0,
        "rs_days": 20.0, "rs_vol_days": 30.0, "rs_in": 1.5, "rs_out": 0.0, "rel_size": 0.0,
        "rd_hours": 12.0, "rd_z": 3.0, "rd_on": 0.0,
        "veto_rs": 99.0, "veto_on": 1.0,
        "rd_gap_exit": 0.0, "veto_dips": 0.0, "veto_btc": 1.0, "idio_z": 99.0,
        "rv_in": -4.0, "rv_out": 0.0, "rv_size": 0.75,
    }


def param_space() -> dict:
    return {
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends this many daily swings below its peak"},
        "hvol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history that set the daily swing of the ride exit"},
        "target_vol": {"type": "float", "min": 0.1, "max": 2.0, "description": "yearly volatility a full ride may carry; wilder coins ride smaller"},
        "snap_hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the snap sell-off and of its exit RSI"},
        "snap_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the snap's normal move"},
        "z_up": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves above the daily trend"},
        "z_down": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves below the daily trend"},
        "snap_trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend that sets the snap depth"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level that sells the snap and the relative dip"},
        "vdip_hours": {"type": "float", "min": 6.0, "max": 240.0, "description": "hours in the average the slow dip is measured against"},
        "vdip_z": {"type": "float", "min": 0.5, "max": 5.0, "description": "volatility units under that average that buy the slow dip"},
        "btc_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in BTC's daily trend; BTC above it is 'not falling'"},
        "btc_tol": {"type": "float", "min": -0.3, "max": 0.3, "description": "BTC may sit this far (log) under its trend and still count as not falling"},
        "rs_days": {"type": "float", "min": 2.0, "max": 200.0, "description": "days in the average of the coin/BTC ratio"},
        "rs_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history behind the ratio's daily swing"},
        "rs_in": {"type": "float", "min": -5.0, "max": 10.0, "description": "the coin beats BTC when the ratio is this many daily swings above its average"},
        "rs_out": {"type": "float", "min": -10.0, "max": 10.0, "description": "the relative ride ends when the ratio drops under this many swings"},
        "rel_size": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the volatility-sized ride the relative ride takes (0 = off)"},
        "rd_hours": {"type": "float", "min": 1.0, "max": 96.0, "description": "hours over which the coin's fall is compared with BTC's"},
        "rd_z": {"type": "float", "min": 1.0, "max": 10.0, "description": "the coin must fall this many ratio moves further than BTC"},
        "rd_on": {"type": "float", "min": 0.0, "max": 1.0, "description": "size of the relative dip (0 = off)"},
        "veto_rs": {"type": "float", "min": -10.0, "max": 99.0, "description": "the coin lags when the ratio is under this many swings"},
        "veto_on": {"type": "float", "min": 0.0, "max": 1.0, "description": "1 = no breakout ride while the coin lags a falling BTC"},
        "rd_gap_exit": {"type": "float", "min": -10.0, "max": 99.0, "description": "the relative dip also sells when the gap to BTC is back above this (99 = RSI only)"},
        "veto_dips": {"type": "float", "min": 0.0, "max": 1.0, "description": "1 = the lag veto also blocks the slow dip"},
        "veto_btc": {"type": "float", "min": 0.0, "max": 1.0, "description": "1 = the veto needs BTC falling, 0 = lagging BTC is enough"},
        "rv_in": {"type": "float", "min": -10.0, "max": 0.0, "description": "catch-up: the coin lags a rising BTC by this many ratio swings (buy)"},
        "rv_out": {"type": "float", "min": -10.0, "max": 10.0, "description": "catch-up ends when the ratio is back above this many swings"},
        "rv_size": {"type": "float", "min": 0.0, "max": 1.0, "description": "size of the catch-up position (0 = off)"},
        "idio_z": {"type": "float", "min": 1.0, "max": 99.0, "description": "skip snap and slow dips when the coin fell this many ratio moves more than BTC (99 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["rs_out"]) > float(p["rs_in"]):
        return "rs_out must not be above rs_in"
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, BASE_DAYS, float(p["btc_days"]) + 1,
                   float(p["rs_days"]), float(p["rs_vol_days"])) * 96)


def _step(index) -> float:
    ts = np.asarray(index, dtype=np.int64)
    return max(float(np.median(np.diff(ts))), 1.0) if len(ts) > 1 else 900_000.0


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


def _prev_day_close(ts: np.ndarray, c: np.ndarray) -> np.ndarray:
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, dc[np.clip(pos, 0, None)], np.nan)


def _breakout(lc, step, p) -> np.ndarray:
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    give = float(p["giveback"])
    w = np.zeros(n)
    ride = 0
    peak = 0.0
    ll, hl, sl = lc.tolist(), hi.tolist(), day_sd.tolist()
    for i in range(n):
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i]:
                ride = 1
                peak = ll[i]
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * sl[i]:
                ride = 0
        w[i] = ride
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


def _slow_dip(c, lc, step, p):
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_bars(step, 24.0 * 365.0))
    size = np.floor(np.clip(float(p["target_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP
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
    return w, size


def _interval(step: float) -> str:
    return "1h" if abs(step - _HOUR) < 1.0 else "15m"


def btc_close(ts: np.ndarray, step: float) -> np.ndarray:
    """BTC-EUR close of the candle with the same (or the latest earlier) open time: known when the coin's bar closes."""
    b = data.load_candles(BTC, _interval(step))
    if len(ts):
        b = b[np.asarray(b.index, dtype=np.int64) <= int(ts[-1])]   # never read BTC past the coin's last bar
    bts = np.asarray(b.index, dtype=np.int64)
    bc = b["close"].to_numpy(np.float64)
    pos = np.searchsorted(bts, ts, side="right") - 1
    out = np.where(pos >= 0, bc[np.clip(pos, 0, None)], np.nan)
    return out


def is_btc(ts: np.ndarray, c: np.ndarray, step: float) -> bool:
    """True when these candles are BTC-EUR's own (the scorer does not pass the market name)."""
    b = btc_close(ts, step)
    m = min(len(c), 2000)
    if m == 0:
        return True
    a, bb = c[:m], b[:m]
    ok = np.isfinite(bb)
    return bool(ok.any() and np.mean(np.abs(a[ok] - bb[ok]) <= 1e-9 * np.maximum(np.abs(a[ok]), 1.0)) > 0.95)


def _relative(ts, c, lc, step, p):
    """Relative ride (0/1), relative dip (0/1) and the lag veto (True = lagging a falling BTC)."""
    n = len(c)
    bcl = btc_close(ts, step)
    bok = np.isfinite(bcl) & (bcl > 0)
    bcl = np.where(bok, bcl, np.nan)
    bcl = pd.Series(bcl).ffill().to_numpy()
    blc = np.log(np.maximum(np.nan_to_num(bcl, nan=1.0), 1e-12))
    valid = np.isfinite(bcl)
    # BTC not falling: its last completed daily close vs its daily EMA
    bema = _prev_day_ema(ts, np.nan_to_num(bcl, nan=1.0), float(p["btc_days"]))
    bprev = _prev_day_close(ts, np.nan_to_num(bcl, nan=1.0))
    btc_up = (np.log(bprev) - np.log(bema)) > -float(p["btc_tol"])
    # the coin/BTC ratio, in its own daily swings
    rs = lc - blc
    dr = np.r_[0.0, np.diff(rs)]
    var_rs = _ema(dr * dr, _bars(step, 24.0 * float(p["rs_vol_days"])))
    day_sd = np.sqrt(np.maximum(var_rs * _bars(step, 24.0), 1e-12))
    zrs = (rs - _ema(rs, _bars(step, 24.0 * float(p["rs_days"])))) / day_sd
    # relative dip: the coin's fall minus BTC's fall over rd_hours, in ratio moves
    k = _bars(step, float(p["rd_hours"]))
    gap = np.full(n, np.nan)
    own = np.full(n, np.nan)
    if n > k:
        gap[k:] = rs[k:] - rs[:-k]
        own[k:] = lc[k:] - lc[:-k]
    zg = gap / np.sqrt(np.maximum(var_rs * k, 1e-18))
    rsi = ind.rsi(c, max(2, _bars(step, float(p["snap_hours"]))))
    warm = _bars(step, 24.0 * max(float(p["rs_vol_days"]), float(p["rs_days"]), 10.0))
    rin, rout, rdz, er, vr = float(p["rs_in"]), float(p["rs_out"]), float(p["rd_z"]), float(p["exit_rsi"]), float(p["veto_rs"])
    rge, vb, iz = float(p["rd_gap_exit"]), float(p["veto_btc"]) >= 0.5, float(p["idio_z"])
    ride = np.zeros(n)
    dip = np.zeros(n)
    veto = np.zeros(n, dtype=bool)
    idio = np.zeros(n, dtype=bool)
    rv = np.zeros(n)
    cu = False
    rvi, rvo = float(p["rv_in"]), float(p["rv_out"])
    on = d = False
    zl, gl, ol, rl, ul, vl = zrs.tolist(), zg.tolist(), own.tolist(), rsi.tolist(), btc_up.tolist(), valid.tolist()
    for i in range(warm, n):
        if not vl[i]:
            on = d = False
            continue
        zi, up = zl[i], ul[i]
        if not on:
            if up and zi > rin:
                on = True
        elif (not up) or zi < rout:
            on = False
        gi, oi, ri = gl[i], ol[i], rl[i]
        if not d:
            if gi == gi and oi == oi and gi < -rdz and oi < 0.0:
                d = True
        elif (ri == ri and ri > er) or (gi == gi and gi > rge):
            d = False
        if not cu:
            if up and zi < rvi:
                cu = True
        elif (not up) or zi > rvo:
            cu = False
        rv[i] = 1.0 if cu else 0.0
        ride[i] = 1.0 if on else 0.0
        dip[i] = 1.0 if d else 0.0
        veto[i] = ((not up) or not vb) and zi < vr
        idio[i] = gi == gi and gi < -iz
    return ride, dip, veto, idio, rv


def layer_weights(df, p, market: str = BTC) -> dict[str, np.ndarray]:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    keys = ("break", "snap", "vdip", "rel", "rdip", "rv")
    if n < 3:
        return {k: np.zeros(n) for k in keys}
    step = _step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    vdip, size = _slow_dip(c, lc, step, p)
    brk = _breakout(lc, step, p) * size
    out = {"break": brk, "snap": _snap(ts, c, lc, step, p), "vdip": vdip, "rel": np.zeros(n), "rdip": np.zeros(n), "rv": np.zeros(n)}
    if not is_btc(ts, c, step):
        ride, dip, veto, idio, rv = _relative(ts, c, lc, step, p)
        out["rv"] = rv * float(p["rv_size"])
        if float(p["veto_on"]) >= 0.5:
            out["break"] = np.where(veto, 0.0, brk)
            if float(p["veto_dips"]) >= 0.5:
                out["vdip"] = np.where(veto, 0.0, out["vdip"])
        if float(p["idio_z"]) < 50:
            out["snap"] = np.where(idio, 0.0, out["snap"])
            out["vdip"] = np.where(idio, 0.0, out["vdip"])
        out["rel"] = ride * size * float(p["rel_size"])
        out["rdip"] = dip * float(p["rd_on"])
    return out


def _weights(df, p, market: str = BTC) -> np.ndarray:
    lw = layer_weights(df, p, market)
    w = lw["break"]
    for k in ("snap", "vdip", "rel", "rdip", "rv"):
        w = np.maximum(w, lw[k])
    return np.clip(w, 0.0, 1.0)


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    w = _weights(df, spec["params"], m)
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    steps = [
        f"Ride: a close above the highest close of the last {p['high_days']:g} days buys, until price falls "
        f"{p['giveback']:g} daily swings below its best since the buy. Size: {p['target_vol']:g} / yearly volatility.",
        f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves ({p['z_down']:g} under the "
        f"{p['snap_trend_days']:g}-day trend) buys all in; it sells when the RSI tops {p['exit_rsi']:g}.",
        f"Slow dip: {p['vdip_z']:g} volatility units under the {p['vdip_hours']:g}-hour average buys; sold back at it.",
    ]
    if float(p["rel_size"]) > 0:
        steps.append(f"Beats bitcoin: when the coin's price in BTC is {p['rs_in']:g} daily swings above its "
                     f"{p['rs_days']:g}-day average and BTC is above its {p['btc_days']:g}-day trend, the book rides "
                     f"the coin ({float(p['rel_size']) * 100:.0f} % of the ride size) until the lead falls under "
                     f"{p['rs_out']:g} swings or BTC turns down.")
    if float(p["rd_on"]) > 0:
        steps.append(f"Over-reaction: when the coin falls {p['rd_z']:g} normal moves further than BTC over "
                     f"{p['rd_hours']:g} hours, it buys; it sells on the RSI bounce or when the gap has closed.")
    if float(p["rv_size"]) > 0:
        steps.append(f"Catch-up: when the coin's price in BTC is {-float(p['rv_in']):g} daily swings under its "
                     f"{p['rs_days']:g}-day average (it fell far more than BTC) and BTC is above its {p['btc_days']:g}-day "
                     f"trend, it buys {float(p['rv_size']) * 100:.0f} % and sells when the ratio is back above "
                     f"{p['rv_out']:g} swings or BTC turns down.")
    if float(p["veto_on"]) >= 0.5 and float(p["veto_rs"]) > 50:
        steps.append(f"BTC veto: no breakout ride while BTC is below its {p['btc_days']:g}-day trend.")
    elif float(p["veto_on"]) >= 0.5:
        steps.append(f"Lag veto: no breakout ride while the coin lags BTC (ratio under {p['veto_rs']:g} swings) and "
                     "BTC is falling.")
    steps.append("For BTC itself only the first three rules apply. The book holds the largest position any rule asks for.")
    return {
        "summary": f"Trades {mk} on breakouts and panic dips, and judges it against bitcoin: breakouts only while BTC "
                   "is not falling, and a catch-up buy when the coin has fallen far more than a steady BTC.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Alt seasons where a coin leads BTC up, and coin-specific flushes that BTC does not share.",
        "whenItLoses": "Coins that keep bleeding against BTC for news reasons, and leads that reverse right after the buy.",
    }
