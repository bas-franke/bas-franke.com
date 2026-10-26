"""volratio_gate_a16 v1 (agent-16): step aside while ETH's volatility relative to BTC's is abnormal.

Idea: ETH normally swings about 1.2-1.5x as much as BTC. When that ratio moves far from its own recent normal, the
market is in an unusual state: either ETH-led speculation (ratio high) or a BTC-specific shock (ratio low). A
pre-holdout study (agent-16, wave 6, BTC/ETH 1d 2020-2025) found the next 30 days were weaker for both coins when
the 90-day ratio sat in the top 40 % of |z| in 4-5 of 6 years (2025 the exception).

- ratio_t = log(stdev of ETH daily log returns / stdev of BTC's) over the last ``volLen`` candles;
- z_t = (ratio_t - its mean over ``zLen`` candles) / its stdev over ``zLen`` candles (closes up to bar t only);
- ``side``: "abs" = abnormal either way, "high" = only ETH-heavy, "low" = only BTC-heavy;
- step out when the (signed or absolute) z >= ``exitZ``, come back when it falls below ``enterZ`` (<= exitZ);
- optional SMA core (``coreLen``, 0 = off): with ``combine`` "and" hold only when the gate is open AND close > SMA,
  "or" hold when either says so.

Always needs BTC-EUR and ETH-EUR candles; trades the spec's markets with maxWeight / len(markets) each.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "volratio_gate_a16"
VERSION = 1
TITLE = "ETH/BTC volatility-ratio gate"
BOT_READY = False
MULTI_MARKET = True
ANCHORED = False


def default_params() -> dict:
    return {"volLen": 90, "zLen": 365, "side": "abs", "exitZ": 1.2, "enterZ": 1.0, "coreLen": 0, "combine": "or"}


def param_space() -> dict:
    return {
        "volLen": {"type": "int", "min": 14, "max": 180, "log": True,
                   "description": "candles of daily returns in each volatility estimate"},
        "zLen": {"type": "int", "min": 90, "max": 730, "log": True,
                 "description": "candles over which the ratio's normal level and spread are measured"},
        "side": {"type": "choice", "values": ["abs", "high", "low"],
                 "description": "abs = abnormal either way, high = ETH unusually wild, low = BTC unusually wild"},
        "exitZ": {"type": "float", "min": 0.5, "max": 2.5, "description": "step out when the z-score reaches this"},
        "enterZ": {"type": "float", "min": 0.0, "max": 2.5, "description": "come back when it falls below this"},
        "coreLen": {"type": "int", "min": 20, "max": 300, "zero": True, "log": True,
                    "description": "SMA core combined with the gate (0 = hold whenever the gate is open)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = gate open AND above SMA, or = gate open OR above SMA"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["enterZ"]) <= float(p["exitZ"]) else "enterZ must be at most exitZ"


def warmup(p: dict) -> int:
    return int(p["volLen"]) + int(p["zLen"]) + 1


def required_markets(spec: dict) -> list[str]:
    ms = list(spec.get("markets") or [])
    return ms + [m for m in ("BTC-EUR", "ETH-EUR") if m not in ms]


def ratio_z(cb: np.ndarray, ce: np.ndarray, vol_len: int, z_len: int) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        rb = np.full(len(cb), np.nan)
        re_ = np.full(len(ce), np.nan)
        rb[1:] = np.log(cb[1:] / cb[:-1])
        re_[1:] = np.log(ce[1:] / ce[:-1])
        r = np.log(ind.std_pop(re_, vol_len) / ind.std_pop(rb, vol_len))
        r[~np.isfinite(r)] = np.nan
        z = (r - ind.sma(r, z_len)) / ind.std_pop(r, z_len)
    z[~np.isfinite(z)] = np.nan
    return z


def gate(z: np.ndarray, side: str, exit_z: float, enter_z: float) -> np.ndarray:
    s = np.abs(z) if side == "abs" else (z if side == "high" else -z)
    out = np.full(len(z), np.nan)
    state = 1.0
    for i, v in enumerate(s):
        if not np.isfinite(v):
            continue
        if state == 1.0 and v >= exit_z:
            state = 0.0
        elif state == 0.0 and v < enter_z:
            state = 1.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("volratio_gate_a16 needs at least one market")
    for m in ("BTC-EUR", "ETH-EUR"):
        if m not in candles:
            raise KeyError(f"volratio_gate_a16 needs {m} candles")
    idx = union_index(candles, markets)
    z = ratio_z(aligned_close(candles, "BTC-EUR", idx), aligned_close(candles, "ETH-EUR", idx),
                int(p["volLen"]), int(p["zLen"]))
    g = gate(z, p.get("side", "abs"), float(p["exitZ"]), float(p["enterZ"]))
    core_len, combine = int(p.get("coreLen") or 0), p.get("combine", "or")
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        if core_len > 0:
            sm = ind.sma(c, core_len)
            core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
            ok = np.isfinite(g) & np.isfinite(core)
            on = (g == 1) & (core == 1) if combine == "and" else (g == 1) | (core == 1)
        else:
            ok = np.isfinite(g)
            on = g == 1
        ok &= np.isfinite(c)
        cols[m] = np.where(ok, on.astype(np.float64) * each, np.nan)
    df = frame(idx, cols)
    if len(markets) > 1:
        any_ok = df.notna().any(axis=1).to_numpy()
        df = df.fillna(0.0)
        df[~any_ok] = np.nan
    return df


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    side = {"abs": "far from normal in either direction",
            "high": "unusually high (ETH far wilder than usual compared with BTC)",
            "low": "unusually low (BTC unusually wild compared with ETH)"}[p.get("side", "abs")]
    steps = [
        f"After every {iv} candle it compares how much Ethereum and Bitcoin have swung over the last "
        f"{bars_text(p['volLen'], iv)} (ETH volatility divided by BTC volatility).",
        f"It measures how unusual that ratio is against the last {bars_text(p['zLen'], iv)} and steps into euros "
        f"while it is {side} (z-score {float(p['exitZ']):.2f} or more), coming back below {float(p['enterZ']):.2f}.",
    ]
    if int(p.get("coreLen") or 0):
        how = "only while the price is also above" if p.get("combine") == "and" else "and also whenever the price is above"
        steps.append(f"It holds {how} its {bars_text(p['coreLen'], iv)} average.")
    else:
        steps.append("Otherwise it simply holds.")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split evenly between {mk}.")
    return {
        "summary": f"Holds {mk}, stepping aside while ETH-vs-BTC volatility is out of its normal range.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Speculative ETH-led blow-offs and coin-specific shocks that are followed by weak months.",
        "whenItLoses": "Healthy rallies in which one coin simply moves faster for a while; it sits out gains.",
    }
