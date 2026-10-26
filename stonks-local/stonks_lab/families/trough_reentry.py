"""trough_reentry: SMA trend core that re-enters early once the price bounces off its post-exit low (agent-13).

breadth_dip's ablation (#213) says a plain SMA core loses to buy and hold because it re-enters V-shaped recoveries
late; the panic buys that fix it need today's top-10 list (#253: own-coin panic buys fail, they buy too early).
This family uses the coin's own price only and waits for *confirmation* instead of buying the panic:

- Core: held while the close is above SMA(coreSma); with band b it enters above SMA*(1+b) and leaves below SMA*(1-b).
- Rebound: while the core is out, track the lowest close since the core left (the trough). When the close is
  rebound above that trough (and the trough is at least minDrop below the highest close of the last coreSma
  candles, i.e. after a real crash), buy early. The rebound
  trade ends when the close falls stop below its entry close, or after holdBars candles (0 = no limit) without the
  core taking over; the trough tracking then restarts from that close. Once the close is above the core's entry
  level the core takes over.

Every market is decided on its own candles and gets maxWeight / len(markets) while held. Decisions at bar t use
closes up to and including t only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "trough_reentry"
VERSION = 1
TITLE = "Trend core + bounce-off-the-low re-entry"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"coreSma": 130, "band": 0.0, "rebound": 0.2, "minDrop": 0.0, "stop": 0.1, "holdBars": 0}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 10, "max": 600, "log": True,
                    "description": "trend core: hold while the close is above this SMA"},
        "band": {"type": "float", "min": 0.0, "max": 0.08,
                 "description": "core hysteresis: enter above SMA*(1+band), leave below SMA*(1-band)"},
        "rebound": {"type": "float", "min": 0.03, "max": 0.6, "log": True,
                    "description": "re-enter early once the close is this far above its lowest close since the exit"},
        "minDrop": {"type": "float", "min": 0.05, "max": 0.6, "zero": True,
                    "description": "only when the trough is this far below the highest close of the last coreSma candles (0 = any)"},
        "stop": {"type": "float", "min": 0.02, "max": 0.4, "log": True,
                 "description": "end a rebound trade when the close is this far below its entry close"},
        "holdBars": {"type": "int", "min": 3, "max": 400, "zero": True, "log": True,
                     "description": "end a rebound trade after this many candles unless the core took over (0 = never)"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(p["coreSma"]) - 1


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _held(c: np.ndarray, p: dict) -> np.ndarray:
    """1/0 per candle of one market (NaN while the SMA is undefined)."""
    n = len(c)
    s = ind.sma(c, int(p["coreSma"]))
    hi = pd.Series(c).rolling(int(p["coreSma"]), min_periods=1).max().to_numpy()
    band, reb, drop = float(p["band"]), float(p["rebound"]), float(p.get("minDrop") or 0.0)
    stop, hold_n = float(p["stop"]), int(p.get("holdBars") or 0)
    out = np.full(n, np.nan)
    core = None            # None until the first defined bar
    trough = entry = None
    in_reb, held = False, 0
    cl, sl, hl = c.tolist(), s.tolist(), hi.tolist()
    for i in range(n):
        x, m = cl[i], sl[i]
        if not (np.isfinite(x) and np.isfinite(m)):
            continue
        if core is None:
            core = x > m
            if not core:
                trough = x
        elif core:
            if x < m * (1.0 - band):
                core = False
                trough = x
        else:
            if x > m * (1.0 + band):
                core, in_reb = True, False
        if not core:
            if in_reb:
                held += 1
                if x < entry * (1.0 - stop) or (hold_n and held >= hold_n):
                    in_reb = False
                    trough = x
            else:
                trough = min(trough, x)
                if x >= trough * (1.0 + reb) and trough <= hl[i] * (1.0 - drop) + 1e-12:
                    in_reb, held, entry = True, 0, x
        out[i] = 1.0 if (core or in_reb) else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = []
    for m in markets:
        df = candles[m]
        h = _held(df["close"].to_numpy(np.float64), p)
        cols.append(_asof(df, h, idx) * each)
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    band = float(p["band"])
    steps = [f"Trend core: it holds {mk} while the price is above its {bars_text(p['coreSma'], iv)} average"
             + (f" (it buys once the price is {pct(band)} above it and sells once it is {pct(band)} below it)"
                if band > 0 else "") + (f", {100 / k:.0f} % of the money per coin." if k > 1 else ".")]
    drop = float(p.get("minDrop") or 0)
    steps.append(f"Early re-entry: after the core has sold, it watches the lowest price since then"
                 + (f" (only once that low is {pct(drop)} or more under the highest price of the last "
                    f"{bars_text(p['coreSma'], iv)})" if drop > 0 else "")
                 + f"; when the price climbs {pct(p['rebound'])} off that low, it buys back before the average "
                   "turns up.")
    steps.append(f"That early trade is sold again if the price falls {pct(p['stop'])} below where it bought"
                 + (f" or after {bars_text(p['holdBars'], iv)} without the price getting back above its average"
                    if int(p.get("holdBars") or 0) else "")
                 + "; then it starts watching for a new low.")
    steps.append("Otherwise it holds euros.")
    return {
        "summary": f"Rides {mk} uptrends and buys back early when the price clearly bounces off a low.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets and V-shaped recoveries after crashes, which a plain trend average re-enters late.",
        "whenItLoses": "Bear markets with sharp dead-cat bounces: each early re-entry can get stopped out.",
    }
