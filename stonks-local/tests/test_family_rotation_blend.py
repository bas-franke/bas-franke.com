import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["rotation_blend"]
MK = ["BTC-EUR", "ETH-EUR", "SOL-EUR"]


def spec(markets=MK, **params):
    return normalize_spec({"family": "rotation_blend", "markets": list(markets), "interval": "4h",
                           "params": params}, FAM)


def frame_of(c):
    c = np.asarray(c, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def cd3(n=900):
    return {"BTC-EUR": synth(n, 1), "ETH-EUR": synth(n, 2, price=1500), "SOL-EUR": synth(n, 3, price=100)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready and FAM.multi_market
    rng = random.Random(5)
    cd = cd3()
    for _ in range(25):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mw in (1.0, 0.6):
            s = spec(**p)
            s["risk"]["maxWeight"] = mw
            t = FAM.targets(cd, s).to_numpy()
            if np.isnan(t).all():
                continue
            first = int(np.argmax(~np.isnan(t).all(axis=1)))
            assert first <= FAM.warmup(p)
            v = t[first:]
            assert not np.isnan(v).any() and (v >= 0).all() and (v.sum(axis=1) <= mw + 1e-9).all()
    ex = FAM.explain(spec(regimeSma=50, absMom=True))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_no_lookahead():
    cd = cd3()
    for p in ({"lookback": 5, "mult": 2.0, "horizons": 3, "top": 1, "regimeSma": 0, "absMom": True},
              {"lookback": 8, "mult": 1.5, "horizons": 2, "top": 2, "regimeSma": 40, "absMom": False}):
        s = spec(**p)
        full = FAM.targets(cd, s).to_numpy()
        rng = np.random.default_rng(7)
        for k in (300, 650):
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


def test_ranks_by_average_over_horizons():
    n = 80
    t = np.arange(n, dtype=np.float64)
    a = 100 * 1.02 ** t                       # steady leader over long horizons
    b = np.where(t < 73, 100.0, 100 * 1.05 ** (t - 72))  # flat, then a short burst
    c = 100 * 0.99 ** t                       # always falling
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b), "SOL-EUR": frame_of(c)}
    # One short horizon picks the burst coin, a blend with long horizons keeps the steady leader first.
    short = FAM.targets(cd, spec(lookback=3, mult=3.0, horizons=1, top=1, regimeSma=0, absMom=True))
    assert short["ETH-EUR"].iloc[75] == 1.0
    blend = FAM.targets(cd, spec(lookback=3, mult=3.0, horizons=3, top=1, regimeSma=0, absMom=True))
    assert np.isnan(blend.iloc[:27].to_numpy()).all()
    assert blend["BTC-EUR"].iloc[75] == 1.0 and blend["ETH-EUR"].iloc[75] == 0.0
    # The falling coin is never held while absMom is on, even with spare slots.
    full = FAM.targets(cd, spec(lookback=3, mult=3.0, horizons=3, top=3, regimeSma=0, absMom=True))
    assert (full["SOL-EUR"].iloc[27:] == 0).all() and np.isclose(full["BTC-EUR"].iloc[40], 1 / 3)
    off = FAM.targets(cd, spec(lookback=3, mult=3.0, horizons=3, top=3, regimeSma=0, absMom=False))
    assert np.isclose(off["SOL-EUR"].iloc[40], 1 / 3)


def test_regime_gate_goes_to_cash():
    n = 120
    t = np.arange(n, dtype=np.float64)
    btc = np.where(t < 80, 100 * 1.01 ** t, 100 * 1.01 ** 79 * 0.97 ** (t - 79))
    eth = 100 * 1.02 ** t
    cd = {"BTC-EUR": frame_of(btc), "ETH-EUR": frame_of(eth)}
    w = FAM.targets(cd, spec(markets=["BTC-EUR", "ETH-EUR"], lookback=5, mult=2.0, horizons=2, top=1,
                             regimeSma=20, absMom=True))
    assert w["ETH-EUR"].iloc[60] == 1.0
    assert w.iloc[110].sum() == 0.0
