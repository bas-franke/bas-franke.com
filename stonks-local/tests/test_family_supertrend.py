import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["supertrend"]


def spec(**params):
    return normalize_spec({"family": "supertrend", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def rows(xs, rng=1.0):
    return {"BTC-EUR": bars([(x, x + rng, x - rng, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(5)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_stop_ratchets_and_exits():
    xs = [100.0] * 5 + [105.0, 110.0, 120.0, 118.0, 115.0, 100.0]
    w = FAM.targets(rows(xs), spec(atrLen=3, entryMult=2.0, exitMult=2.0, basis="close", trendSma=0))
    w = w["BTC-EUR"].to_numpy()
    assert (w[2:5] == 0.0).all()          # flat at 100: entry line 100 + 2 ATR not crossed
    assert w[5] == 1.0                    # 105 > entry line 104: buys
    assert w[8] == 1.0 and w[9] == 1.0    # stop ratcheted up to ~107.4, closes 118/115 stay above
    assert w[10] == 0.0                   # 100 < stop: sells


def test_trend_gate_blocks_entry():
    xs = list(np.linspace(200, 100, 40)) + [100.0] * 3 + [108.0]
    on = FAM.targets(rows(xs), spec(atrLen=3, entryMult=1.0, exitMult=2.0, basis="close", trendSma=30))
    off = FAM.targets(rows(xs), spec(atrLen=3, entryMult=1.0, exitMult=2.0, basis="close", trendSma=0))
    assert on["BTC-EUR"].to_numpy()[-1] == 0.0
    assert off["BTC-EUR"].to_numpy()[-1] == 1.0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(atrLen=20, entryMult=2.0, exitMult=3.0, basis="hl2", trendSma=50),
              spec(atrLen=10, entryMult=1.0, exitMult=4.0, basis="close", trendSma=0)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (120, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
