import math
import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.perm_entropy import perm_entropy

FAM = FAMILIES["perm_entropy"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "perm_entropy", "markets": list(markets), "interval": "1d", "params": params},
                          FAM)


def closes(xs, m="BTC-EUR"):
    return {m: bars([(x, x, x, x) for x in xs])}


def noise(n, seed=1, drift=0.0):
    return list(100 * np.exp(np.cumsum(np.random.default_rng(seed).normal(drift, 0.02, n))))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "peIn": 0.99, "peOut": 0.95}}) is not None
    assert FAM.validate({"params": {**FAM.default_params(), "order": 4, "peLen": 40}}) is not None
    rng = random.Random(3)
    assert sum(FAM.validate({"params": FAM.sample(rng)}) is None for _ in range(80)) > 10
    for mode in ("and_sma", "or_sma", "exit"):
        ex = FAM.explain(spec(mode=mode, minHold=4))
        assert ex["summary"] and len(ex["howItWorks"]) >= 2


def test_entropy_values():
    up = np.arange(1, 101, dtype=float)                    # one pattern only
    pe = perm_entropy(up, 3, 30)
    assert np.isnan(pe[:31]).all() and not np.isnan(pe[31])
    assert pe[-1] == 0.0
    rnd = np.array(noise(3000, 2))
    pe2 = perm_entropy(rnd, 3, 2000)
    assert 0.95 < pe2[-1] < 0.99            # a random walk of prices: ~0.967 (monotone runs are likelier)
    # brute force on one window
    x = rnd[:60]
    pats = [tuple(np.argsort(np.argsort(x[i:i + 3], kind="stable"), kind="stable")) for i in range(58)]
    last = pats[-30:]
    probs = [last.count(q) / 30 for q in set(last)]
    h = -sum(q * math.log(q) for q in probs) / math.log(6)
    assert abs(perm_entropy(x, 3, 30)[59] - h) < 1e-9


def test_and_sma_needs_orderly_trend():
    steady = [100 * 1.01 ** i for i in range(120)]           # orderly rise
    w = FAM.targets(closes(steady), spec(peLen=30, smaLen=20, peIn=0.9, peOut=0.95))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:31]).all()
    assert w[-1] == 1.0
    rough = noise(400, 5, drift=0.004)                       # rising but random order
    w2 = FAM.targets(closes(rough), spec(peLen=200, smaLen=20, peIn=0.5, peOut=0.6))["BTC-EUR"].to_numpy()
    assert np.nanmax(w2) == 0.0
    w3 = FAM.targets(closes(rough), spec(peLen=200, smaLen=20, peIn=1.0, peOut=1.0))["BTC-EUR"].to_numpy()
    assert np.nanmax(w3) == 1.0


def test_exit_mode_keeps_position_and_split():
    steady = [100 * 1.01 ** i for i in range(80)]
    rough = [steady[-1] * x / 100 for x in noise(80, 9, drift=-0.004)]
    xs = steady + rough
    s = spec(markets=("BTC-EUR", "ETH-EUR"), peLen=30, smaLen=20, peIn=0.5, peOut=0.6, mode="exit")
    w = FAM.targets({**closes(xs), **closes(xs, "ETH-EUR")}, s)
    a = w["BTC-EUR"].to_numpy()
    assert a[79] == 0.5
    sma = np.convolve(xs, np.ones(20) / 20, mode="full")[:len(xs)]
    t = 79 + next(i for i in range(1, 80) if xs[79 + i] <= sma[79 + i])
    assert (a[79:t] == 0.5).all()
