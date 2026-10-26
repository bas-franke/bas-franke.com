import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pair_band"]
MK = ["BTC-EUR", "ETH-EUR"]


def spec(**params):
    return normalize_spec({"family": "pair_band", "markets": MK, "interval": "1d", "params": params}, FAM)


def cd(btc, eth):
    return {"BTC-EUR": bars([(x, x, x, x) for x in btc]), "ETH-EUR": bars([(x, x, x, x) for x in eth])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "ratioFast": 60, "ratioSlow": 50}})
    ex = FAM.explain(spec(slopeBars=5))
    assert ex["summary"] and len(ex["howItWorks"]) >= 5


def test_tilts_to_leader_when_both_trend():
    n = 60
    btc = list(np.linspace(100, 150, n))      # +50 %
    eth = list(np.linspace(100, 250, n))      # +150 %: ETH leads
    w = FAM.targets(cd(btc, eth), spec(ma=5, band=0.01, ratioFast=2, ratioSlow=8, tilt=0.5))
    assert np.isnan(w["BTC-EUR"].iloc[:7]).all()
    assert abs(w["ETH-EUR"].iloc[-1] - 0.75) < 1e-12 and abs(w["BTC-EUR"].iloc[-1] - 0.25) < 1e-12


def test_solo_and_cash():
    n = 60
    up = list(np.linspace(100, 200, n))
    down = list(np.linspace(200, 100, n))
    one = FAM.targets(cd(up, down), spec(ma=5, band=0.01, ratioFast=2, ratioSlow=8, solo=1.0))
    assert one["BTC-EUR"].iloc[-1] == 1.0 and one["ETH-EUR"].iloc[-1] == 0.0
    half = FAM.targets(cd(up, down), spec(ma=5, band=0.01, ratioFast=2, ratioSlow=8, solo=0.5))
    assert half["BTC-EUR"].iloc[-1] == 0.5
    none = FAM.targets(cd(down, down), spec(ma=5, band=0.01, ratioFast=2, ratioSlow=8))
    assert none.iloc[-1].sum() == 0.0


def test_band_hysteresis():
    # rise then +-1 % wobble: a 2 % band keeps BTC on, no band flips it off at times
    btc = list(np.linspace(100, 200, 15)) + [200, 202, 198] * 6
    eth = list(np.linspace(100, 200, 15)) + [200, 202, 198] * 6
    held = FAM.targets(cd(btc, eth), spec(ma=3, band=0.02, ratioFast=1, ratioSlow=3, tilt=0.0))
    assert (held["BTC-EUR"].iloc[15:] == 0.5).all()
    flip = FAM.targets(cd(btc, eth), spec(ma=3, band=0.0, ratioFast=1, ratioSlow=3, tilt=0.0))
    assert (flip["BTC-EUR"].iloc[15:] != 0.5).any()


def test_no_lookahead():
    data = {"BTC-EUR": synth(600, 5, drift=0.001), "ETH-EUR": synth(600, 6, drift=0.0012, price=1500.0)}
    s = spec(ma=40, maType="ema", band=0.03, slopeBars=5, ratioFast=5, ratioSlow=30, tilt=0.7)
    full = FAM.targets(data, s).to_numpy()
    for k in (100, 400):
        trunc = {m: data[m].iloc[: k + 1] for m in MK}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
