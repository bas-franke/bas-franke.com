import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["quad_bend"]
from stonks_lab.families.quad_bend import bend_series  # noqa: E402


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "quad_bend", "markets": list(markets), "interval": "1d", "params": params}, FAM)


def closes(xs, m="BTC-EUR"):
    return {m: bars([(x, x, x, x) for x in xs])}


def wiggle(n, seed=3):
    return np.random.default_rng(seed).normal(0, 0.01, n)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "bendIn": -1.0, "bendOut": 0.0}}) is not None
    rng = random.Random(7)
    assert sum(FAM.validate({"params": FAM.sample(rng)}) is None for _ in range(60)) > 10
    for mode in ("gate", "or_sma", "and_sma"):
        ex = FAM.explain(spec(mode=mode, minHold=5))
        assert ex["summary"] and len(ex["howItWorks"]) >= 2


def test_bend_sign():
    t = np.linspace(0, 1, 60)
    up = 100 * np.exp(0.8 * t * t + wiggle(60))          # accelerating
    top = 100 * np.exp(1.6 * t - 0.8 * t * t + wiggle(60))  # rounding over
    assert bend_series(up, 40)[-1] > 1.0
    assert bend_series(top, 40)[-1] < -1.0
    assert np.isnan(bend_series(up, 40)[:39]).all()


def test_gate_sells_rounding_top_and_buys_acceleration():
    t = np.linspace(0, 1, 80)
    rise = 100 * np.exp(0.8 * t * t + wiggle(80))
    over = rise[-1] * np.exp(1.6 * t - 1.6 * t * t + wiggle(80, 4))   # up then rolls over to flat/down
    xs = list(rise) + list(over[1:])
    w = FAM.targets(closes(xs), spec(fitLen=30, mode="gate", bendIn=0.0, bendOut=-1.0))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:29]).all()
    assert w[78] == 1.0
    assert w[-1] == 0.0


def test_and_sma_and_split_weights():
    t = np.linspace(0, 1, 120)
    xs = list(100 * np.exp(0.8 * t * t + wiggle(120)))
    cs = {**closes(xs, "BTC-EUR"), **closes(xs, "ETH-EUR")}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), fitLen=20, mode="and_sma", smaLen=30, bendIn=-0.5, bendOut=-2.0)
    w = FAM.targets(cs, s)
    assert w["BTC-EUR"].iloc[-1] == 0.5 and w["ETH-EUR"].iloc[-1] == 0.5
    # or_sma below the SMA with a bend on still holds; gate never looks at the SMA
    down = list(100 * np.exp(-0.5 * t + wiggle(120)))
    w2 = FAM.targets(closes(down), spec(fitLen=20, mode="or_sma", smaLen=30, bendIn=-3.0, bendOut=-3.0))
    assert w2["BTC-EUR"].iloc[-1] == 1.0


def test_min_hold_keeps_position():
    t = np.linspace(0, 1, 60)
    rise = list(100 * np.exp(0.8 * t * t + wiggle(60)))
    crash = [rise[-1] * (1 - 0.03 * k) for k in range(1, 15)]
    xs = rise + crash
    base = FAM.targets(closes(xs), spec(fitLen=20, bendIn=0.0, bendOut=-0.5))["BTC-EUR"].to_numpy()
    held = FAM.targets(closes(xs), spec(fitLen=20, bendIn=0.0, bendOut=-0.5, minHold=60))["BTC-EUR"].to_numpy()
    assert base[-1] == 0.0
    assert held[-1] == 1.0
