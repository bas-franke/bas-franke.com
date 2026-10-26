import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["core_trend"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "core_trend", "markets": list(markets), "interval": "1d", "params": params}, FAM)


def closes(xs, m="BTC-EUR"):
    return {m: bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    for sg in ("sma", "ema", "macd"):
        ex = FAM.explain(spec(signal=sg, coreSma=200))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_core_always_held_satellite_follows_sma():
    xs = [100.0] * 5 + [110.0, 120.0, 130.0, 90.0, 80.0, 70.0]
    w = FAM.targets(closes(xs), spec(core=0.4, signal="sma", length=5, band=0.0, coreSma=0))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all()
    assert abs(w[4] - 0.4) < 1e-12           # flat: on the average -> core only
    assert abs(w[6] - 1.0) < 1e-12           # above the SMA: core + satellite
    assert abs(w[9] - 0.4) < 1e-12           # below the SMA: satellite sold, core kept
    assert abs(w[10] - 0.4) < 1e-12


def test_band_hysteresis():
    xs = [100.0] * 5 + [103.0, 110.0, 104.0, 97.0, 90.0]
    w = FAM.targets(closes(xs), spec(core=0.5, signal="sma", length=5, band=0.05))["BTC-EUR"].to_numpy()
    assert abs(w[5] - 0.5) < 1e-12           # 103 vs sma 100.6: inside the band, satellite stays out
    assert abs(w[6] - 1.0) < 1e-12           # 110 vs ~102.6: above +5 %
    assert abs(w[7] - 1.0) < 1e-12           # 104 vs ~103.4: inside the band, keeps holding
    assert abs(w[9] - 0.5) < 1e-12           # 90 vs ~100.8: below -5 %


def test_core_sma_switches_core_off_in_deep_bear():
    xs = list(np.linspace(200, 100, 60))
    w = FAM.targets(closes(xs), spec(core=0.5, signal="sma", length=10, coreSma=50))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:48]).all()
    assert (w[50:] == 0.0).all()
    w2 = FAM.targets(closes(xs), spec(core=0.5, signal="sma", length=10, coreSma=0))["BTC-EUR"].to_numpy()
    assert abs(w2[-1] - 0.5) < 1e-12


def test_macd_rising_market_is_fully_in():
    xs = list(np.linspace(100, 300, 200))
    w = FAM.targets(closes(xs), spec(core=0.3, signal="macd", length=30))["BTC-EUR"].to_numpy()
    assert abs(w[-1] - 1.0) < 1e-12


def test_two_markets_equal_slots_and_max_weight():
    cd = {"BTC-EUR": synth(300, 1, drift=0.003, vol=0.001), "ETH-EUR": synth(300, 2, drift=-0.003, vol=0.001)}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), core=0.5, signal="ema", length=20)
    s["risk"]["maxWeight"] = 0.8
    w = FAM.targets(cd, s)
    assert abs(w["BTC-EUR"].iloc[-1] - 0.4) < 1e-12      # rising: full slot 0.8 / 2
    assert abs(w["ETH-EUR"].iloc[-1] - 0.2) < 1e-12      # falling: core half of the slot


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(core=0.3, signal="sma", length=50, band=0.02, coreSma=120),
              spec(core=0.6, signal="macd", length=60, band=0.002),
              spec(core=0.5, signal="ema", length=40)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (150, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
