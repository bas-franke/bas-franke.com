import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["grid_ladder"]


def spec(**params):
    p = dict(FAM.default_params())
    p.update(params)
    return normalize_spec({"family": "grid_ladder", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    for a in ("sma", "ema", "high"):
        ex = FAM.explain(spec(anchor=a))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_buys_down_sells_up_with_hysteresis():
    # rolling-high anchor over 3 bars, ladder 0..-40 % in 4 rungs (~10 % each), floor 0
    s = spec(anchor="high", anchorLen=3, span=0.4, levels=4, wMin=0.0)
    xs = [100.0, 100.0, 100.0, 90.0, 80.0, 70.0, 75.0, 80.0, 70.0]
    w = FAM.targets(closes(xs), s)["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    assert w[2] == 0.0                        # at the high: top rung, no coins
    assert w[3] == 0.25                       # -10.5 % below high 100 -> one rung down
    # bar 4: high 100, x=ln(.8)=-.223 -> r=2.23 -> level 2
    assert w[4] == 0.5
    # bar 5: high 90 (bars 3..5), x=ln(70/90)=-.251 -> r=2.51 -> stays 2 (needs r>=3)
    assert w[5] == 0.5
    # bar 7: high 80, close 80 -> r=0 -> level drops to 0 (r <= 1)
    assert w[7] == 0.0


def test_floor_and_max_weight():
    s = spec(anchor="sma", anchorLen=5, span=0.2, levels=2, wMin=0.4)
    s["risk"]["maxWeight"] = 0.5
    w = FAM.targets(closes(list(np.linspace(100, 300, 40))), s)["BTC-EUR"].to_numpy()
    # strong uptrend sits far above the average: top of the ladder, floor weight only
    assert np.allclose(w[10:], 0.5 * 0.4)
    w2 = FAM.targets(closes(list(300 * 0.85 ** np.arange(40))), s)["BTC-EUR"].to_numpy()
    assert np.allclose(w2[10:], 0.5)


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 7, drift=0.0003)}
    for s in (spec(anchor="ema", anchorLen=40, span=0.3, levels=6, wMin=0.1),
              spec(anchor="high", anchorLen=60, span=0.5, levels=5, wMin=0.3)):
        full = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
        for k in (100, 450):
            trunc = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}, s)["BTC-EUR"].to_numpy()
            assert np.allclose(full[: k + 1], trunc, equal_nan=True)
