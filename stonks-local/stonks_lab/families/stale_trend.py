"""stale_trend v1 (agent-10): a trend core that exits when the trend goes stale (a drawdown-duration exit).

Every exit tried so far is price-based (SMA cross, Donchian low, stops, take-profit). This family adds a TIME exit:
a trend that has not made a new high for a long time is tired, whatever the price level.

- since_t = candles since the close last set a new hiLook-candle high (0 on a bar that is the highest close of the
  last hiLook bars including itself);
- fresh_t = since_t <= staleBars (staleBars 0 = off: always fresh);
- core_t = close above SMA(coreLen) (coreLen 0 = off: always on).
Hold while core AND fresh. After a stale exit it buys back on the next new hiLook-high made above the SMA.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "stale_trend"
VERSION = 1
TITLE = "Trend core with a stale-trend time exit"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"coreLen": 130, "hiLook": 60, "staleBars": 30}


def param_space() -> dict:
    return {
        "coreLen": {"type": "int", "min": 10, "max": 600, "zero": True, "log": True,
                    "description": "hold only while the close is above this SMA (0 = off)"},
        "hiLook": {"type": "int", "min": 5, "max": 500, "log": True,
                   "description": "a new high means the highest close of this many candles"},
        "staleBars": {"type": "int", "min": 2, "max": 400, "zero": True, "log": True,
                      "description": "sell when no new high has been made for this many candles (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p.get("coreLen") or 0) == 0 and int(p.get("staleBars") or 0) == 0:
        return "needs a coreLen or a staleBars"
    return None


def warmup(p: dict) -> int:
    return max(int(p["hiLook"]), int(p.get("coreLen") or 0))


def bars_since_high(close: np.ndarray, look: int) -> np.ndarray:
    c = np.asarray(close, dtype=np.float64)
    hi = ind.rolling_max(c, look)
    out = np.full(len(c), np.nan)
    last = None
    for i in range(len(c)):
        if not np.isfinite(hi[i]):
            continue
        if c[i] >= hi[i]:
            last = i
        if last is None:
            out[i] = look  # no new high seen yet inside the defined history: at least look bars old
        else:
            out[i] = i - last
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    since = bars_since_high(c, int(p["hiLook"]))
    sb = int(p.get("staleBars") or 0)
    fresh = np.where(np.isfinite(since), (since <= sb) if sb > 0 else True, np.nan).astype(np.float64)
    n = int(p.get("coreLen") or 0)
    if n > 0:
        sm = ind.sma(c, n)
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    else:
        core = np.ones(len(c))
    ok = np.isfinite(fresh) & np.isfinite(core)
    on = np.where(ok, ((core == 1) & (fresh == 1)).astype(np.float64), np.nan)
    return frame(df.index, {m: on * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    n, sb = int(p.get("coreLen") or 0), int(p.get("staleBars") or 0)
    steps = []
    if n:
        steps.append(f"It holds {mk} only while the price is above its average over {bars_text(n, iv)}.")
    if sb:
        steps.append(f"It also sells when the price has not made a new {bars_text(p['hiLook'], iv)} high for "
                     f"{bars_text(sb, iv)}: a trend that stopped making highs is treated as over.")
        steps.append("It buys back on the next new high" + (" made above the average." if n else "."))
    return {
        "summary": f"Holds {mk} in uptrends, but sells a trend that has stopped making new highs for too long.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Tops that roll over slowly: it is out before the price breaks the long average.",
        "whenItLoses": "Long sideways pauses inside a bull market: it sells, then buys back higher on the breakout.",
    }
