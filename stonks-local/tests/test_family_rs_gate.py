import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["rs_gate"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "rs_gate", "markets": list(markets), "interval": "4h", "params": params}, FAM)


def df_of(c):
    c = np.asarray(c, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def growth(rate, n=60, price=100.0):
    return price * np.cumprod(np.full(n, 1 + rate))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready
    assert "SOL-EUR" in FAM.required_markets({"params": {}})
    rng = random.Random(4)
    cd = {m: synth(900, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", "SOL-EUR",
                                                                          "ADA-EUR"])}
    for _ in range(25):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mw in (1.0, 0.5):
            s = spec(("BTC-EUR", "ETH-EUR"), **p)
            s["risk"]["maxWeight"] = mw
            v = FAM.targets(cd, s).to_numpy()
            first = int(np.argmax(~np.isnan(v).all(axis=1)))
            assert not np.isnan(v[first:]).any() and (v[first:] >= 0).all()
            assert (v[first:].sum(axis=1) <= mw + 1e-12).all()
    ex = FAM.explain(spec(("BTC-EUR", "ETH-EUR"), ownSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_holds_btc_only_while_it_leads():
    # BTC grows 1 %/bar for 60 bars then 0.1 %; SOL 0.5 % then 2 %; ADA 0.05 % throughout.
    btc = np.concatenate([growth(0.01), growth(0.001, price=growth(0.01)[-1])])
    sol = np.concatenate([growth(0.005), growth(0.02, price=growth(0.005)[-1])])
    ada = growth(0.0005, 120)
    cd = {"BTC-EUR": df_of(btc), "SOL-EUR": df_of(sol), "ADA-EUR": df_of(ada)}
    w = FAM.targets(cd, spec(lookback=5, maxRank=1, absMom=True))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:5]).all()
    assert (w[10:60] == 1.0).all()      # BTC is the strongest coin
    assert (w[70:] == 0.0).all()        # SOL leads now: BTC (still rising) is not held
    w2 = FAM.targets(cd, spec(lookback=5, maxRank=2, absMom=True))["BTC-EUR"].to_numpy()
    assert (w2[70:] == 1.0).all()       # rank 2 of 3 is enough with maxRank 2


def test_abs_momentum_and_own_sma():
    # everything falls, BTC least: it ranks first but its return is negative
    cd = {"BTC-EUR": df_of(growth(-0.001, 80)), "SOL-EUR": df_of(growth(-0.01, 80)),
          "ADA-EUR": df_of(growth(-0.02, 80))}
    w = FAM.targets(cd, spec(lookback=5, maxRank=1, absMom=True))["BTC-EUR"].to_numpy()
    assert (w[10:] == 0.0).all()
    w = FAM.targets(cd, spec(lookback=5, maxRank=1, absMom=False))["BTC-EUR"].to_numpy()
    assert (w[10:] == 1.0).all()
    w = FAM.targets(cd, spec(lookback=5, maxRank=1, absMom=False, ownSma=20))["BTC-EUR"].to_numpy()
    assert (w[25:] == 0.0).all()        # below its own falling SMA
