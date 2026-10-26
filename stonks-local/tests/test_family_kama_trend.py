import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["kama_trend"]


def spec(**params):
    return normalize_spec({"family": "kama_trend", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "fastLen": 10, "slowLen": 15}}) is not None
    rng = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec(band=0.01, erMin=0.2, slopeBars=3))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_buys_uptrend_sells_downtrend():
    xs = [100.0] * 30 + list(np.linspace(100, 200, 40)) + list(np.linspace(200, 100, 40)[1:])
    s = spec(erLen=5, fastLen=2, slowLen=20)
    w = FAM.targets(closes(xs), s)["BTC-EUR"].to_numpy()
    wu = FAM.warmup(s["params"])
    assert np.isnan(w[:wu]).all()
    assert w[65] == 1.0           # late in the rally: in
    assert w[-1] == 0.0           # late in the fall: out


def test_er_gate_blocks_chop():
    xs = [100.0 + (3 if i % 2 else -3) for i in range(80)] + [104.0]
    w = FAM.targets(closes(xs), spec(erLen=10, fastLen=2, slowLen=30, erMin=0.5))["BTC-EUR"].to_numpy()
    assert np.nanmax(w) == 0.0    # zig-zag: efficiency ratio ~0, never buys
    w2 = FAM.targets(closes(xs), spec(erLen=10, fastLen=2, slowLen=30))["BTC-EUR"].to_numpy()
    assert np.nanmax(w2) == 1.0   # without the gate it does buy the up-ticks


def test_band_hysteresis_and_max_weight():
    xs = [100.0] * 30 + list(np.linspace(100, 400, 25)) + [395.0] * 5
    s = spec(erLen=5, fastLen=2, slowLen=20, band=0.02)
    s["risk"]["maxWeight"] = 0.5
    w = FAM.targets(closes(xs), s)["BTC-EUR"].to_numpy()
    assert set(np.unique(w[~np.isnan(w)])) <= {0.0, 0.5}
    assert w[-1] == 0.5           # small dip stays inside the band: still holding


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.001)}
    s = spec(erLen=15, fastLen=3, slowLen=50, band=0.01, erMin=0.1, slopeBars=4)
    full = FAM.targets(cd, s).to_numpy()
    for k in (150, 450):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
