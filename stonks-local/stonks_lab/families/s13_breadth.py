"""s13_breadth: Bitcoin bull, cycle check with market breadth as the alarm.

The layer reads the 10 coins' hourly candles from disk, cut at the coin's last bar, and looks at how far each coin moved
over the last fall_hours. When the worst fall_share of the coins are all down at least fall_pct, the whole market is
falling hard: the target is cut to keep of its size until hold_days after the last such reading. The main strategy's
entries and exits stand, and the layer only ever lowers the size.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import data
from ._base import frame, market_names
from ._s13_core import trimmed

NAME = "s13_breadth"
VERSION = 1
TITLE = "Breadth alarm"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
UNIVERSE = ("BTC-EUR", "ETH-EUR", "ADA-EUR", "AVAX-EUR", "BNB-EUR", "DOGE-EUR", "LINK-EUR", "SOL-EUR", "TRX-EUR",
            "XRP-EUR")
MIN_COINS = 3
_PANEL: dict = {}
_ALARM: dict = {}


def default_params() -> dict:
    return {"fall_hours": 480.0, "fall_pct": 0.3, "fall_share": 0.7, "keep": 0.5, "hold_days": 3.0}


def param_space() -> dict:
    return {
        "fall_hours": {"type": "float", "min": 12.0, "max": 720.0, "description": "hours over which each coin's fall is measured"},
        "fall_pct": {"type": "float", "min": 0.05, "max": 0.5, "description": "a coin down this share over those hours is falling hard"},
        "fall_share": {"type": "float", "min": 0.3, "max": 1.0, "description": "share of the coins that must be falling hard at once"},
        "keep": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the usual size held while the alarm rings"},
        "hold_days": {"type": "float", "min": 0.0, "max": 30.0, "description": "days the alarm stays on after its last reading"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(float(p["fall_hours"])) * 4


def _panel():
    """(hour starts, closes hours x coins) of the 10 coins from disk; gaps up to 6 hours are carried."""
    v = _PANEL.get("p")
    if v is None:
        cols = {}
        for m in UNIVERSE:
            try:
                h = data.load_candles(m, "1h")
            except FileNotFoundError:
                continue
            cols[m] = pd.Series(h["close"].to_numpy(np.float64), index=np.asarray(h.index, dtype=np.int64))
        if not cols:
            v = (np.zeros(0, np.int64), np.zeros((0, 1)))
        else:
            x = pd.DataFrame(cols).sort_index()
            grid = np.arange(int(x.index[0]), int(x.index[-1]) + _HOUR, _HOUR, dtype=np.int64)
            v = (grid, x.reindex(grid).ffill(limit=6).to_numpy(np.float64))
        _PANEL["p"] = v
    return v


def _falling(lx: np.ndarray, hours: float, pct: float, share: float) -> np.ndarray:
    """Per hour: are the worst share of the coins all down at least pct over the last hours?"""
    n = max(1, int(round(hours)))
    moved = np.full_like(lx, np.nan)
    moved[n:] = lx[n:] - lx[:-n]
    srt = np.sort(moved, axis=1)                  # worst move first, coins without a reading last
    cnt = np.isfinite(moved).sum(1)
    top = np.maximum(cnt - 1, 0)
    rank = share * top                            # the move the worst share of the coins sit at or below
    lo = np.floor(rank).astype(int)
    hi = np.minimum(lo + 1, top)
    t = rank - lo
    idx = np.arange(len(srt))
    mark = srt[idx, lo] * (1 - t) + srt[idx, hi] * t
    return (cnt >= MIN_COINS) & (np.nan_to_num(mark, nan=0.0) < np.log(1.0 - pct))


def _alarm(cut: int, p: dict) -> tuple[np.ndarray, np.ndarray]:
    """(hour starts up to cut, alarm per hour), worked out from those hours only."""
    key = (cut, float(p["fall_hours"]), float(p["fall_pct"]), float(p["fall_share"]), float(p["hold_days"]))
    v = _ALARM.get(key)
    if v is not None:
        return v
    grid, x0 = _panel()
    k = int(np.searchsorted(grid, cut, side="right"))
    hrs, lx = grid[:k], np.log(x0[:k])
    trig = _falling(lx, float(p["fall_hours"]), float(p["fall_pct"]), float(p["fall_share"]))
    hold = int(round(float(p["hold_days"]) * 24))
    last = pd.Series(np.where(trig, np.arange(len(trig)), np.nan)).ffill().to_numpy()
    alarm = np.isfinite(last) & (np.arange(len(trig)) - np.nan_to_num(last) <= hold)
    if len(_ALARM) > 64:
        _ALARM.clear()
    v = (hrs, alarm)
    _ALARM[key] = v
    return v


def _on_bars(ts: np.ndarray, p: dict) -> np.ndarray:
    """Alarm per bar: an hour counts once it has closed by the close of the bar."""
    step = int(np.median(np.diff(ts))) if len(ts) > 1 else 900_000
    known = ts + step - _HOUR                     # newest hour start that is complete at this bar's close
    hrs, alarm = _alarm(int(known[-1]) // _HOUR * _HOUR, p)
    if not len(hrs):
        return np.zeros(len(ts), bool)
    pos = np.searchsorted(hrs, known, side="right") - 1
    return np.where(pos >= 0, alarm[np.clip(pos, 0, None)], False)


def _trim(df, core, p) -> np.ndarray:
    return np.where(_on_bars(np.asarray(df.index, dtype=np.int64), p), float(p["keep"]), 1.0)


def targets(candles, spec, start_time=None):
    del start_time
    m, df, w = trimmed(candles, spec, _trim)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    keep, share, fall = float(p["keep"]) * 100, float(p["fall_share"]) * 100, float(p["fall_pct"]) * 100
    return {
        "summary": f"Bitcoin bull, cycle check on {mk}, cut to {keep:.0f} % of its size while most of the 10 coins fall hard at once.",
        "howItWorks": [
            "The main strategy decides every buy and sell, at its usual settings.",
            f"Every hour the layer checks all 10 coins: did {share:.0f} % of them fall at least {fall:.0f} % over the last "
            f"{float(p['fall_hours']) / 24:g} days?",
            f"If so, the target is cut to {keep:.0f} % of its size until {float(p['hold_days']):g} days after the last such reading.",
            "The layer never adds size and never starts a position.",
        ],
        "whenItWins": "Market-wide crashes that run for weeks, where the dip ladder would otherwise buy the second leg down at full size.",
        "whenItLoses": "A market-wide fall that bounces straight back. It does nothing in slow bleeds or in one coin's own fall.",
        "vsBuyHold": "Holds less than Bitcoin bull, cycle check during and just after a market-wide crash, and the same at all other times.",
    }
