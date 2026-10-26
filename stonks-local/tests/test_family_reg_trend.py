import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["reg_trend"]


def spec(**params):
    return normalize_spec({"family": "reg_trend", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enterSlope": 0.1, "exitSlope": 0.5}}) is not None
    rng = random.Random(5)
    ok = 0
    for _ in range(60):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is None:
            ok += 1
    assert ok > 10
    ex = FAM.explain(spec(r2Min=0.4, stopBand=0.1))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_buys_steady_uptrend_sells_downtrend():
    up = list(100 * np.exp(np.linspace(0, 0.5, 60)))          # +50 % in 60 days: steep, clean
    down = list(up[-1] * np.exp(np.linspace(0, -0.5, 60)[1:]))
    xs = [100.0] * 30 + up + down
    s = spec(regLen=20, enterSlope=0.5, exitSlope=0.0, r2Min=0.5)
    w = FAM.targets(closes(xs), s)["BTC-EUR"].to_numpy()
    assert np.isnan(w[:20]).all()
    assert w[85] == 1.0
    assert w[-1] == 0.0


def test_r2_gate_blocks_noisy_rise():
    rng = np.random.default_rng(1)
    base = np.linspace(0, 0.3, 100)
    xs = list(100 * np.exp(base + rng.normal(0, 0.15, 100)))   # rising but very noisy
    w = FAM.targets(closes(xs), spec(regLen=30, enterSlope=0.1, exitSlope=-0.5, r2Min=0.9))["BTC-EUR"].to_numpy()
    assert np.nanmax(w) == 0.0
    clean = list(100 * np.exp(np.linspace(0, 0.6, 100)))
    w2 = FAM.targets(closes(clean), spec(regLen=30, enterSlope=0.1, exitSlope=-0.5, r2Min=0.9))["BTC-EUR"].to_numpy()
    assert np.nanmax(w2) == 1.0


def test_stop_band_and_max_weight():
    up = list(100 * np.exp(np.linspace(0, 1.0, 80)))
    xs = up + [up[-1] * 0.8] * 2                                 # sudden 20 % drop under the line
    s = spec(regLen=30, enterSlope=0.5, exitSlope=-1.0, r2Min=0, stopBand=0.1)
    s["risk"]["maxWeight"] = 0.5
    w = FAM.targets(closes(xs), s)["BTC-EUR"].to_numpy()
    assert set(np.unique(w[~np.isnan(w)])) <= {0.0, 0.5}
    assert w[79] == 0.5
    assert w[80] == 0.0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.001)}
    s = spec(regLen=40, enterSlope=0.2, exitSlope=-0.1, r2Min=0.3, stopBand=0.08)
    full = FAM.targets(cd, s).to_numpy()
    for k in (150, 450):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
