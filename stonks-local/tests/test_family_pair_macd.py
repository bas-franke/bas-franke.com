import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pair_macd"]
MK = ["BTC-EUR", "ETH-EUR"]
FASTP = dict(fast=2, slow=5, signal=3, ratioFast=2, ratioSlow=8)


def spec(**params):
    return normalize_spec({"family": "pair_macd", "markets": MK, "interval": "1d", "params": params}, FAM)


def cd(btc, eth):
    return {"BTC-EUR": bars([(x, x, x, x) for x in btc]), "ETH-EUR": bars([(x, x, x, x) for x in eth])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(9)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "fast": 300}})
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 5


def test_tilts_to_leader_when_both_accelerate():
    t = np.arange(60)
    btc = list(100 * 1.01 ** t)     # both accelerate (exponential): MACD above signal
    eth = list(100 * 1.03 ** t)     # ETH faster: ETH leads
    w = FAM.targets(cd(btc, eth), spec(**FASTP, tilt=0.5))
    assert np.isnan(w["BTC-EUR"].iloc[:6]).all()
    assert abs(w["ETH-EUR"].iloc[-1] - 0.75) < 1e-12 and abs(w["BTC-EUR"].iloc[-1] - 0.25) < 1e-12


def test_solo_and_cash():
    t = np.arange(60)
    up = list(100 * 1.02 ** t)
    down = list(100 - 0.025 * t ** 2)   # accelerating decline: MACD below signal
    one = FAM.targets(cd(up, down), spec(**FASTP, solo=1.0))
    assert one["BTC-EUR"].iloc[-1] == 1.0 and one["ETH-EUR"].iloc[-1] == 0.0
    half = FAM.targets(cd(up, down), spec(**FASTP, solo=0.5))
    assert half["BTC-EUR"].iloc[-1] == 0.5
    none = FAM.targets(cd(down, down), spec(**FASTP))
    assert none.iloc[-1].sum() == 0.0


def test_no_lookahead():
    data = {"BTC-EUR": synth(600, 7, drift=0.001), "ETH-EUR": synth(600, 8, drift=0.0012, price=1500.0)}
    s = spec(fast=8, slow=60, signal=10, ratioFast=5, ratioSlow=30, tilt=0.7)
    full = FAM.targets(data, s).to_numpy()
    for k in (100, 400):
        trunc = {m: data[m].iloc[: k + 1] for m in MK}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
