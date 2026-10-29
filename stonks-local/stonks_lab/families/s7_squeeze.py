"""s7_squeeze: Dip and breakout whose breakout rides count fully only after a volatility squeeze.

Session 4's squeeze book showed that a breakout out of a quiet, coiled market is worth more than one out of an already
wild market. Here the breakout ride of the hourly Dip and breakout book (s6_hourbars, with Session 7's trend vote
from s7_trendgate) is sized by whether a squeeze came before it:
  sq_mode 1  Bollinger width (sd / mean over sq_hours) below sq_level x its own average over sq_calm_days
  sq_mode 2  TTM squeeze: the 2-sd Bollinger band inside a Keltner channel of sq_level x ATR (both over sq_hours)
  sq_mode 3  the breakout range itself: the high_days high-low range below sq_level x its own average
A squeeze within sq_memory_days before the breakout counts; breakouts without one ride at sq_off of their size
(0 = blocked, 1 = no filter). The dips (snap, slow dip) and the MACD ride are untouched. Strictly causal.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s7_squeeze"
VERSION = 1
TITLE = "Squeeze dip and breakout"
BOT_READY = False
MULTI_MARKET = False
INTERVAL = "1h"

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0
STEP = 0.25
VOTE_POWERS = (-1.0, -0.5, 0.0, 0.5, 1.0)   # band members: gate_days * gate_width ** power


def default_params() -> dict:
    return {
        "s_snap": 1.0, "s_vdip": 1.0, "s_macd": 1.0,
        "high_days": 27.0, "giveback": 4.2, "hvol_days": 11.0, "target_vol": 1.0,
        "take_gain": 0.15, "take_frac": 0.5,
        "snap_hours": 4.0, "snap_vol_days": 55.0, "z_up": 3.3, "z_down": 4.4, "snap_trend_days": 60.0,
        "exit_rsi": 50.0,
        "vdip_hours": 40.0, "vdip_z": 2.2,
        "macd_days": 26.0, "stretch": 1.0, "macd_vol": 0.45,
        "gate_days": 102.0, "gate_width": 2.0, "gate_need": 0.4, "gate_size": 0.5, "gate_kama": 0.0,
        "gate_macd": 0.0,
        "sq_mode": 1.0, "sq_hours": 144.0, "sq_calm_days": 96.0, "sq_level": 0.7, "sq_memory_days": 5.0,
        "sq_off": 0.0, "sq_give": 1.0, "sq_entry": 0.0, "sq_bo": 2.0,
        "s_qdip": 0.0, "qdip_z": 1.8, "qdip_exit": 0.0,
    }


def param_space() -> dict:
    share = lambda what: {"type": "float", "min": 0.0, "max": 1.0, "description": f"position the {what} layer takes (0 = off)"}  # noqa: E731
    return {
        "s_snap": share("oversold snap"),
        "s_vdip": share("slow dip"),
        "s_macd": share("MACD ride"),
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends this many daily swings below its peak"},
        "hvol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history that set the daily swing of the ride exit"},
        "target_vol": {"type": "float", "min": 0.1, "max": 3.0, "description": "yearly volatility a full ride may carry; wilder coins ride smaller"},
        "take_gain": {"type": "float", "min": 0.02, "max": 2.0, "description": "log gain of a ride at which part of it is banked; again at twice it"},
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
        "gate_days": {"type": "float", "min": 0.0, "max": 400.0, "description": "middle length (days) of the daily averages that vote on a ride start (0 = no gate)"},
        "gate_width": {"type": "float", "min": 1.0, "max": 4.0, "description": "the voting averages run from gate_days / this to gate_days x this"},
        "gate_need": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of yes votes (price above the average) a ride needs to start"},
        "gate_size": {"type": "float", "min": 0.0, "max": 1.0, "description": "how much the vote at the start also sizes the ride (0 = full size once allowed)"},
        "gate_kama": {"type": "float", "min": 0.0, "max": 3.0, "description": "weight of a daily KAMA trend voter (price above a rising KAMA) next to the five averages"},
        "gate_macd": {"type": "float", "min": 0.0, "max": 1.0, "description": "1 = the MACD ride needs the same vote to start, 0 = it is not gated"},
        "sq_mode": {"type": "float", "min": 0.0, "max": 3.0, "description": "squeeze test: 0 off, 1 Bollinger width vs its history, 2 Bollinger inside Keltner, 3 breakout range vs its history"},
        "sq_hours": {"type": "float", "min": 12.0, "max": 720.0, "description": "hours in the Bollinger band / Keltner channel"},
        "sq_calm_days": {"type": "float", "min": 10.0, "max": 365.0, "description": "days of width history that count as normal"},
        "sq_level": {"type": "float", "min": 0.2, "max": 3.0, "description": "width below this share of normal (or Keltner ATR multiple) is a squeeze"},
        "sq_memory_days": {"type": "float", "min": 0.5, "max": 60.0, "description": "how many days after a squeeze a breakout still counts as its release"},
        "sq_off": {"type": "float", "min": 0.0, "max": 1.0, "description": "size share of a breakout ride with no squeeze before it (1 = no filter)"},
        "sq_give": {"type": "float", "min": 0.3, "max": 3.0, "description": "giveback multiplier for rides that start out of a squeeze"},
        "sq_entry": {"type": "float", "min": 0.0, "max": 1.0, "description": "size share of a ride started by a squeeze release (a close sq_bo band spreads above the band middle) before any new high (0 = off)"},
        "s_qdip": share("squeeze range dip"),
        "qdip_z": {"type": "float", "min": 0.5, "max": 4.0, "description": "band spreads under the middle that buy a dip while the market is squeezed"},
        "qdip_exit": {"type": "float", "min": -1.5, "max": 2.5, "description": "band spreads from the middle that sell the squeeze dip"},
        "sq_bo": {"type": "float", "min": 0.5, "max": 4.0, "description": "band spreads above the middle that count as a squeeze release"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["gate_width"]) < 1.0:
        return "gate_width must be at least 1"
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, BASE_DAYS, 3 * float(p["macd_days"]),
                   float(p["gate_days"]) * float(p["gate_width"]) + 1,
                   float(p["sq_calm_days"]) + float(p["sq_hours"]) / 24.0) * 24)


def _step(index) -> float:
    ts = np.asarray(index, dtype=np.int64)
    return max(float(np.median(np.diff(ts))), 1.0) if len(ts) > 1 else 3_600_000.0


def _bars(step: float, hours: float) -> int:
    return max(2, int(round(hours * _HOUR / step)))


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(x).ewm(span=max(1, int(span)), adjust=False).mean().to_numpy(np.float64)


def _daily(ts: np.ndarray, c: np.ndarray):
    """Completed UTC daily closes and, for every bar, the index of the last completed day (-1 = none)."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    pos = np.searchsorted(dd, d, side="left") - 1
    return dc, pos


def _on_bars(daily_vals: np.ndarray, pos: np.ndarray) -> np.ndarray:
    return np.where(pos >= 0, daily_vals[np.clip(pos, 0, None)], np.nan)


def _prev_day_ema(ts, c, days) -> np.ndarray:
    dc, pos = _daily(ts, c)
    return _on_bars(ind.ema(dc, max(2, int(round(days)))), pos)


def _daily_kama(dc: np.ndarray, n: int) -> np.ndarray:
    """Kaufman's adaptive average of daily closes (TAAPI's 10/2/30 recipe with an n-day efficiency window)."""
    out = np.full(len(dc), np.nan)
    if len(dc) <= n:
        return out
    change = np.abs(dc[n:] - dc[:-n])
    noise = pd.Series(np.abs(np.diff(dc, prepend=dc[0]))).rolling(n).sum().to_numpy()[n:]
    er = np.where(noise > 0, change / np.maximum(noise, 1e-300), 0.0)
    fast, slow = 2.0 / 3.0, 2.0 / 31.0
    sc = (er * (fast - slow) + slow) ** 2
    k = dc[n - 1]
    for j, s in enumerate(sc.tolist()):
        k = k + s * (dc[n + j] - k)
        out[n + j] = k
    return out


def trend_vote(ts, c, lc, p) -> np.ndarray:
    """Share (0..1) of the voters saying the trend is up; an average still warming up abstains."""
    n = len(c)
    gd = float(p["gate_days"])
    if gd <= 0:
        return np.ones(n)
    gw = float(p["gate_width"])
    yes = np.zeros(n)
    cnt = np.zeros(n)
    for pw in VOTE_POWERS:
        e = _prev_day_ema(ts, c, gd * gw ** pw)
        ok = np.isfinite(e)
        yes += np.where(ok, (lc > np.log(np.where(ok, e, 1.0))).astype(np.float64), 0.0)
        cnt += ok
    kw = float(p["gate_kama"])
    if kw > 0:
        dc, pos = _daily(ts, c)
        kn = max(2, int(round(gd / 4.0)))
        kd = _daily_kama(dc, kn)
        rising = np.r_[np.zeros(5, bool), kd[5:] > kd[:-5]] if len(kd) > 5 else np.zeros(len(kd), bool)
        kb = _on_bars(kd, pos)
        rb = _on_bars(rising.astype(np.float64), pos)
        ok = np.isfinite(kb)
        yes += kw * np.where(ok, ((lc > np.log(np.where(ok, kb, 1.0))) & (rb > 0.5)).astype(np.float64), 0.0)
        cnt += kw * ok
    return np.where(cnt > 0, yes / np.maximum(cnt, 1e-12), 0.0)


def squeeze_flag(df, lc, step, p):
    """(flag, release): flag 1.0 where a squeeze was seen within sq_memory_days (this bar included); release 1.0
    where, on top of that, the close is sq_bo spreads above the band middle (a squeeze releasing upward)."""
    n = len(lc)
    mode = int(round(float(p["sq_mode"])))
    nb = _bars(step, float(p["sq_hours"]))
    c0 = pd.Series(df["close"].to_numpy(np.float64))
    bz = ((c0 - c0.rolling(nb, min_periods=nb).mean()) / c0.rolling(nb, min_periods=nb).std()).to_numpy()
    up = np.nan_to_num(bz, nan=0.0) > float(p["sq_bo"])
    if mode <= 0:
        return np.ones(n), np.zeros(n), np.zeros(n), bz
    calm = _bars(step, 24.0 * float(p["sq_calm_days"]))
    lev = float(p["sq_level"])
    c = pd.Series(df["close"].to_numpy(np.float64))
    if mode == 1:
        width = c.rolling(nb, min_periods=nb).std() / c.rolling(nb, min_periods=nb).mean()
        normal = width.rolling(calm, min_periods=nb).mean()
        sq = (width / normal).to_numpy() < lev
    elif mode == 2:
        h = df["high"].to_numpy(np.float64) if "high" in df else c.to_numpy()
        lo = df["low"].to_numpy(np.float64) if "low" in df else c.to_numpy()
        sd = c.rolling(nb, min_periods=nb).std(ddof=0).to_numpy()
        atr = ind.atr(h, lo, c.to_numpy(), nb)
        sq = 2.0 * sd < lev * atr
    else:
        nh = _bars(step, 24.0 * float(p["high_days"]))
        s = pd.Series(lc)
        rng = s.rolling(nh, min_periods=nh).max() - s.rolling(nh, min_periods=nh).min()
        normal = rng.rolling(calm, min_periods=nh).mean()
        sq = (rng / normal).to_numpy() < lev
    sq = np.nan_to_num(np.asarray(sq, dtype=np.float64), nan=0.0)
    mem = _bars(step, 24.0 * float(p["sq_memory_days"]))
    flag = (pd.Series(sq).rolling(mem, min_periods=1).max().to_numpy() > 0).astype(np.float64)
    return flag, flag * up, sq, bz


def _breakout(lc, step, size, vote, sqf, rel, p) -> np.ndarray:
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    give, tg, tf = float(p["giveback"]), float(p["take_gain"]), float(p["take_frac"])
    need, gs = float(p["gate_need"]), float(p["gate_size"])
    off, sgive = float(p["sq_off"]), float(p["sq_give"])
    w = np.zeros(n)
    ride = level = 0
    peak = entry = sz = 0.0
    g = give
    ll, hl, sl, zl, vl = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist(), vote.tolist()
    ql, rl = sqf.tolist(), rel.tolist()
    se = float(p["sq_entry"])
    for i in range(n):
        if ride == 0:
            brk = hl[i] == hl[i] and ll[i] > hl[i]
            rls = se > 0 and rl[i] > 0 and not brk
            if (brk or rls) and zl[i] > 0 and vl[i] >= need - 1e-9 and vl[i] > 0:
                s = zl[i] * (1.0 - gs + gs * vl[i]) * (se if rls else 1.0)
                s = np.floor(s / STEP + 1e-9) * STEP if gs > 0 else s
                fired = ql[i] > 0
                if not fired:
                    s = np.floor(s * off / STEP + 1e-9) * STEP
                if s > 0:
                    ride, peak, entry, level, sz = 1, ll[i], ll[i], 0, s
                    g = give * (sgive if fired else 1.0)
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - g * sl[i]:
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
    depth = np.where(np.isfinite(trend), np.where(trend > 0.0, zu, zd), np.nan)
    w = np.zeros(n)
    held = False
    zl, rl, dl = z.tolist(), rsi.tolist(), depth.tolist()
    for i in range(n):
        zi, ri, di = zl[i], rl[i], dl[i]
        if zi == zi and ri == ri and di == di:
            if not held:
                if zi < -di:
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


def _macd(df, lc, step, vote, p) -> np.ndarray:
    reading = compute("macd", df, max(2, int(round(float(p["macd_days"]) * _DAY / step))))
    level = float(p["stretch"])
    gated = float(p["gate_macd"]) >= 0.5
    need = float(p["gate_need"])
    w = np.zeros(len(reading))
    held = False
    peak, prev = -1e9, np.nan
    vl = vote.tolist()
    for i, v in enumerate(np.asarray(reading, float).tolist()):
        if v != v:
            prev = np.nan
            continue
        if not held:
            if v > 0.0 and not (prev > 0.0) and (not gated or (vl[i] >= need - 1e-9 and vl[i] > 0)):
                held, peak = True, v
        else:
            peak = max(peak, v)
            if prev > 0.0 and v <= 0.0 and peak >= level:
                held, peak = False, -1e9
        w[i] = 1.0 if held else 0.0
        prev = v
    return w


LAYERS = ("break", "snap", "vdip", "macd", "qdip")


def _qdip(sq_now, bz, p) -> np.ndarray:
    """While the band is squeezed, buy a close qdip_z spreads under its middle; sell at qdip_exit spreads."""
    k, ex = float(p["qdip_z"]), float(p["qdip_exit"])
    w = np.zeros(len(bz))
    held = False
    ql, zl = np.asarray(sq_now, float).tolist(), bz.tolist()
    for i in range(len(zl)):
        z = zl[i]
        if z == z:
            if held:
                if z > ex:
                    held = False
            elif ql[i] > 0 and z < -k:
                held = True
        w[i] = 1.0 if held else 0.0
    return w


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
    vote = trend_vote(ts, c, lc, p)
    flag, rel, sq_now, bz = squeeze_flag(df, lc, step, p)
    out["break"] = _breakout(lc, step, size, vote, flag, rel, p)
    if float(p["s_qdip"]) > 0:
        out["qdip"] = _qdip(sq_now, bz, p) * float(p["s_qdip"])
    if float(p["s_snap"]) > 0:
        out["snap"] = _snap(ts, c, lc, step, p) * float(p["s_snap"])
    if float(p["s_vdip"]) > 0:
        out["vdip"] = _vdip(c, lc, step, vol, p) * float(p["s_vdip"])
    if float(p["s_macd"]) > 0:
        ms = float(p["s_macd"])
        if float(p["macd_vol"]) > 0:
            ms = np.minimum(ms, np.floor(np.clip(float(p["macd_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP)
        out["macd"] = _macd(df, lc, step, vote, p) * ms
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
    gd, gw = float(p["gate_days"]), float(p["gate_width"])
    lens = ", ".join(f"{gd * gw ** pw:.0f}" for pw in VOTE_POWERS)
    steps = [f"Decides once an hour, on 1-hour candles of {mk}."]
    gate = (f"Trend gate: five daily averages ({lens} days) vote on whether price is above them"
            + (", with a daily KAMA (price above it while it rises) as an extra voter" if float(p["gate_kama"]) > 0 else "")
            + f". A ride may only start when at least {round(100 * float(p['gate_need']))} % say yes. "
            "New highs inside a falling market are mostly bounces that fail.")
    if gd <= 0:
        gate = "No trend gate: every breakout may start a ride."
    steps.append(gate)
    mode = int(round(float(p["sq_mode"])))
    if mode > 0:
        what = {1: f"the {p['sq_hours']:g}-hour Bollinger band is narrower than {p['sq_level']:g} times its own "
                   f"average width over {p['sq_calm_days']:g} days",
                2: f"the {p['sq_hours']:g}-hour Bollinger band fits inside a Keltner channel of {p['sq_level']:g} ATRs",
                3: f"the {p['high_days']:g}-day price range is narrower than {p['sq_level']:g} times its own average "
                   f"over {p['sq_calm_days']:g} days"}[min(mode, 3)]
        off = float(p["sq_off"])
        steps.append(f"Squeeze filter: the market is coiled when {what}. A breakout counts fully only within "
                     f"{p['sq_memory_days']:g} days of such a squeeze; "
                     + ("other breakouts are ignored." if off <= 0 else f"other breakouts ride at {round(100 * off)} % size."))
    if float(p["sq_entry"]) > 0:
        steps.append(f"Squeeze release: a close {p['sq_bo']:g} band spreads above the band middle soon after a squeeze "
                     f"also starts a ride at {pct('sq_entry')} size, before any new high.")
    if float(p["s_qdip"]) > 0:
        steps.append(f"Squeeze dip: while the band is squeezed, a close {p['qdip_z']:g} spreads under its middle buys "
                     f"{pct('s_qdip')}; it sells at {p['qdip_exit']:g} spreads.")
    steps.append(
        f"Ride: a close above the highest close of the last {p['high_days']:g} days buys, scaled down to "
        f"{p['target_vol']:g} divided by the coin's yearly volatility"
        + (f" and by the share of yes votes ({pct('gate_size')} weight)" if float(p["gate_size"]) > 0 else "")
        + f". It ends when price falls {p['giveback']:g} daily swings below its best since the buy.")
    if float(p["take_frac"]) > 0:
        g = float(p["take_gain"])
        steps.append(f"Banking: at {(np.exp(g) - 1) * 100:.0f} % and {(np.exp(2 * g) - 1) * 100:.0f} % above the "
                     f"buy, {pct('take_frac')} of what still rides is sold.")
    if float(p["s_snap"]) > 0:
        steps.append(
            f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves ({p['z_down']:g} under the "
            f"{p['snap_trend_days']:g}-day trend) buys {pct('s_snap')}; it sells when the {p['snap_hours']:g}-hour RSI "
            f"tops {p['exit_rsi']:g}. Dips are never blocked by the trend gate.")
    if float(p["s_vdip"]) > 0:
        steps.append(f"Slow dip: {p['vdip_z']:g} volatility units under the {p['vdip_hours']:g}-hour average buys "
                     f"{pct('s_vdip')}; it sells once price is back at that average.")
    if float(p["s_macd"]) > 0:
        cap = (f", at most {p['macd_vol']:g} divided by the coin's yearly volatility" if float(p["macd_vol"]) > 0 else "")
        steps.append(f"MACD ride: {pct('s_macd')}{cap} while the {p['macd_days']:g}-day MACD is positive, sold on a "
                     f"cross under zero after it reached {p['stretch']:g}"
                     + (" (it also needs the trend gate to start)." if float(p["gate_macd"]) >= 0.5 else "."))
    steps.append("The book holds the largest position any layer asks for.")
    return {
        "summary": (f"Dip and breakout on {mk} hourly candles: a breakout ride starts only out of a quiet, coiled "
                    "market (a volatility squeeze) and when most of five long daily averages are below the price; "
                    "panic dips are bought in any market."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long climbs that keep making new highs above the long averages, and panic flushes that bounce.",
        "whenItLoses": "Rallies that start from an already wild market (no squeeze, so no ride), the first weeks of a new bull run (the long averages lag), and breakouts that fail right after the buy.",
    }
