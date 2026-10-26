import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["trend_dip_vote"]


def spec(markets=("BTC-EUR",), mw=1.0, **params):
    s = normalize_spec({"family": "trend_dip_vote", "markets": list(markets), "interval": "4h", "params": params},
                       FAM)
    s["risk"]["maxWeight"] = mw
    return s


def closes(c):
    return bars([(x, x, x, x) for x in c])


# rise, sharp drop, bounce: trend voter in on the rise, dip voter in after the drop
C = [10, 10, 11, 12, 13, 14, 15, 9, 8, 9, 12, 15, 16]


def votes_for(c, **kw):
    p = {**FAM.default_params(), "fast": 1, "slow": 3, "period": 2, "buyBelow": 30, "sellAbove": 70, **kw}
    t, d, first = FAM.module.votes(np.asarray(c, float), p)
    return t, d, first


def test_modes_combine_voters():
    t, d, first = votes_for(C)
    assert first == 2
    assert t[3] == 1 and d[3] == 0          # uptrend, no dip
    assert d[7] == 1 and d[8] == 1           # sharp drop bought
    for mode, fn in (("or", np.maximum), ("and", np.minimum), ("avg", lambda a, b: (a + b) / 2)):
        w = FAM.targets({"BTC-EUR": closes(C)}, spec(fast=1, slow=3, period=2, buyBelow=30, sellAbove=70,
                                                     mode=mode))["BTC-EUR"].to_numpy()
        assert np.isnan(w[:2]).all()
        np.testing.assert_allclose(w[2:], fn(t, d)[2:])
    # or buys the dip while the trend voter is out; and does not
    w_or = FAM.targets({"BTC-EUR": closes(C)}, spec(fast=1, slow=3, period=2, buyBelow=30, sellAbove=70,
                                                    mode="or"))["BTC-EUR"].to_numpy()
    w_and = FAM.targets({"BTC-EUR": closes(C)}, spec(fast=1, slow=3, period=2, buyBelow=30, sellAbove=70,
                                                     mode="and"))["BTC-EUR"].to_numpy()
    assert t[8] == 0 and w_or[8] == 1 and w_and[8] == 0


def test_multi_market_split_and_contract():
    cd = {"BTC-EUR": synth(600, 1), "ETH-EUR": synth(600, 2, price=1500)}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), mw=0.8)
    v = FAM.targets(cd, s).to_numpy()
    first = int(np.argmax(~np.isnan(v).all(axis=1)))
    assert not np.isnan(v[first:]).any()
    assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.8 + 1e-12).all()
    assert set(np.unique(v[first:])) <= {0.0, 0.2, 0.4}
    rng = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(s)
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_no_lookahead():
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2, price=1500)}
    for mode in ("or", "avg", "and"):
        s = spec(markets=("BTC-EUR", "ETH-EUR"), mode=mode, fast=10, slow=60, period=6)
        full = FAM.targets(cd, s).to_numpy()
        rng = np.random.default_rng(5)
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
