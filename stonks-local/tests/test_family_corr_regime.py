import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["corr_regime"]


def spec(markets=("ETH-EUR",), **params):
    return normalize_spec({"family": "corr_regime", "markets": list(markets), "interval": "1d", "params": params}, FAM)


def rows(xs):
    return bars([(x, x * 1.01, x * 0.99, x) for x in xs])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(7)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3
    assert FAM.module.required_markets(spec(markets=("BTC-EUR",))) == ["BTC-EUR", "ETH-EUR"]


def _pair(n, eth_drop_alone):
    rng = np.random.default_rng(1)
    b = 100 * np.exp(np.cumsum(rng.normal(0.002, 0.02, n)))
    noise = rng.normal(0, 0.02, n)
    if eth_drop_alone:   # ETH falls on its own (independent noise, negative drift), BTC keeps rising
        e = 50 * np.exp(np.cumsum(noise - 0.01))
    else:                # ETH = BTC moves: perfectly correlated, both fall at the end
        b = np.concatenate([b[: n - 15], b[n - 15] * 0.97 ** np.arange(1, 16)])
        e = b / 2
    return {"BTC-EUR": rows(b), "ETH-EUR": rows(e)}


def test_exits_on_correlated_drop_only():
    s = spec(corrLen=20, corrMin=0.8, retLen=10, scope="own")
    w_corr = FAM.targets(_pair(80, False), s)["ETH-EUR"].to_numpy()
    w_alone = FAM.targets(_pair(80, True), s)["ETH-EUR"].to_numpy()
    assert w_corr[-1] == 0.0          # lock-step sell-off: out
    assert w_alone[-1] == 1.0         # ETH-only drop with low correlation: held
    w_mom = FAM.targets(_pair(80, True), spec(corrLen=20, corrMin=-1.0, retLen=10))["ETH-EUR"].to_numpy()
    assert w_mom[-1] == 0.0           # plain momentum ablation exits


def test_min_out():
    xs = [100.0 * 1.01 ** i for i in range(40)] + [90.0] + [100.0 * 1.01 ** (40 + i) for i in range(1, 6)]
    cd = {"BTC-EUR": rows(xs), "ETH-EUR": rows([x / 2 for x in xs])}
    w = FAM.targets(cd, spec(markets=("BTC-EUR",), corrLen=10, corrMin=-1.0, retLen=1, minOut=3))["BTC-EUR"].to_numpy()
    assert w[40] == 0.0 and (w[41:44] == 0.0).all() and w[44] == 1.0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005), "ETH-EUR": synth(600, 9, drift=0.0003)}
    for s in (spec(markets=("BTC-EUR", "ETH-EUR"), corrLen=30, corrMin=0.6, retLen=40, scope="both", minOut=5),
              spec(markets=("ETH-EUR",), corrLen=60, corrMin=0.3, retLen=20, scope="own")):
        full = FAM.targets(cd, s).to_numpy()
        for k in (150, 400):
            trunc = {m: d.iloc[: k + 1] for m, d in cd.items()}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
