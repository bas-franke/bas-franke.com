import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["armed_exit"]


def spec(**params):
    return normalize_spec({"family": "armed_exit", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(7)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec(band=0.02, buyOnDisarm=True))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_holds_through_dip_without_froth():
    # slow +20 % rise, then a dip under the SMA: never armed, so it keeps holding
    xs = list(np.linspace(100, 120, 80)) + list(np.linspace(120, 90, 20))
    w = FAM.targets(closes(xs), spec(armLook=30, armRet=0.5, armKeep=50, smaLen=20))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:30]).all()
    assert np.nanmin(w) == 1.0


def test_sells_after_froth_and_rebuys():
    # +150 % run in 40 bars arms the exit; the following crash under the SMA sells; recovery above SMA buys back
    xs = [100.0] * 40 + list(np.linspace(100, 250, 40)) + list(np.linspace(250, 150, 20)) + list(np.linspace(150, 300, 40))
    s = spec(armLook=30, armRet=0.8, armKeep=200, smaLen=15)
    w = FAM.targets(closes(xs), s)["BTC-EUR"].to_numpy()
    assert w[79] == 1.0
    assert w[99] == 0.0
    assert w[-1] == 1.0


def test_buy_on_disarm_and_max_weight():
    xs = [100.0] * 40 + list(np.linspace(100, 250, 40)) + list(np.linspace(250, 120, 60))
    s = spec(armLook=30, armRet=0.8, armKeep=20, smaLen=15, buyOnDisarm=True)
    s["risk"]["maxWeight"] = 0.6
    w = FAM.targets(closes(xs), s)["BTC-EUR"].to_numpy()
    assert set(np.unique(w[~np.isnan(w)])) <= {0.0, 0.6}
    assert 0.0 in w[85:105]          # sold in the crash while armed
    assert w[-1] == 0.6              # arm expired: back in although still under the SMA
    s2 = spec(armLook=30, armRet=0.8, armKeep=20, smaLen=15, buyOnDisarm=False)
    assert FAM.targets(closes(xs), s2)["BTC-EUR"].to_numpy()[-1] == 0.0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(700, 4, drift=0.002)}
    s = spec(armLook=60, armRet=0.3, armKeep=100, smaLen=40, band=0.01, buyOnDisarm=True)
    full = FAM.targets(cd, s).to_numpy()
    for k in (200, 500):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
