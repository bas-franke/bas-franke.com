"""Session 2 and Session 3 families stay inside the account and are not offered to the live bot."""
from __future__ import annotations

import numpy as np
import pandas as pd

from stonks_lab.families import FAMILIES, normalize_spec

T0 = 1_600_000_000_000
DAY = 86_400_000
NAMES = (
    "s2_voltarget", "s2_crash", "s2_quarter", "s2_slope", "s2_golden",
    "s3_stoch", "s3_macd", "s3_fisher", "s3_bands", "s3_rsi",
)


def _df(n=120):
    close = 100 * np.cumprod(1 + np.linspace(-0.002, 0.01, n))
    close = np.concatenate([close, close[-1] * np.linspace(1.0, 0.7, 15)])
    high = close * 1.01
    low = close * 0.99
    idx = T0 + DAY * np.arange(len(close), dtype=np.int64)
    return pd.DataFrame(
        {"open": close, "high": high, "low": low, "close": close, "volume": np.full(len(close), 1000.0)},
        index=pd.Index(idx, name="ts"),
    )


def test_session_families_are_registered_and_not_bot_ready():
    for name in NAMES:
        fam = FAMILIES[name]
        assert fam.bot_ready is False
        assert fam.validate({"params": fam.default_params()}) is None
        spec = normalize_spec(
            {"family": name, "markets": ["BTC-EUR"], "interval": "1d", "params": fam.default_params()},
            fam,
        )
        w = fam.targets({"BTC-EUR": _df()}, spec)["BTC-EUR"].to_numpy()
        finite = w[np.isfinite(w)]
        assert finite.size > 0
        assert float(finite.min()) >= -1e-9
        assert float(finite.max()) <= 1.0 + 1e-9
        ex = fam.explain(spec)
        assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]
