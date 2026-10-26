import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["xs_volmom"]
MK = ["BTC-EUR", "ETH-EUR", "SOL-EUR"]


def spec(markets=MK, **params):
    p = dict(FAM.default_params())
    p.update(params)
    return normalize_spec({"family": "xs_volmom", "markets": list(markets), "interval": "4h", "params": p}, FAM)


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
            first = int(np.argmax(~np.isnan(t).all(axis=1)))
            assert first <= FAM.warmup(p)
            v = t[first:]
            assert not np.isnan(v).any() and (v >= 0).all() and (v.sum(axis=1) <= mw + 1e-9).all()
    ex = FAM.explain(spec(targetVol=0.8, absMom=True, rank="sharpe", weighting="invvol", skip=2))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_no_lookahead():
    cd = cd3()
    for p in ({"lookback": 6, "hold": 6, "count": 1},
              {"lookback": 20, "skip": 2, "hold": 3, "count": 2, "rank": "sharpe", "weighting": "invvol",
               "targetVol": 0.5, "absMom": True, "volLen": 15}):
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


def _trend(n, g, noise, seed):
    r = np.random.default_rng(seed)
    return 100 * np.exp(np.cumsum(g + noise * r.standard_normal(n)))


def test_buys_leaders_and_abs_mom_goes_to_cash():
    n = 80
    a, b, c = _trend(n, 0.02, 0.002, 1), _trend(n, -0.01, 0.002, 2), _trend(n, 0.005, 0.002, 3)
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b), "SOL-EUR": frame_of(c)}
    w = FAM.targets(cd, spec(lookback=5, hold=1, count=2, volLen=10))
    assert np.isnan(w.iloc[:10].to_numpy()).all()
    assert np.allclose(w["BTC-EUR"].iloc[12:], 0.5) and np.allclose(w["SOL-EUR"].iloc[12:], 0.5)
    assert (w["ETH-EUR"].iloc[12:] == 0).all()
    # count 3 with absMom: the falling coin's slot stays cash
    w3 = FAM.targets(cd, spec(lookback=5, hold=1, count=3, volLen=10, absMom=True))
    assert (w3["ETH-EUR"].iloc[12:] == 0).all()
    assert np.allclose(w3.iloc[12:].sum(axis=1), 2 / 3)


def test_sharpe_rank_and_invvol_and_target_vol():
    n = 120
    smooth = _trend(n, 0.01, 0.001, 1)    # slower but calm
    wild = _trend(n, 0.012, 0.05, 2)      # a bit faster on average, very noisy
    cd = {"BTC-EUR": frame_of(smooth), "ETH-EUR": frame_of(wild)}
    mk = ["BTC-EUR", "ETH-EUR"]
    w = FAM.targets(cd, spec(markets=mk, lookback=30, hold=1, count=1, volLen=30, rank="sharpe"))
    assert (w["BTC-EUR"].iloc[40:] == 1.0).all()
    # inverse-vol weights give the calm coin the bigger share, summing to 1
    w2 = FAM.targets(cd, spec(markets=mk, lookback=30, hold=1, count=2, volLen=30, weighting="invvol"))
    v = w2.iloc[40:]
    assert (v["BTC-EUR"] > v["ETH-EUR"]).all() and np.allclose(v.sum(axis=1), 1.0)
    # a vol target below the wild coin's vol scales it down
    w3 = FAM.targets(cd, spec(markets=["ETH-EUR"], lookback=30, hold=1, count=1, volLen=30, targetVol=0.5))
    e = w3["ETH-EUR"].iloc[40:]
    assert ((e > 0) & (e < 0.5)).any() and (e <= 1.0).all()
