"""Session 14: the live book as parts. `book` is s9_cyclebull (settings may be changed) with the s13_timestop layer on top;
`stopped` puts that layer on any weights, for a family that changes the main strategy's own code."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import s13_timestop, s9_cyclebull

_CACHE: dict = {}


def main_params(main: dict | None = None) -> dict:
    return {**s9_cyclebull.default_params(), **(main or {})}


def stopped(df: pd.DataFrame, weights: np.ndarray, stop: dict | None = None) -> np.ndarray:
    """``weights`` with the live time stop on its crash buys. ``stop`` overrides the layer's settings."""
    p = {**s13_timestop.default_params(), **(stop or {})}
    return weights * np.clip(np.nan_to_num(s13_timestop._trim(df, weights, p), nan=1.0), 0.0, 1.0)


def book(df: pd.DataFrame, main: dict | None = None, stop: dict | None = None) -> np.ndarray:
    """The live book's weights on ``df``. Pure function of the candles, so kept per candle set and settings."""
    key = (len(df), int(df.index[0]), int(df.index[-1]), float(df["close"].iloc[-1]), json.dumps([main, stop], sort_keys=True))
    if key not in _CACHE:
        if len(_CACHE) >= 24:
            _CACHE.clear()
        _CACHE[key] = stopped(df, np.nan_to_num(s9_cyclebull._weights(df, main_params(main)), nan=0.0), stop)
    return _CACHE[key].copy()
