"""Session 13 layers only ever lower the live main strategy, and stay off the bot's offered list."""
from __future__ import annotations

import numpy as np
import pandas as pd

from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families._s13_core import core_weights

T0 = 1_600_000_000_000
STEP = 15 * 60_000
NAMES = ("s13_timestop", "s13_parabola", "s13_breadth", "s13_lockgain", "s13_equitybrake")


def _df(n=6000):
    rng = np.random.default_rng(13)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0001, 0.004, n)))
    idx = T0 + STEP * np.arange(n, dtype=np.int64)
    return pd.DataFrame(
        {"open": close, "high": close * 1.002, "low": close * 0.998, "close": close, "volume": np.full(n, 1000.0)},
        index=pd.Index(idx, name="ts"),
    )


def test_session13_layers_only_lower_the_main_strategy():
    df = _df()
    core = np.nan_to_num(core_weights(df, "BTC-EUR"))
    for name in NAMES:
        fam = FAMILIES[name]
        assert fam.bot_ready is False
        assert fam.validate({"params": fam.default_params()}) is None
        spec = normalize_spec({"family": name, "markets": ["BTC-EUR"], "interval": "15m", "params": fam.default_params()}, fam)
        w = fam.targets({"BTC-EUR": df}, spec)["BTC-EUR"].to_numpy()
        got = np.nan_to_num(w)
        assert float(got.min()) >= -1e-9
        assert float((got - core).max()) <= 1e-9
        k = 4500
        part = fam.targets({"BTC-EUR": df.iloc[:k]}, spec)["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(np.nan_to_num(w[:k], nan=-1), np.nan_to_num(part, nan=-1))
        ex = fam.explain(spec)
        assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]
