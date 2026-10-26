import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["ramp_core_a07"]


def spec(**params):
    p = {"smaLen": 3, "rampIn": 2, "rampOut": 4, "floor": 0.0, **params}
    return normalize_spec({"family": "ramp_core_a07", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"smaLen": 5, "rampIn": 0, "rampOut": 1, "floor": 0}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(600, 2)}
    for _ in range(10):
        v = FAM.targets(cd, spec(**FAM.sample(rng)))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert (v[ok] >= 0).all() and (v[ok] <= 1).all()
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_ramps_out_and_in():
    # rising (in at 1), then falling below the SMA: -1/4 per bar, then rising again: +1/2 per bar
    path = [10, 11, 12, 13, 9, 8, 7, 6, 5, 4, 20, 21, 22]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    assert w[2] == 1 and w[3] == 1
    np.testing.assert_allclose(w[4:9], [0.75, 0.5, 0.25, 0.0, 0.0])
    np.testing.assert_allclose(w[10:13], [0.5, 1.0, 1.0])


def test_floor_holds_part():
    path = [10, 11, 12, 13, 9, 8, 7, 6, 5, 4]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(floor=0.3))["BTC-EUR"].to_numpy()
    assert abs(w[-1] - 0.3) < 1e-12


def test_one_one_is_plain_sma():
    c = synth(300, 7)["close"].to_numpy()
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(smaLen=20, rampIn=1, rampOut=1))["BTC-EUR"].to_numpy()
    sma = np.convolve(c, np.ones(20) / 20, mode="valid")
    np.testing.assert_array_equal(w[19:], (c[19:] > sma).astype(float))
