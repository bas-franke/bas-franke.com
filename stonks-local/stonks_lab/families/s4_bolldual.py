"""s4_bolldual: Bollinger bands both ways. Ride a break above a slow band, buy a deep dip below a fast band
only while that band is unusually wide (a panic flush), and sit in cash otherwise."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s4_bolldual"
VERSION = 1
TITLE = "Bollinger both ways"
BOT_READY = False
MULTI_MARKET = False

WIDTH_DAYS = 30.0   # a band's width is compared with its own median over this many days


def default_params() -> dict:
    return {"hours": 168.0, "width": 2.5, "exit": 0.5, "fade_hours": 44.0, "fade_width": 3.25, "wide": 1.5}


def param_space() -> dict:
    return {
        "hours": {"type": "float", "min": 24.0, "max": 720.0, "description": "hours in the slow average and its bands (the ride)"},
        "width": {"type": "float", "min": 1.0, "max": 4.0, "description": "slow band distance from its average, in standard deviations"},
        "exit": {"type": "float", "min": -2.0, "max": 2.0,
                 "description": "a ride ends when the close falls below the slow average plus this many standard deviations"},
        "fade_hours": {"type": "float", "min": 4.0, "max": 240.0, "description": "hours in the fast average and its bands (the dip buy)"},
        "fade_width": {"type": "float", "min": 1.0, "max": 5.0, "description": "how far below the fast average a dip must close, in standard deviations"},
        "wide": {"type": "float", "min": 0.8, "max": 3.0,
                 "description": "dips are bought only when the fast band is this many times wider than its 30-day median"},
    }


def valid_params(p: dict) -> str | None:
    return None


def _bars(index, hours: float) -> int:
    idx = np.asarray(index, dtype=np.int64)
    step = float(np.median(np.diff(idx))) if len(idx) > 1 else 900_000.0
    return max(2, int(round(hours * 3_600_000 / max(step, 1.0))))


def warmup(p: dict) -> int:
    return int(round(WIDTH_DAYS * 96 / 2)) + int(round(max(p["hours"], p["fade_hours"]) * 4))


def _band(c: pd.Series, n: int, nw: int):
    m = c.rolling(n).mean()
    s = c.rolling(n).std(ddof=0)
    bw = s / m
    ratio = bw / bw.rolling(nw, min_periods=max(2, nw // 2)).median()
    return m.to_numpy(), s.to_numpy(), ratio.to_numpy()


def _weights(df, hours, width, exit_k, fade_hours, fade_width, wide) -> np.ndarray:
    nw = _bars(df.index, WIDTH_DAYS * 24)
    c = pd.Series(df["close"].to_numpy(np.float64))
    rm, rs, rr = _band(c, _bars(df.index, hours), nw)
    fm, fs, fr = _band(c, _bars(df.index, fade_hours), nw)
    cv = c.to_numpy()
    ride_in = (rm + width * rs).tolist()
    ride_out = (rm + exit_k * rs).tolist()
    dip = (fm - fade_width * fs).tolist()
    fmid = fm.tolist()
    ok = (np.isfinite(rr) & np.isfinite(fr)).tolist()
    frl = fr.tolist()
    xs = cv.tolist()
    w = np.full(len(cv), np.nan)
    state = 0  # 0 cash, 1 dip buy, 2 ride
    for i in range(len(xs)):
        if not ok[i]:
            continue
        x = xs[i]
        if state == 2:
            if x < ride_out[i]:
                state = 0
        elif state == 1:
            if x > ride_in[i]:
                state = 2
            elif x > fmid[i]:
                state = 0
        if state == 0:
            if x > ride_in[i]:
                state = 2
            elif frl[i] > wide and x < dip[i]:
                state = 1
        w[i] = 1.0 if state else 0.0
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, float(p["hours"]), float(p["width"]), float(p["exit"]), float(p["fade_hours"]),
                 float(p["fade_width"]), float(p["wide"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Bollinger bands on {mk} used two ways: ride a close above a slow {p['hours']:g}-hour band, and buy a "
            f"deep dip below a fast {p['fade_hours']:g}-hour band only while that band is unusually wide."
        ),
        "howItWorks": [
            "A Bollinger band is a moving average with lines a few standard deviations (the normal size of price "
            "swings) above and below it.",
            f"Ride: when the price closes {p['width']:g} standard deviations above the {p['hours']:g}-hour average, "
            "buy and hold the move.",
            f"The ride ends when the close falls below that average plus {p['exit']:g} standard deviations, so a "
            "fading rise is sold early.",
            f"Dip buy: when the {p['fade_hours']:g}-hour band is at least {p['wide']:g} times wider than its usual "
            f"width over the last {int(WIDTH_DAYS)} days (a panic), a close {p['fade_width']:g} standard deviations "
            "below its average is bought.",
            "The dip buy is sold when the price climbs back to the fast average, or turned into a ride if it breaks "
            "the slow upper band.",
            "In narrow, quiet bands a drop below the lower band is not bought: in quiet markets such breaks tend to keep going.",
        ] + risk_steps(spec),
        "whenItWins": "Strong rises that start with a band break, and sharp panic flushes that snap back within a day or two.",
        "whenItLoses": "Breakouts that turn back at once, slow grinding rises that never close far above the band, "
                       "and crashes that keep falling after the first flush.",
    }
