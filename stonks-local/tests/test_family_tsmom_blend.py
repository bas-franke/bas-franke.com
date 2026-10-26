import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["tsmom_blend"]


def spec(**params):
    return normalize_spec({"family": "tsmom_blend", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_buys_in_uptrend_sells_in_downtrend():
    up = list(np.linspace(100, 200, 40))
    down = list(np.linspace(200, 80, 40)[1:])
    w = FAM.targets(closes(up + down), spec(lookback=2, mult=2.0, horizons=3, threshold=0.0))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:8]).all()          # longest horizon 8 candles
    assert (w[8:40] == 1.0).all()          # every horizon rising: fully invested
    assert (w[50:] == 0.0).all()           # every horizon falling: all euros


def test_partial_weight_when_horizons_disagree():
    # long rise then a short dip: 2-candle horizon down, 4 and 8 still up -> 2/3
    xs = list(np.linspace(100, 200, 20)) + [198, 196]
    w = FAM.targets(closes(xs), spec(lookback=2, mult=2.0, horizons=3, threshold=0.0))["BTC-EUR"].to_numpy()
    assert abs(w[-1] - 2 / 3) < 1e-12


def test_threshold_and_max_weight():
    xs = list(np.linspace(100, 101, 30))  # tiny gains only
    s = spec(lookback=5, mult=2.0, horizons=1, threshold=0.05)
    assert (FAM.targets(closes(xs), s)["BTC-EUR"].to_numpy()[5:] == 0).all()
    s2 = spec(lookback=5, mult=2.0, horizons=1, threshold=0.0)
    s2["risk"]["maxWeight"] = 0.5
    assert (FAM.targets(closes(xs), s2)["BTC-EUR"].to_numpy()[5:] == 0.5).all()


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 2, drift=0.001)}
    s = spec(lookback=10, mult=2.5, horizons=3, threshold=0.0)
    full = FAM.targets(cd, s).to_numpy()
    for k in (100, 400):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
