"""s14_plateau: the live book with no new rule. Nine settings move to the middle of their flat areas and four that do nothing
become round constants. Moving more settings made the book score lower and no steadier, so the rest stay."""
from __future__ import annotations

from . import s9_cyclebull, s13_timestop
from ._base import frame, market_names, max_weight, single_market
from ._s14_core import book

NAME = "s14_plateau"
VERSION = 1
TITLE = "Flat area settings"
BOT_READY = False
MULTI_MARKET = False

_STOP = ("gain", "deep", "deep_days")
# The settings that were searched. Everything else in s9_cyclebull stays as it is: off switches, 0 and 1 multipliers.
_MAIN = ("high_days", "giveback", "hvol_days", "target_vol", "take_gain", "snap_hours", "snap_vol_days", "z_up", "z_down",
         "snap_trend_days", "exit_rsi", "vdip_hours", "vdip_z", "ladder_first", "ladder_mult", "fast_z", "macd_days", "macd_vol",
         "btc_days", "bull_size", "btc_exit_days", "cycle_days", "cyc_hot")
# Round constants: moving these 35 % either way changes the score by less than 0.1, so they are no longer settings.
_FIXED_MAIN = {"take_frac": 0.5, "bull_take": 0.5, "bull_gain": 3.0}
_FIXED_STOP = {"hours": 6.0}
# The middle of the flat area, for the nine settings where that held up when tested. The rest stay at the live values.
_MOVED = {"hvol_days": 10.0, "target_vol": 0.4, "snap_vol_days": 50.0, "z_up": 3.5, "exit_rsi": 45.0, "vdip_hours": 48.0, "vdip_z": 2.4,
          "macd_vol": 0.4, "gain": 0.04}


def default_params() -> dict:
    a, b = s9_cyclebull.default_params(), s13_timestop.default_params()
    return {**{k: a[k] for k in _MAIN}, **{k: b[k] for k in _STOP}, **_MOVED}


def param_space() -> dict:
    a, b = s9_cyclebull.param_space(), s13_timestop.param_space()
    return {**{k: a[k] for k in _MAIN}, **{k: b[k] for k in _STOP}}


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    main = {**s9_cyclebull.default_params(), **_FIXED_MAIN, **{k: p[k] for k in _MAIN}}
    return max(s9_cyclebull.warmup(main), s13_timestop.warmup(p))


def _weights(df, p):
    return book(df, {**_FIXED_MAIN, **{k: float(p[k]) for k in _MAIN}}, {**_FIXED_STOP, **{k: float(p[k]) for k in _STOP}})


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    return frame(df.index, {m: _weights(df, spec["params"]) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": f"Bitcoin bull, cycle check on {mk} with the crash buy time stop, with nine settings moved to the middle of their flat areas.",
        "howItWorks": [
            f"The same rules as the live book. A bitcoin bull runs above its {p['btc_days']:g}-day average and ends under it or under its {p['btc_exit_days']:g}-day average.",
            f"Rides buy {p['high_days']:g}-day highs and end {p['giveback']:g} daily swings below the peak. In a bull they are {p['bull_size']:g} times bigger.",
            f"Dips buy a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves, or {p['z_down']:g} under the trend.",
            f"Crash buys that are not {float(p['gain']) * 100:.0f} % up within {_FIXED_STOP['hours']:g} hours are sold.",
        ],
        "whenItWins": "Trends and panic bounces, as the live book, with less riding on one exact number.",
        "whenItLoses": "Sideways markets, and bitcoin bulls with a weak coin.",
        "vsBuyHold": "Beats holding by staying out of most falls.",
    }
