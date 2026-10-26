import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["eqcurve_a12"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "eqcurve_a12", "markets": list(markets), "interval": "1d", "params": params},
                          FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_select_holds_in_chop_and_follows_core_into_a_crash():
    # sawtooth chop around a flat level: the SMA core whipsaws and trails holding -> fallback hold
    chop = [100.0 + (6.0 if (i // 3) % 2 == 0 else -6.0) for i in range(60)]
    crash = list(np.linspace(100.0, 40.0, 40))
    w = FAM.targets(closes(chop + crash), spec(coreLen=5, eqLen=10, mode="select", margin=0.0, fallback="hold"))
    w = w["BTC-EUR"].to_numpy()
    assert np.isnan(w[:10]).all()
    assert (w[30:60] == 1.0).all()           # core not trusted in the chop: hold
    assert w[-1] == 0.0                       # in the crash the core (out) beats hold: follow it into cash


def test_select_cash_fallback_and_filter_mode():
    up = list(np.linspace(100.0, 300.0, 80))
    s_cash = spec(coreLen=5, eqLen=10, mode="select", margin=0.05, fallback="cash")
    w = FAM.targets(closes(up), s_cash)["BTC-EUR"].to_numpy()
    assert w[-1] == 0.0                       # steady rise: core never beats holding by 5 %: never trusted -> cash
    s_filt = spec(coreLen=5, eqLen=10, mode="filter", margin=0.0, fallback="cash")
    w = FAM.targets(closes(up), s_filt)["BTC-EUR"].to_numpy()
    assert w[-1] == 1.0                       # core equity rising above its average: trusted, core is long


def test_multi_market_split_and_max_weight():
    cd = {"BTC-EUR": synth(300, 2, drift=0.002), "ETH-EUR": synth(300, 3, drift=0.002)}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), coreLen=20, eqLen=30, mode="filter", margin=0.0, fallback="hold")
    s["risk"]["maxWeight"] = 0.8
    w = FAM.targets(cd, s).to_numpy()
    good = w[~np.isnan(w).any(axis=1)]
    assert len(good) > 100 and set(np.unique(good)) <= {0.0, 0.4}


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(coreLen=50, eqLen=40, mode="select", margin=0.02, fallback="hold"),
              spec(coreLen=30, eqLen=60, mode="filter", margin=0.0, fallback="cash")):
        full = FAM.targets(cd, s).to_numpy()
        for k in (150, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
