import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["high_rotation"]
MK = ["BTC-EUR", "ETH-EUR", "SOL-EUR"]


def spec(markets=MK, **params):
    return normalize_spec({"family": "high_rotation", "markets": list(markets), "interval": "4h",
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
    ex = FAM.explain(spec(regimeSma=50, minProx=0.8))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_no_lookahead():
    cd = cd3()
    for p in ({"window": 20, "top": 1, "minProx": 0.9, "regimeSma": 0},
              {"window": 50, "top": 2, "minProx": 0, "regimeSma": 40}):
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


def test_holds_coin_at_its_high_not_the_bigger_gainer_below_it():
    n = 60
    t = np.arange(n, dtype=np.float64)
    a = 100 * 1.005 ** t                                   # slow, always at a new high
    b = np.where(t < 30, 100 * 1.05 ** t, 100 * 1.05 ** 29 * 0.98 ** (t - 29))  # big rally, now 20-40 % off
    c = 100 * 0.99 ** t                                    # falling
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b), "SOL-EUR": frame_of(c)}
    w = FAM.targets(cd, spec(window=40, top=1, minProx=0, regimeSma=0))
    assert np.isnan(w.iloc[:39].to_numpy()).all()
    assert w["BTC-EUR"].iloc[50] == 1.0 and w["ETH-EUR"].iloc[50] == 0.0
    # With a floor, coins far below their high are not held: SOL never, ETH not once it is >15 % off.
    w2 = FAM.targets(cd, spec(window=40, top=3, minProx=0.85, regimeSma=0))
    assert (w2["SOL-EUR"].iloc[39:] == 0).all()
    assert np.isclose(w2["BTC-EUR"].iloc[55], 1 / 3) and w2["ETH-EUR"].iloc[55] == 0.0


def test_regime_gate_goes_to_cash():
    n = 120
    t = np.arange(n, dtype=np.float64)
    btc = np.where(t < 80, 100 * 1.01 ** t, 100 * 1.01 ** 79 * 0.97 ** (t - 79))
    eth = 100 * 1.02 ** t
    cd = {"BTC-EUR": frame_of(btc), "ETH-EUR": frame_of(eth)}
    w = FAM.targets(cd, spec(markets=["BTC-EUR", "ETH-EUR"], window=10, top=1, minProx=0, regimeSma=20))
    assert w["ETH-EUR"].iloc[60] == 1.0
    assert w.iloc[110].sum() == 0.0


def test_pit_universe_ranks_only_members(monkeypatch):
    import stonks_lab.universe as uni
    n = 60
    t = np.arange(n, dtype=np.float64)
    a = 100 * 1.005 ** t          # at its high every bar, but not a member before bar 50
    b = 100 * 1.003 ** t          # also at its high, always a member
    c = 100 * 0.99 ** t
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b), "SOL-EUR": frame_of(c)}

    def fake_members(index, markets, daily=None, **kw):
        m = np.ones((len(index), len(markets)), dtype=bool)
        m[:50, markets.index("BTC-EUR")] = False
        return m

    monkeypatch.setattr(uni, "pit_members", fake_members)
    s = spec(window=20, top=1, minProx=0, regimeSma=0)
    plain = FAM.targets(cd, s)
    assert plain["BTC-EUR"].iloc[40] == 1.0
    s["universe"] = "top10_pit"
    w = FAM.targets(cd, s)
    assert w["BTC-EUR"].iloc[40] == 0.0 and w["ETH-EUR"].iloc[40] == 1.0
    assert w["BTC-EUR"].iloc[55] == 1.0
