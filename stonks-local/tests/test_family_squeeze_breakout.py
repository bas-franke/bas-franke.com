import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["squeeze_breakout"]


def spec(**params):
    base = {"bbLen": 5, "bbK": 2.0, "sqLookback": 30, "sqPct": 0.2, "armBars": 5, "exitLen": 5, "trendSma": 0}
    base.update(params)
    return normalize_spec({"family": "squeeze_breakout", "markets": ["BTC-EUR"], "interval": "1d", "params": base},
                          FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def path():
    loud = [100.0 + (8.0 if i % 2 else -8.0) for i in range(40)]      # wide bands
    quiet = [100.0 + (0.3 if i % 2 else -0.3) for i in range(10)]     # squeeze
    brk = [106.0, 110.0, 112.0]                                       # breakout
    fall = [100.0, 95.0]
    return loud + quiet + brk + fall


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(9)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_buys_breakout_after_squeeze_and_exits():
    xs = path()
    # bbLen 5 includes the breakout bar itself, so one outlier can reach at most z = 4/sqrt(5) ~ 1.79
    w = FAM.targets(closes(xs), spec(bbK=1.5))["BTC-EUR"].to_numpy()
    b = 50
    assert (w[34:b] == 0.0).all()        # no breakout yet
    assert w[b] == 1.0                     # 106 breaks the upper band right after the quiet stretch
    assert w[b + 2] == 1.0
    assert w[b + 3] == 0.0                 # 100 under the 5-bar SMA (~105.7): sold


def test_no_buy_without_squeeze():
    loud = [100.0 + (8.0 if i % 2 else -8.0) for i in range(50)]
    xs = loud + [130.0, 135.0]           # breakout from a loud market
    w = FAM.targets(closes(xs), spec(sqPct=0.05))["BTC-EUR"].to_numpy()
    assert (np.nan_to_num(w, nan=0.0) == 0.0).all()


def test_no_lookahead():
    cd = {"BTC-EUR": synth(700, 4, drift=0.0005)}
    for s in (spec(bbLen=20, sqLookback=120, sqPct=0.2, armBars=10, exitLen=40, trendSma=100),
              spec(bbLen=10, sqLookback=60, sqPct=0.4, armBars=3, exitLen=20, trendSma=0)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (250, 500):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
