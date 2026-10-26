"""Shared plumbing for strategy families: spec defaults, alignment, param spaces and the Family record."""
from __future__ import annotations

import copy
import math
import random
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
import pandas as pd

DEFAULT_RISK = {"maxWeight": 1.0, "stopLossPct": None, "takeProfitPct": None, "trailingStopPct": None}
DEFAULT_EXECUTION = {"orderType": "limit", "limitOffsetBps": 5, "postOnly": True, "timeoutBars": 1,
                     "fallback": "cancel"}
INTERVALS = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "1W"]


def normalize_spec(spec: dict, family: "Family | None" = None) -> dict:
    """A deep copy of ``spec`` with risk/execution defaults (SPEC §2) and the family's default params filled in."""
    s = copy.deepcopy(spec)
    s["risk"] = {**DEFAULT_RISK, **(s.get("risk") or {})}
    s["execution"] = {**DEFAULT_EXECUTION, **(s.get("execution") or {})}
    if family is not None:
        s["params"] = {**family.default_params(), **(s.get("params") or {})}
        s.setdefault("familyVersion", family.version)
    else:
        s["params"] = dict(s.get("params") or {})
    s["markets"] = list(s.get("markets") or [])
    mw = float(s["risk"]["maxWeight"])
    if not (0.0 <= mw <= 1.0):
        raise ValueError(f"risk.maxWeight must be within 0..1, got {mw}")
    if s.get("interval") is not None and s["interval"] not in INTERVALS:
        raise ValueError(f"unknown interval {s['interval']!r}")
    return s


def max_weight(spec: dict) -> float:
    r = spec.get("risk") or {}
    v = r.get("maxWeight", 1.0)
    return 1.0 if v is None else float(v)


def single_market(candles: dict, spec: dict) -> tuple[str, pd.DataFrame]:
    markets = spec.get("markets") or []
    if len(markets) != 1:
        raise ValueError(f"{spec.get('family')} trades exactly one market, got {markets}")
    m = markets[0]
    if m not in candles:
        raise KeyError(f"no candles for {m}")
    return m, candles[m]


def frame(index, columns: dict[str, np.ndarray]) -> pd.DataFrame:
    df = pd.DataFrame({k: np.asarray(v, dtype=np.float64) for k, v in columns.items()},
                      index=pd.Index(np.asarray(index, dtype=np.int64), name="ts"))
    return df


def union_index(candles: dict, markets: list[str]) -> np.ndarray:
    idx = None
    for m in markets:
        i = np.asarray(candles[m].index, dtype=np.int64)
        idx = i if idx is None else np.union1d(idx, i)
    return np.asarray(idx if idx is not None else [], dtype=np.int64)


def aligned_close(candles: dict, market: str, index: np.ndarray) -> np.ndarray:
    """Closes of ``market`` on ``index``; a missing bar (no trades) carries the previous close; NaN before listing."""
    df = candles[market]
    s = pd.Series(df["close"].to_numpy(np.float64), index=np.asarray(df.index, dtype=np.int64))
    return s.reindex(index).ffill().to_numpy(np.float64)


def anchor_index(index: np.ndarray, start_time: int | None) -> int:
    if start_time is None:
        return 0
    return int(np.searchsorted(index, int(start_time), side="left"))


# --------------------------------------------------------------------------------------------- param spaces
# A param space maps name -> descriptor:
#   {"type": "int", "min": a, "max": b, "log": bool?, "zero": bool?}   ("zero": 0 is also allowed and means off)
#   {"type": "float", "min": a, "max": b, "log": bool?}
#   {"type": "bool"}
#   {"type": "choice", "values": [...]}
# plus a human "description". Constraints between params live in the family's ``valid_params``.

def sample_params(space: dict, rng: random.Random | None = None) -> dict:
    rng = rng or random.Random()
    out = {}
    for k, d in space.items():
        t = d["type"]
        if t == "bool":
            out[k] = rng.random() < 0.5
        elif t == "choice":
            out[k] = rng.choice(d["values"])
        elif t in ("int", "float"):
            lo, hi = d["min"], d["max"]
            if d.get("zero") and rng.random() < 0.3:
                out[k] = 0
                continue
            if d.get("log") and lo > 0:
                v = math.exp(rng.uniform(math.log(lo), math.log(hi)))
            else:
                v = rng.uniform(lo, hi)
            out[k] = int(round(v)) if t == "int" else round(v, 4)
        else:
            raise ValueError(f"unknown param type {t}")
    return out


def check_space(params: dict, space: dict) -> str | None:
    for k, d in space.items():
        if k not in params:
            return f"missing param {k}"
        v = params[k]
        t = d["type"]
        if t == "bool":
            if not isinstance(v, bool):
                return f"{k} must be true/false"
        elif t == "choice":
            if v not in d["values"]:
                return f"{k} must be one of {d['values']}"
        else:
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                return f"{k} must be a number"
            if t == "int" and int(v) != v:
                return f"{k} must be an integer"
            if d.get("zero") and v == 0:
                continue
            if v < d["min"] or v > d["max"]:
                return f"{k}={v} outside {d['min']}..{d['max']}"
    return None


@dataclass
class Family:
    """A registered strategy family. ``targets(candles, spec, start_time=None)`` returns target weights."""
    name: str
    version: int
    title: str
    targets: Callable[..., pd.DataFrame]
    param_space: Callable[[], dict]
    default_params: Callable[[], dict]
    explain: Callable[[dict], dict]
    valid_params: Callable[[dict], str | None] = lambda p: None
    warmup: Callable[[dict], int] = lambda p: 0
    required_markets: Callable[[dict], list[str]] | None = None
    bot_ready: bool = False
    multi_market: bool = False
    anchored: bool = False  # targets depend on where trading starts (start_time); evaluate recomputes per window
    # Rows of an older family version below this one have a confirmed bug (e.g. look-ahead): the leaderboard ignores
    # them and `lab.py rescore --family <name> --rerun-superseded` re-runs their specs at the current version.
    invalid_below: int = 1
    module: Any = field(default=None, repr=False)

    def validate(self, spec: dict) -> str | None:
        """None when ``spec['params']`` is usable, otherwise a plain error message."""
        params = {**self.default_params(), **(spec.get("params") or {})}
        err = check_space(params, self.param_space())
        return err or self.valid_params(params)

    def markets_needed(self, spec: dict) -> list[str]:
        ms = list(spec.get("markets") or [])
        if self.required_markets is not None:
            for m in self.required_markets(spec):
                if m not in ms:
                    ms.append(m)
        return ms

    def sample(self, rng: random.Random | None = None, tries: int = 200) -> dict:
        """Random valid params from the param space (for searches)."""
        rng = rng or random.Random()
        for _ in range(tries):
            p = sample_params(self.param_space(), rng)
            if self.valid_params(p) is None:
                return p
        return self.default_params()


# --------------------------------------------------------------------------------------------- explanation helpers
_INTERVAL_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "6h": 360, "8h": 480,
                 "12h": 720, "1d": 1440, "1W": 10080}
_INTERVAL_WORD = {"1m": "1-minute", "5m": "5-minute", "15m": "15-minute", "30m": "30-minute", "1h": "hourly",
                  "2h": "2-hour", "4h": "4-hour", "6h": "6-hour", "8h": "8-hour", "12h": "12-hour", "1d": "daily",
                  "1W": "weekly"}


def duration_text(minutes: float) -> str:
    if minutes < 90:
        return f"{minutes:.0f} minutes"
    h = minutes / 60
    if h < 48:
        return f"{h:.0f} hours"
    d = h / 24
    if d < 21:
        return f"{d:.0f} days"
    if d < 120:
        return f"{d / 7:.0f} weeks"
    return f"{d / 30.4:.0f} months"


def bars_text(n: int, interval: str | None) -> str:
    """'48 candles (8 days)' for 4h; just '48 candles' when the interval is unknown."""
    n = int(n)
    word = "candle" if n == 1 else "candles"
    if interval in _INTERVAL_MIN:
        return f"{n} {_INTERVAL_WORD[interval]} {word} (about {duration_text(n * _INTERVAL_MIN[interval])})"
    return f"{n} {word}"


def market_names(spec: dict) -> str:
    ms = [m.split("-")[0] for m in spec.get("markets") or []]
    if len(ms) <= 1:
        return ms[0] if ms else "the market"
    return ", ".join(ms[:-1]) + " and " + ms[-1]


def pct(x: float) -> str:
    v = float(x) * 100
    return f"{v:.0f} %" if abs(v - round(v)) < 1e-9 else f"{v:.1f} %"


def risk_steps(spec: dict) -> list[str]:
    r = spec.get("risk") or {}
    out = []
    mw = r.get("maxWeight", 1.0)
    if mw is not None and mw < 1:
        out.append(f"It never puts more than {pct(mw)} of the money into coins; the rest stays in euros.")
    if r.get("stopLossPct"):
        out.append(f"Safety net: if the price falls {pct(r['stopLossPct'])} below the average buy price, it sells "
                   "everything at once and waits for a fresh buy signal.")
    if r.get("trailingStopPct"):
        out.append(f"Trailing stop: once in a position, it sells if the price drops {pct(r['trailingStopPct'])} "
                   "from the highest price since buying.")
    if r.get("takeProfitPct"):
        out.append(f"It cashes in the whole position once it is up {pct(r['takeProfitPct'])} on the average buy price.")
    ex = spec.get("execution") or {}
    if ex.get("orderType", "limit") == "limit":
        out.append("Orders are placed as limit orders slightly better than the last price, so it usually pays the "
                   "lower maker fee (0.15 %); an order that does not fill in time is "
                   + ("sent as a market order instead." if ex.get("fallback") == "market" else "skipped."))
    else:
        out.append("Orders are market orders at the next candle's open (taker fee 0.25 % plus a little slippage).")
    return out
