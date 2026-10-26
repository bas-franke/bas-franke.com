import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pullback_rotation"]
ROT = FAMILIES["rotation_momentum"]
MK = ["BTC-EUR", "ETH-EUR", "SOL-EUR"]


def spec(markets=MK, family="pullback_rotation", **params):
    fam = FAM if family == "pullback_rotation" else ROT
    return normalize_spec({"family": family, "markets": list(markets), "interval": "1d", "params": params}, fam)


def frame_of(c):
    c = np.asarray(c, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def cd3(n=900):
    return {"BTC-EUR": synth(n, 1), "ETH-EUR": synth(n, 2, price=1500), "SOL-EUR": synth(n, 3, price=100)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready and FAM.multi_market
    assert FAM.validate({"params": {**FAM.default_params(), "top": 3, "pool": 2}}) is not None
    rng = random.Random(3)
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
    for below in (40.0, 100.0):
        ex = FAM.explain(spec(rsiBelow=below))
        assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_no_pullback_and_no_buffer_equals_rotation_momentum():
    cd = cd3()
    for lb, top, sma in ((15, 2, 35), (25, 3, 50), (7, 1, 0)):
        a = FAM.targets(cd, spec(lookback=lb, top=top, pool=top, rsiBelow=100.0, regimeSma=sma)).to_numpy()
        b = ROT.targets(cd, spec(family="rotation_momentum", lookback=lb, top=top, regimeSma=sma)).to_numpy()
        np.testing.assert_array_equal(a, b)


def test_no_lookahead():
    cd = cd3()
    for p in ({"lookback": 20, "top": 2, "pool": 3, "rsiPeriod": 3, "rsiBelow": 45.0, "regimeSma": 30},
              {"lookback": 10, "top": 1, "pool": 2, "rsiPeriod": 2, "rsiBelow": 30.0, "regimeSma": 0}):
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


def test_waits_for_pullback_then_holds_and_sells_off_the_shortlist():
    n = 120
    t = np.arange(n, dtype=np.float64)
    # ETH rises 2 %/bar with a 2-bar pullback at bars 40-41, then falls hard from bar 80
    e = 100 * 1.02 ** t
    e[40:42] = e[39] * np.array([0.97, 0.95])
    e[42:80] = e[41] * 1.02 ** np.arange(1, 39)
    e[80:] = e[79] * 0.95 ** np.arange(1, n - 79)
    cd = {"BTC-EUR": frame_of(100 * 1.001 ** t), "ETH-EUR": frame_of(e), "SOL-EUR": frame_of(100 * 0.999 ** t)}
    w = FAM.targets(cd, spec(lookback=10, top=1, pool=1, rsiPeriod=2, rsiBelow=30.0, regimeSma=0))
    eth = w["ETH-EUR"].to_numpy()
    assert np.isnan(eth[:10]).all()
    assert (eth[10:40] == 0).all()           # leader, but no pullback yet: waits (BTC has no pullback either)
    assert w["BTC-EUR"].iloc[10:40].max() == 0
    assert eth[40] == 1.0 or eth[41] == 1.0   # buys the dip
    assert (eth[42:80] == 1.0).all()          # holds while it leads
    assert (eth[95:] == 0).all()              # off the shortlist once its 10-bar return turns negative
    # the immediate-entry version buys at once
    w0 = FAM.targets(cd, spec(lookback=10, top=1, pool=1, rsiPeriod=2, rsiBelow=100.0, regimeSma=0))
    assert (w0["ETH-EUR"].iloc[10:40] == 1.0).all()


def test_gate_off_sells_everything():
    n = 150
    t = np.arange(n, dtype=np.float64)
    btc = np.where(t < 100, 100 * 1.01 ** t, 100 * 1.01 ** 99 * 0.97 ** (t - 99))
    cd = {"BTC-EUR": frame_of(btc), "ETH-EUR": frame_of(100 * 1.02 ** t), "SOL-EUR": frame_of(100 * 1.015 ** t)}
    w = FAM.targets(cd, spec(lookback=5, top=2, pool=2, rsiBelow=100.0, regimeSma=20))
    assert (w.iloc[25:99].sum(axis=1) == 1.0).all()
    assert (w.iloc[110:].to_numpy() == 0).all()
