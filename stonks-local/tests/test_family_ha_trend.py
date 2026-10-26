import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["ha_trend"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "ha_trend", "markets": list(markets), "interval": "1d", "params": params}, FAM)


def rows(xs):
    prev = xs[0]
    out = []
    for x in xs:
        out.append((prev, max(prev, x) + 0.5, min(prev, x) - 0.5, x))
        prev = x
    return bars(out)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_heikin_ashi_values():
    from stonks_lab.families.ha_trend import heikin_ashi
    o = np.array([10.0, 12.0]); h = np.array([13.0, 15.0]); l = np.array([9.0, 11.0]); c = np.array([12.0, 14.0])
    ho, hh, hl, hc = heikin_ashi(o, h, l, c)
    assert ho[0] == 11.0 and hc[0] == 11.0
    assert ho[1] == 11.0 and hc[1] == 13.0 and hh[1] == 15.0 and hl[1] == 11.0


def test_buys_in_uptrend_sells_in_downtrend():
    xs = [100.0] * 15 + [100 + 3 * k for k in range(1, 15)] + [142 - 4 * k for k in range(1, 12)]
    w = FAM.targets({"BTC-EUR": rows(xs)}, spec(enterK=2, exitK=2))["BTC-EUR"].to_numpy()
    assert w[20] == 1.0            # well into the rise
    assert w[-1] == 0.0            # after the fall
    assert w[14] == 0.0            # flat: no green run yet


def test_trend_gate_blocks_entry():
    xs = list(np.linspace(200, 100, 60)) + [100 + 2 * k for k in range(1, 6)]
    on = FAM.targets({"BTC-EUR": rows(xs)}, spec(enterK=2, exitK=2, trendSma=50))["BTC-EUR"].to_numpy()
    off = FAM.targets({"BTC-EUR": rows(xs)}, spec(enterK=2, exitK=2, trendSma=0))["BTC-EUR"].to_numpy()
    assert on[-1] == 0.0 and off[-1] == 1.0


def test_two_markets_split_weight():
    xs = [100.0] * 15 + [100 + 3 * k for k in range(1, 15)]
    cd = {"BTC-EUR": rows(xs), "ETH-EUR": rows(xs)}
    w = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), enterK=2, exitK=2))
    assert w["BTC-EUR"].to_numpy()[-1] == 0.5 and w["ETH-EUR"].to_numpy()[-1] == 0.5


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(preSmooth=10, enterK=2, exitK=3, exitStrong=True, trendSma=50),
              spec(preSmooth=0, enterK=1, exitK=1, exitStrong=False, trendSma=0)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (120, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
