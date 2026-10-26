import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["kalman_core_a04"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), "span": 10, "volShort": 5, "volLong": 30, **params}
    return normalize_spec({"family": "kalman_core_a04", "markets": list(markets), "interval": "1d", "params": p},
                          FAM)


def path_frame(c):
    c = np.asarray(c, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def noisy(logpath, seed=1, vol=0.01):
    r = np.random.default_rng(seed)
    return 100 * np.exp(np.asarray(logpath) + r.normal(0, vol, len(logpath)))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "zIn": 0.0, "zOut": 0.5}})
    assert FAM.validate({"params": {**FAM.default_params(), "volShort": 50, "volLong": 40}})
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(1500, 2), "ETH-EUR": synth(1500, 3, price=1500)}
    for _ in range(12):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}):
            continue
        for ms in (("BTC-EUR",), ("BTC-EUR", "ETH-EUR")):
            s = normalize_spec({"family": "kalman_core_a04", "markets": list(ms), "interval": "1d", "params": p},
                               FAM)
            v = FAM.targets(cd, s).to_numpy()
            rows = np.isfinite(v).all(axis=1)
            assert rows.any()
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 1 + 1e-12).all()
    ex = FAM.explain(spec(markets=("BTC-EUR", "ETH-EUR"), weighting="invvol"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_buys_uptrend_sells_downtrend():
    lp = np.concatenate([np.linspace(0, 0.6, 120), np.linspace(0.6, -0.2, 120)])
    w = FAM.targets({"BTC-EUR": path_frame(noisy(lp))}, spec(adaptive=False))["BTC-EUR"].to_numpy()
    assert np.nanmean(w[60:120]) > 0.9         # rising: held
    assert np.nanmean(w[160:240]) < 0.1        # falling: out
    assert np.isnan(w[:30]).all()


def test_adaptive_ignores_short_crash():
    """a 3-candle 15 % crash inside a steady uptrend: the adaptive filter keeps holding longer than the fixed one."""
    lp = np.linspace(0, 1.0, 200)
    lp[150:153] -= np.array([0.05, 0.10, 0.15])
    lp[153:] -= 0.15 * np.exp(-np.arange(47) / 2.0)  # quick recovery
    c = path_frame(noisy(lp, vol=0.004))
    fixed = FAM.targets({"BTC-EUR": c}, spec(adaptive=False, zOut=1.0, zIn=1.5))["BTC-EUR"].to_numpy()
    adapt = FAM.targets({"BTC-EUR": c}, spec(adaptive=True, zOut=1.0, zIn=1.5))["BTC-EUR"].to_numpy()
    assert np.nansum(adapt[150:170]) >= np.nansum(fixed[150:170])


def test_invvol_weights_calmer_coin_more():
    lp = np.linspace(0, 1.0, 300)
    cd = {"BTC-EUR": path_frame(noisy(lp, 1, 0.005)), "ETH-EUR": path_frame(noisy(lp, 2, 0.02))}
    w = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), weighting="invvol", zIn=-1.0, zOut=-3.0))
    tail = w.iloc[-50:]
    assert (tail["BTC-EUR"] > tail["ETH-EUR"]).all()
    assert np.allclose(tail.sum(axis=1), 1.0)
    eq = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), weighting="equal", zIn=-1.0, zOut=-3.0)).iloc[-50:]
    assert np.allclose(eq.to_numpy(), 0.5)


def test_no_lookahead():
    """truncating the candles, or scrambling prices after bar k, never changes decisions up to k."""
    rng = np.random.default_rng(11)
    cd = {"BTC-EUR": synth(1200, 1), "ETH-EUR": synth(1200, 2, price=1500)}
    for params in ({"adaptive": True}, {"adaptive": False, "zIn": 0.3, "zOut": -0.3},
                   {"weighting": "invvol", "span": 60, "volLong": 200, "volShort": 20}):
        for ms in (("BTC-EUR",), ("BTC-EUR", "ETH-EUR")):
            s = spec(markets=ms, **params)
            full = FAM.targets(cd, s).to_numpy()
            assert np.isfinite(full).any()
            for k in (400, 900):
                trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
                np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
                pert = {}
                for m, df in cd.items():
                    d = df.copy()
                    f = rng.uniform(0.3, 3.0, len(d) - k - 1)
                    for col in ("open", "high", "low", "close"):
                        x = d[col].to_numpy().copy()
                        x[k + 1:] *= f
                        d[col] = x
                    pert[m] = d
                np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])
