"""ratio_gate v1 (agent-10): hold ONE coin only while it is outperforming the other big coin; cash otherwise.

btc_eth_ratio (findings #35 #46 #47 #133) always holds the leader of BTC/ETH and so is never in cash on its own; a
ratio tilt inside pair_macd (#176) was not robust. Neither asked the single-coin question: is ETH-EUR worth holding
*only while the ETH/BTC ratio is rising* (and in euros, not BTC, when it falls)? ETH's big rallies tend to come
with a rising ETH/BTC ratio and its worst bears with a falling one.

- ratio r = close(market) / close(ref) with ref = the other of BTC-EUR / ETH-EUR (aligned as of the bar time);
- the gate is on while EMA(r, ratioFast) > EMA(r, ratioSlow) * (1 + band), off below EMA(slow) * (1 - band),
  unchanged in between (ratioFast 1 = the ratio itself);
- optional trend core: the coin's own close above SMA(coreLen) (0 = off), combined with the gate by `combine`:
  "and" = hold only when both are on, "or" = hold when either is on, "gate" = ratio gate only (core ignored).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, max_weight, pct, risk_steps, single_market

NAME = "ratio_gate"
VERSION = 1
TITLE = "Relative-strength gate (ETH/BTC ratio) on one coin"
BOT_READY = False
MULTI_MARKET = False
PAIR = ["BTC-EUR", "ETH-EUR"]


def default_params() -> dict:
    return {"ratioFast": 10, "ratioSlow": 60, "band": 0.0, "coreLen": 130, "combine": "or"}


def param_space() -> dict:
    return {
        "ratioFast": {"type": "int", "min": 1, "max": 120, "log": True,
                      "description": "EMA length of the ratio's fast line (1 = the ratio itself)"},
        "ratioSlow": {"type": "int", "min": 5, "max": 600, "log": True,
                      "description": "EMA length of the ratio's slow line"},
        "band": {"type": "float", "min": 0.002, "max": 0.08, "log": True, "zero": True,
                 "description": "hysteresis: the fast line must clear the slow line by this fraction to switch"},
        "coreLen": {"type": "int", "min": 10, "max": 600, "zero": True, "log": True,
                    "description": "trend core: the coin's own close above this SMA (0 = off)"},
        "combine": {"type": "choice", "values": ["gate", "and", "or"],
                    "description": "gate: ratio only; and: ratio AND core; or: ratio OR core"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["ratioSlow"]) <= int(p["ratioFast"]):
        return "ratioSlow must be longer than ratioFast"
    if p["combine"] != "gate" and int(p.get("coreLen") or 0) == 0:
        return "combine and/or needs a coreLen"
    return None


def warmup(p: dict) -> int:
    return max(int(p["ratioSlow"]), int(p.get("coreLen") or 0))


def _ref(market: str) -> str:
    if market not in PAIR:
        raise ValueError(f"ratio_gate trades BTC-EUR or ETH-EUR, got {market}")
    return PAIR[1] if market == PAIR[0] else PAIR[0]


def required_markets(spec: dict) -> list[str]:
    ms = list(spec.get("markets") or [])
    return ms + [_ref(m) for m in ms[:1] if _ref(m) not in ms]


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def _hyst(x: np.ndarray, ref: np.ndarray, band: float) -> np.ndarray:
    out = np.full(len(x), np.nan)
    state = None
    for i, (a, b) in enumerate(zip(x.tolist(), ref.tolist())):
        if not (np.isfinite(a) and np.isfinite(b)):
            continue
        if state is None:
            state = a > b
        elif a > b * (1 + band):
            state = True
        elif a < b * (1 - band):
            state = False
        out[i] = 1.0 if state else 0.0
    return out


def _ema_valid(x: np.ndarray, n: int) -> np.ndarray:
    """EMA over the finite tail of x (x is NaN before both coins list)."""
    out = np.full(len(x), np.nan)
    ok = np.isfinite(x)
    if not ok.any():
        return out
    s = int(np.argmax(ok))
    tail = pd.Series(x[s:]).ffill().to_numpy(np.float64)
    out[s:] = tail if n <= 1 else ind.ema(tail, n)
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    ref = candles[_ref(m)]
    idx = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    rc = _asof(ref, ref["close"].to_numpy(np.float64), idx)
    with np.errstate(invalid="ignore", divide="ignore"):
        r = c / rc
    fast = _ema_valid(r, int(p["ratioFast"]))
    slow = _ema_valid(r, int(p["ratioSlow"]))
    gate = _hyst(fast, slow, float(p.get("band") or 0.0))
    n = int(p.get("coreLen") or 0)
    mode = p.get("combine", "or")
    if mode == "gate" or n <= 0:
        on = gate
    else:
        sm = ind.sma(c, n)
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
        ok = np.isfinite(core) & np.isfinite(gate)
        both = (np.nan_to_num(gate) == 1) & (np.nan_to_num(core) == 1)
        either = (np.nan_to_num(gate) == 1) | (np.nan_to_num(core) == 1)
        on = np.where(ok, (both if mode == "and" else either).astype(np.float64), np.nan)
    return frame(idx, {m: on * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    m = (spec.get("markets") or ["ETH-EUR"])[0]
    coin, other = m.split("-")[0], _ref(m).split("-")[0]
    fast = "the ratio itself" if int(p["ratioFast"]) <= 1 else f"its average over {bars_text(p['ratioFast'], iv)}"
    steps = [f"After every {iv} candle it divides the {coin} price by the {other} price: a rising ratio means {coin} "
             f"is beating {other}.",
             f"The ratio is 'strong' while {fast} is above its average over {bars_text(p['ratioSlow'], iv)}"
             + (f" (it only switches once the gap passes {pct(p['band'])})." if p.get("band") else ".")]
    n, mode = int(p.get("coreLen") or 0), p.get("combine", "or")
    if mode == "gate" or n <= 0:
        steps.append(f"It holds {coin} while the ratio is strong and keeps euros otherwise (never {other}).")
    elif mode == "and":
        steps.append(f"It holds {coin} only while the ratio is strong AND {coin} is above its average price over "
                     f"{bars_text(n, iv)}; otherwise euros.")
    else:
        steps.append(f"It holds {coin} while the ratio is strong OR {coin} is above its average price over "
                     f"{bars_text(n, iv)}; euros only when both are weak.")
    return {
        "summary": f"Holds {coin} only while it is outperforming {other} (and/or trending up), otherwise euros.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": f"{coin}-led rallies, and bear markets where {coin} also loses ground to {other}.",
        "whenItLoses": f"Rallies where {other} leads, and choppy ratio swings that cause repeated round trips.",
    }
