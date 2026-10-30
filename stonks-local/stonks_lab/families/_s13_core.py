"""Session 13: the frozen main strategy every s13_ family trims. Its settings cannot change: an s13_ book is
s9_cyclebull at its default settings (what the live bot runs) with a risk layer that only ever lowers the size."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import get_family
from ._base import max_weight, normalize_spec, single_market

CORE = "s9_cyclebull"
_CACHE: dict = {}


def core_weights(df: pd.DataFrame, market: str) -> np.ndarray:
    """The main strategy's own weights on ``df``, untouched (a pure function of the candles, so kept per candle set)."""
    key = (market, len(df), int(df.index[0]), int(df.index[-1]), float(df["close"].iloc[-1]))
    if key not in _CACHE:
        if len(_CACHE) >= 12:
            _CACHE.clear()
        fam = get_family(CORE)
        interval = "15m"
        spec = normalize_spec({"family": CORE, "markets": [market], "interval": interval, "params": {}}, fam)
        _CACHE[key] = fam.targets({market: df}, spec)[market].to_numpy(np.float64)
    return _CACHE[key].copy()


def trimmed(candles: dict, spec: dict, trim) -> tuple[str, pd.DataFrame, np.ndarray]:
    """(market, candles, weights) with ``trim(df, core, params) -> multiplier 0..1 per bar`` applied to the core."""
    m, df = single_market(candles, spec)
    core = core_weights(df, m)
    mult = np.clip(np.nan_to_num(np.asarray(trim(df, core, spec["params"]), dtype=np.float64), nan=1.0), 0.0, 1.0)
    return m, df, core * mult * max_weight(spec)
