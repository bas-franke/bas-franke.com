import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["crash_guard"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "crash_guard", "markets": list(markets), "interval": "1d", "params": params},
                          FAM)


def closes(xs, start=None):
    rows = [(x, x, x, x) for x in xs]
    return bars(rows) if start is None else bars(rows, start=start)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(2)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec(markets=("BTC-EUR", "ETH-EUR")))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_holds_through_small_dips_exits_crash_and_reenters():
    up = list(np.linspace(100, 200, 30))
    dip = [190.0, 185.0, 195.0, 205.0]                 # -7.5 %: not a crash
    crash = list(np.linspace(200, 120, 10))            # -40 %
    base = [118.0, 121.0, 119.0, 120.0]
    rebound = [130.0, 140.0]
    xs = up + dip + crash + base + rebound
    w = FAM.targets({"BTC-EUR": closes(xs)}, spec(ddLook=20, ddMin=0.25, sma=10, reEntry=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:20]).all()
    assert (w[20:34] == 1.0).all()                     # rally and small dip: invested
    i_out = 34 + int(np.argmax(np.asarray(crash) <= 205 * 0.75))
    assert w[i_out] == 0.0                              # deep crash: out
    assert w[-3] == 0.0                                 # basing, no breakout yet
    assert w[-1] == 1.0                                 # breakout above the last 3 closes, back in


def test_equal_slots_and_late_listing():
    btc = closes(list(np.linspace(100, 200, 60)))
    eth = closes(list(np.linspace(100, 200, 30)), start=int(btc.index[30]))
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(markets=("BTC-EUR", "ETH-EUR"), ddLook=10, ddMin=0.2,
                                                            sma=0, reEntry=3))
    assert w["BTC-EUR"].to_numpy()[15] == 1.0 and w["ETH-EUR"].to_numpy()[15] == 0.0
    assert w["BTC-EUR"].to_numpy()[-1] == 0.5 and w["ETH-EUR"].to_numpy()[-1] == 0.5


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 5, vol=0.05), "ETH-EUR": synth(600, 6, vol=0.06, price=1500.0)}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), ddLook=40, ddMin=0.15, sma=30, reEntry=5)
    full = FAM.targets(cd, s).to_numpy()
    assert (full[~np.isnan(full)] == 0).any()          # the volatile synth does trigger crashes
    for k in (100, 450):
        trunc = {m: cd[m].iloc[: k + 1] for m in cd}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
