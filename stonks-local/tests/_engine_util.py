"""Helpers for the engine tests: synthetic candles and a family with fixed targets."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stonks_lab.families import register_family  # noqa: E402

T0 = 1_600_000_000_000
H4 = 14_400_000


def synth(n: int, seed: int = 1, start: int = T0, step: int = H4, drift: float = 0.0002, vol: float = 0.02,
          price: float = 20000.0) -> pd.DataFrame:
    r = np.random.default_rng(seed)
    c = price * np.exp(np.cumsum(r.normal(drift, vol, n)))
    o = np.concatenate([[price], c[:-1]])
    h = np.maximum(o, c) * (1 + np.abs(r.normal(0, 0.005, n)))
    l = np.minimum(o, c) * (1 - np.abs(r.normal(0, 0.005, n)))
    return pd.DataFrame({"open": o, "high": h, "low": l, "close": c, "volume": np.ones(n)},
                        index=pd.Index(start + step * np.arange(n, dtype=np.int64), name="ts"))


def bars(rows, start: int = T0, step: int = H4) -> pd.DataFrame:
    """rows of (open, high, low, close)."""
    a = np.asarray(rows, dtype=np.float64)
    return pd.DataFrame({"open": a[:, 0], "high": a[:, 1], "low": a[:, 2], "close": a[:, 3],
                         "volume": np.ones(len(a))},
                        index=pd.Index(start + step * np.arange(len(a), dtype=np.int64), name="ts"))


def _fixed_targets(candles, spec, start_time=None):
    w = spec["params"]["w"]
    out = {}
    for m in spec["markets"]:
        df = candles[m]
        col = w[m] if isinstance(w, dict) else w
        arr = np.full(len(df), np.nan)
        arr[: len(col)] = np.asarray(col, dtype=np.float64)
        out[m] = arr
    first = spec["markets"][0]
    return pd.DataFrame(out, index=pd.Index(np.asarray(candles[first].index, dtype=np.int64), name="ts"))


FIXED = types.SimpleNamespace(
    NAME="test_fixed", VERSION=1, TITLE="fixed targets (tests)", MULTI_MARKET=True,
    default_params=lambda: {"w": []}, param_space=lambda: {}, explain=lambda spec: {"summary": "test"},
    targets=_fixed_targets,
)
register_family(FIXED)


def fixed_spec(w, markets=("BTC-EUR",), **kw) -> dict:
    spec = {"family": "test_fixed", "markets": list(markets), "interval": "4h", "params": {"w": w}}
    spec.update(kw)
    return spec
