import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["beta_shift"]
MK = ["BTC-EUR", "ETH-EUR"]


def spec(**params):
    return normalize_spec({"family": "beta_shift", "markets": MK, "interval": "1d", "params": params}, FAM)


def cf(closes):
    return bars([(x, x, x, x) for x in closes])


def test_contract_and_sampling():
    assert FAM.multi_market and not FAM.bot_ready
    rng = random.Random(5)
    cd = {"BTC-EUR": synth(700, 1), "ETH-EUR": synth(700, 2, price=1500)}
    for _ in range(12):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(**{**p, "coreSma": min(p["coreSma"], 300)})
        s["risk"]["maxWeight"] = 0.8
        v = FAM.targets(cd, s).to_numpy()
        first = int(np.argmax(~np.isnan(v).all(axis=1)))
        assert not np.isnan(v[first:]).any()
        assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.8 + 1e-12).all()
    for heat in ("eth_sma", "mom", "ratio"):
        ex = FAM.explain(spec(heat=heat, heatThr=0.1, offWeight=0.3))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_core_hot_and_off_states():
    # BTC: rises (risk-on), then crashes below its SMA. ETH: flat, then pops above its SMA, then flat.
    btc = cf([100, 100, 100, 110, 120, 130, 140, 150, 60, 50])
    eth = cf([10, 10, 10, 10, 10, 14, 15, 15, 15, 15])
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth},
                    spec(coreSma=3, heat="eth_sma", heatLen=3, heatThr=0.0, ethShare=1.0, offWeight=0.0)).to_numpy()
    assert np.isnan(w[:2]).all()
    # i2: btc 100 == sma -> off; i3/i4 on, eth == sma -> BTC; i5-i7 eth > sma -> ETH; i8/i9 btc < sma -> cash
    assert list(w[2:, 0]) == [0, 1, 1, 0, 0, 0, 0, 0]
    assert list(w[2:, 1]) == [0, 0, 0, 1, 1, 1, 0, 0]
    assert w[7, 1] == 1


def test_mom_heat_split_and_off_weight():
    btc = cf([100, 100, 100, 101, 130, 131, 131, 50])
    eth = cf([10] * 8)
    s = spec(coreSma=2, heat="mom", heatLen=2, heatThr=0.1, ethShare=0.6, offWeight=0.25)
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, s).to_numpy()
    assert np.isnan(w[:2]).all()
    # i2: btc 100 = sma 100 -> off: .25 BTC. i3: on, ln(101/100) < .1 -> BTC 1. i4: on, ln(130/100) > .1 -> hot.
    # i5: ln(131/101) > .1 hot. i6: ln(131/130) cold, on (131 > 131? no: sma(131,131)=131 -> off). i7 off.
    np.testing.assert_allclose(w[2:], [[.25, 0], [1, 0], [.4, .6], [.4, .6], [.25, 0], [.25, 0]])


def test_no_core_ratio_heat():
    btc = cf([100] * 6)
    eth = cf([10, 10, 10, 12, 12, 9])
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth},
                    spec(coreSma=0, heat="ratio", heatLen=3, heatThr=0.0, ethShare=1.0)).to_numpy()
    assert np.isnan(w[:2]).all()
    assert list(w[2:, 1]) == [0, 1, 1, 0]
    assert list(w[2:, 0]) == [1, 0, 0, 1]


def test_no_lookahead():
    cd = {"BTC-EUR": synth(400, 7), "ETH-EUR": synth(400, 8, price=1500)}
    for heat in ("eth_sma", "mom", "ratio"):
        s = spec(coreSma=40, heat=heat, heatLen=20, heatThr=0.02, ethShare=0.8, offWeight=0.2)
        full = FAM.targets(cd, s).to_numpy()
        for cut in (120, 250, 399):
            part = FAM.targets({m: df.iloc[:cut] for m, df in cd.items()}, s).to_numpy()
            np.testing.assert_array_equal(part, full[:cut])
