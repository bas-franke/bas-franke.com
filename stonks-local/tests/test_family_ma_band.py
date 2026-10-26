import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["ma_band"]


def spec(**params):
    return normalize_spec({"family": "ma_band", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_buys_above_band_sells_below_band():
    xs = [100.0] * 5 + [102.0, 108.0, 110.0, 110.0, 103.0, 99.0, 90.0, 80.0]
    w = FAM.targets(closes(xs), spec(maType="sma", length=5, enterBand=0.05, exitBand=0.05, slopeBars=0))
    w = w["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all()
    assert w[4] == 0.0 and w[5] == 0.0      # 102 vs sma ~100.4: inside the band, stays out
    assert w[6] == 1.0                       # 108 vs sma 102: above +5 %, buys
    assert w[9] == 1.0                       # 103 vs sma ~106.2: inside the band, keeps holding
    assert w[10] == 0.0                      # 99 vs sma 106: below -5 %, sells


def test_slope_gate_blocks_buy_in_falling_average():
    xs = list(np.linspace(200, 100, 30)) + [160.0]
    s_on = spec(maType="sma", length=20, enterBand=0.0, exitBand=0.0, slopeBars=5)
    s_off = spec(maType="sma", length=20, enterBand=0.0, exitBand=0.0, slopeBars=0)
    assert FAM.targets(closes(xs), s_on)["BTC-EUR"].to_numpy()[-1] == 0.0
    assert FAM.targets(closes(xs), s_off)["BTC-EUR"].to_numpy()[-1] == 1.0


def test_max_weight():
    s = spec(maType="ema", length=10, enterBand=0.0, exitBand=0.0, slopeBars=0)
    s["risk"]["maxWeight"] = 0.5
    w = FAM.targets(closes(list(np.linspace(100, 200, 40))), s)["BTC-EUR"].to_numpy()
    assert (w[10:] == 0.5).all()


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(maType="sma", length=50, enterBand=0.02, exitBand=0.04, slopeBars=10),
              spec(maType="ema", length=40, enterBand=0.0, exitBand=0.03, slopeBars=0)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (120, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
