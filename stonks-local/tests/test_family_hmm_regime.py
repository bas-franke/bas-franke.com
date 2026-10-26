import random

import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["hmm_regime"]


def spec(markets=("BTC-EUR",), **params):
    p = {"fitLen": 150, "fitMode": "rolling", "refit": 10, "retBars": 1, "label": "mean",
         "enter": 0.6, "exit": 0.4, "iters": 5, **params}
    return normalize_spec({"family": "hmm_regime", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def regime_candles(seed=3):
    """calm rise (300) -> stormy fall (150) -> calm rise (150)"""
    r = np.random.default_rng(seed)
    ret = np.concatenate([r.normal(0.004, 0.01, 300), r.normal(-0.006, 0.04, 150), r.normal(0.004, 0.01, 150)])
    c = 100 * np.exp(np.cumsum(ret))
    o = np.concatenate([[100.0], c[:-1]])
    idx = pd.Index(1_600_000_000_000 + 86_400_000 * np.arange(len(c), dtype=np.int64), name="ts")
    return {"BTC-EUR": pd.DataFrame({"open": o, "high": np.maximum(o, c), "low": np.minimum(o, c), "close": c,
                                     "volume": np.ones(len(c))}, index=idx)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enter": 0.4, "exit": 0.6}}) is not None
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(500, 1), "ETH-EUR": synth(500, 2, price=1500)}
    for _ in range(6):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        p.update(fitLen=min(p["fitLen"], 200), refit=max(p["refit"], 20))
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        first = int(np.argmax(rows))
        assert not np.isnan(v[first:]).any()
        assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_holds_in_calm_rise_and_exits_in_stormy_fall():
    for label in ("mean", "lowvol"):
        w = FAM.targets(regime_candles(), spec(label=label, fitLen=200))["BTC-EUR"].to_numpy()
        assert np.isnan(w[:199]).all() and np.isfinite(w[200])
        # bars 200-300: the window has seen only one regime, so the two states split noise (no assertion)
        assert np.mean(w[330:450]) < 0.2, label             # stormy fall: out
        assert np.mean(w[520:600]) > 0.8, label             # calm again: back in


def test_no_lookahead():
    cd = {"BTC-EUR": synth(700, 7), "ETH-EUR": synth(700, 8, price=1500)}
    rng = np.random.default_rng(1)
    for mode in ("rolling", "expanding"):
        s = spec(["BTC-EUR", "ETH-EUR"], fitMode=mode, retBars=2)
        full = FAM.targets(cd, s).to_numpy()
        for k in (260, 480):
            t = FAM.targets({m: df.iloc[: k + 1] for m, df in cd.items()}, s).to_numpy()
            np.testing.assert_array_equal(t, full[: k + 1])
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
