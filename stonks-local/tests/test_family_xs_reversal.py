import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["xs_reversal"]
MK = ["BTC-EUR", "ETH-EUR", "SOL-EUR"]


def spec(markets=MK, **params):
    return normalize_spec({"family": "xs_reversal", "markets": list(markets), "interval": "4h",
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
            first = int(np.argmax(~np.isnan(t).all(axis=1)))
            assert first <= FAM.warmup(p)
            v = t[first:]
            assert not np.isnan(v).any() and (v >= 0).all() and (v.sum(axis=1) <= mw + 1e-9).all()
    for mode in ("reversal", "momentum"):
        ex = FAM.explain(spec(mode=mode, trendSma=50))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_no_lookahead():
    cd = cd3()
    for p in ({"lookback": 6, "hold": 6, "count": 1, "trendSma": 0, "mode": "reversal"},
              {"lookback": 20, "hold": 3, "count": 2, "trendSma": 40, "mode": "momentum"}):
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


def test_buys_laggard_and_holds_until_rebalance():
    n = 60
    t = np.arange(n, dtype=np.float64)
    a = 100 * 1.02 ** t          # always the leader
    b = 100 * 0.99 ** t          # always the laggard
    c = 100 * 1.005 ** t
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b), "SOL-EUR": frame_of(c)}
    w = FAM.targets(cd, spec(lookback=5, hold=1, count=1, mode="reversal"))
    assert np.isnan(w.iloc[:5].to_numpy()).all()
    assert (w["ETH-EUR"].iloc[5:] == 1.0).all() and (w["BTC-EUR"].iloc[5:] == 0).all()
    m = FAM.targets(cd, spec(lookback=5, hold=1, count=2, mode="momentum"))
    assert (m["BTC-EUR"].iloc[5:] == 0.5).all() and (m["SOL-EUR"].iloc[5:] == 0.5).all()
    assert (m["ETH-EUR"].iloc[5:] == 0).all()
    # picks only change at block starts: with hold=10 the picks are constant inside each 10-candle block
    b2 = np.where(t < 30, 100 * 0.99 ** t, 100 * 0.99 ** 29 * 1.05 ** (t - 29))  # ETH turns into the leader
    cd2 = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b2), "SOL-EUR": frame_of(c)}
    w2 = FAM.targets(cd2, spec(lookback=5, hold=10, count=1, mode="reversal"))
    blocks = (w2.index.to_numpy() // (H4 * 10))
    eth = w2["ETH-EUR"].to_numpy()
    for blk in np.unique(blocks[5:]):
        vals = eth[5:][blocks[5:] == blk]
        assert len(set(vals.tolist())) == 1


def test_trend_gate_sells_below_sma():
    n = 80
    t = np.arange(n, dtype=np.float64)
    a = 100 * 1.01 ** t
    b = np.where(t < 50, 100 * 1.002 ** t, 100 * 1.002 ** 49 * 0.95 ** (t - 49))  # laggard that then crashes
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b)}
    w = FAM.targets(cd, spec(markets=["BTC-EUR", "ETH-EUR"], lookback=5, hold=100, count=1, trendSma=10))
    eth = w["ETH-EUR"].to_numpy()
    assert eth[20] == 1.0                    # the laggard above its SMA is held
    assert (eth[55:] == 0).all()             # sold once it closes below its SMA, slot stays cash
    assert (w["BTC-EUR"].to_numpy()[55:] == 0).all()
