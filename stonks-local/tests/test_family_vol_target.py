import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["vol_target"]


def spec(**params):
    return normalize_spec({"family": "vol_target", "markets": ["BTC-EUR"], "interval": "4h", "params": params}, FAM)


def two_regimes(n=400):
    """First half calm (0.5 % moves), second half wild (4 % moves), alternating up/down, flat trend."""
    r = np.where(np.arange(n) % 2 == 0, 1.0, -1.0) * np.where(np.arange(n) < n // 2, 0.005, 0.04)
    c = 20000 * np.exp(np.cumsum(r))
    o = np.concatenate([[20000], c[:-1]])
    return pd.DataFrame({"open": o, "high": np.maximum(o, c), "low": np.minimum(o, c), "close": c,
                         "volume": np.ones(n)}, index=pd.Index(T0 + H4 * np.arange(n, dtype=np.int64), name="ts"))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready
    rng = random.Random(1)
    cd = {"BTC-EUR": synth(800, 1)}
    for _ in range(20):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mw in (1.0, 0.6):
            s = spec(**p)
            s["risk"]["maxWeight"] = mw
            v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
            first = int(np.argmax(~np.isnan(v)))
            assert not np.isnan(v[first:]).any() and (v[first:] >= 0).all() and (v[first:] <= mw + 1e-12).all()
            assert first <= FAM.warmup(p)
    ex = FAM.explain(spec(trendSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]


def test_smaller_when_wild():
    cd = {"BTC-EUR": two_regimes()}
    for method in ("stdev", "atr"):
        w = FAM.targets(cd, spec(volMethod=method, volLookback=20, targetVol=0.5, step=0.05))["BTC-EUR"].to_numpy()
        # calm: 0.5 %/bar * sqrt(2190) ~ 23 %/yr (atr ~ the same) -> capped at 1; wild: ~187 %/yr -> 0.25
        assert np.isnan(w[:19]).all()
        assert (w[30:200] == 1.0).all(), method
        assert (w[240:] <= 0.35).all() and (w[240:] >= 0.2).all(), method


def test_trend_and_momentum_filters():
    n = 300
    c = np.concatenate([np.linspace(100, 200, n // 2), np.linspace(200, 100, n // 2)])
    df = pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.ones(n)},
                      index=pd.Index(T0 + H4 * np.arange(n, dtype=np.int64), name="ts"))
    for kw in ({"trendSma": 20}, {"momLookback": 20}):
        w = FAM.targets({"BTC-EUR": df}, spec(volLookback=10, targetVol=2.0, **kw))["BTC-EUR"].to_numpy()
        assert (w[30:140] > 0).all() and (w[180:] == 0).all(), kw


def test_no_lookahead():
    cd = {"BTC-EUR": synth(900, 1)}
    for p in (dict(volMethod="stdev", trendSma=50, momLookback=30), dict(volMethod="atr", volLookback=14)):
        s = spec(**p)
        full = FAM.targets(cd, s).to_numpy()
        rng = np.random.default_rng(5)
        for k in (300, 650):
            t = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}, s).to_numpy()
            np.testing.assert_array_equal(t, full[: k + 1])
            d = cd["BTC-EUR"].copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            np.testing.assert_array_equal(FAM.targets({"BTC-EUR": d}, s).to_numpy()[: k + 1], full[: k + 1])
