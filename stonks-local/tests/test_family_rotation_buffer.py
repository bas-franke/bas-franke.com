import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["rotation_buffer"]
MK = ["BTC-EUR", "ETH-EUR", "SOL-EUR"]


def spec(markets=MK, **params):
    return normalize_spec({"family": "rotation_buffer", "markets": list(markets), "interval": "1d",
                           "params": params}, FAM)


def frame_of(c):
    c = np.asarray(c, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def cd3(n=900):
    return {"BTC-EUR": synth(n, 1), "ETH-EUR": synth(n, 2, price=1500), "SOL-EUR": synth(n, 3, price=100)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready and FAM.multi_market
    assert FAM.validate({"params": {**FAM.default_params(), "top": 3, "keepRank": 2}}) is not None
    rng = random.Random(4)
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
    ex = FAM.explain(spec(skip=3))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_no_lookahead():
    cd = cd3()
    for p in ({"lookback": 20, "skip": 0, "top": 2, "keepRank": 3, "sizing": "drift"},
              {"lookback": 30, "skip": 5, "top": 1, "keepRank": 2, "sizing": "equal"}):
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


def test_buffer_keeps_holding_and_sells_when_falling():
    n = 120
    t = np.arange(n, dtype=np.float64)
    a = 100 * 1.02 ** t                                    # strong riser all along
    b = 100 * 1.015 ** t                                   # a slower riser
    c = np.where(t < 60, 100 * 1.01 ** t, 100 * 1.01 ** 59 * 1.03 ** (t - 59))  # overtakes b after bar ~70
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b), "SOL-EUR": frame_of(c)}
    eq = FAM.targets(cd, spec(lookback=10, skip=0, top=1, keepRank=1, sizing="equal"))
    assert np.isnan(eq.iloc[:10].to_numpy()).all()
    assert (eq["BTC-EUR"].iloc[10:60] == 1.0).all() and (eq["SOL-EUR"].iloc[10:60] == 0).all()
    # c beats a once its 10-bar return is higher: without a buffer it switches to SOL
    assert eq["SOL-EUR"].iloc[-1] == 1.0
    # with keepRank 2 the held BTC is kept while it ranks 2nd
    buf = FAM.targets(cd, spec(lookback=10, skip=0, top=1, keepRank=2, sizing="equal"))
    assert buf["BTC-EUR"].iloc[-1] == 1.0 and buf["SOL-EUR"].iloc[-1] == 0
    # a falling coin is sold even inside the buffer
    d = np.concatenate([100 * 1.02 ** np.arange(40), 100 * 1.02 ** 39 * 0.97 ** np.arange(1, 41)])
    cd2 = {"BTC-EUR": frame_of(d), "ETH-EUR": frame_of(np.full(80, 50.0))}
    w = FAM.targets(cd2, spec(["BTC-EUR", "ETH-EUR"], lookback=5, skip=0, top=1, keepRank=2, sizing="equal"))
    assert w["BTC-EUR"].iloc[20] == 1.0 and (w.iloc[-10:].to_numpy() == 0).all()


def test_drift_sizing_lets_winners_run():
    n = 60
    t = np.arange(n, dtype=np.float64)
    a = 100 * 1.03 ** t
    b = 100 * 1.01 ** t
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b)}
    w = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], lookback=5, skip=0, top=2, keepRank=2, sizing="drift"))
    assert np.allclose(w.iloc[5].to_numpy(), [0.5, 0.5])
    exp = a[-1] / a[5] / (a[-1] / a[5] + b[-1] / b[5])
    assert abs(w["BTC-EUR"].iloc[-1] - exp) < 1e-9 and abs(w.iloc[-1].sum() - 1.0) < 1e-9
    e = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], lookback=5, skip=0, top=2, keepRank=2, sizing="equal"))
    assert np.allclose(e.iloc[-1].to_numpy(), [0.5, 0.5])


def test_skip_window():
    # price rises then the last 3 bars jump: with skip 3 the jump is ignored
    c = np.concatenate([np.full(30, 100.0), [130.0, 160.0, 200.0]])
    cd = {"BTC-EUR": frame_of(c)}
    w = FAM.targets(cd, spec(["BTC-EUR"], lookback=10, skip=3, top=1, keepRank=1, sizing="equal"))
    assert w["BTC-EUR"].iloc[-1] == 0
    w0 = FAM.targets(cd, spec(["BTC-EUR"], lookback=10, skip=0, top=1, keepRank=1, sizing="equal"))
    assert w0["BTC-EUR"].iloc[-1] == 1.0
