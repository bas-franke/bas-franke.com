import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab import indicators as ind
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["macd_smooth"]


def spec(**params):
    return normalize_spec({"family": "macd_smooth", "markets": ["ETH-EUR"], "interval": "1d", "params": params}, FAM)


def closes(xs):
    return {"ETH-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "fast": 100, "slow": 110, "spread": 1.5, "voters": 9}}) is not None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_spread_one_equals_plain_macd():
    cd = {"ETH-EUR": synth(500, 4, drift=0.0005)}
    w = FAM.targets(cd, spec(fast=5, slow=30, signal=9, spread=1.0, voters=3, mode="avg"))["ETH-EUR"].to_numpy()
    line, sig, _ = ind.macd(cd["ETH-EUR"]["close"].to_numpy(), 5, 30, 9)
    ok = np.isfinite(line) & np.isfinite(sig)
    np.testing.assert_array_equal(w[ok], np.where(line > sig, 1.0, 0.0)[ok])
    assert np.isnan(w[~ok]).all()


def test_buys_in_uptrend_sells_in_downtrend():
    up = list(np.linspace(100, 300, 120) * (1 + 0.002 * np.arange(120) / 120))
    down = list(np.linspace(300, 100, 120)[1:])
    for voters in (3, 9):
        for mode in ("avg", "majority"):
            s = spec(fast=3, slow=12, signal=4, spread=1.5, voters=voters, mode=mode)
            w = FAM.targets(closes(up + down), s)["ETH-EUR"].to_numpy()
            assert FAM.warmup(s["params"]) < 40
            assert w[100] == 1.0               # accelerating rise: every voter on
            assert w[-1] == 0.0                # steady fall: every voter off


def test_avg_gives_partial_weights_majority_binary():
    cd = {"ETH-EUR": synth(800, 7, drift=0.0, vol=0.03)}
    wa = FAM.targets(cd, spec(fast=4, slow=40, signal=10, spread=1.8, voters=3, mode="avg"))["ETH-EUR"].to_numpy()
    vals = set(np.round(wa[np.isfinite(wa)], 6))
    assert vals <= {0.0, round(1 / 3, 6), round(2 / 3, 6), 1.0} and len(vals) > 2
    wm = FAM.targets(cd, spec(fast=4, slow=40, signal=10, spread=1.8, voters=9, mode="majority"))["ETH-EUR"]
    assert set(np.unique(wm.dropna().to_numpy())) <= {0.0, 1.0}
    s = spec(fast=4, slow=40, signal=10, spread=1.8, voters=9, mode="avg")
    s["risk"]["maxWeight"] = 0.5
    w9 = FAM.targets(cd, s)["ETH-EUR"].to_numpy()
    assert set(np.round(w9[np.isfinite(w9)] * 6, 6)) <= {0.0, 1.0, 2.0, 3.0}


def test_no_lookahead():
    cd = {"ETH-EUR": synth(700, 2, drift=0.001)}
    s = spec(fast=6, slow=60, signal=15, spread=1.4, voters=9, mode="avg")
    full = FAM.targets(cd, s).to_numpy()
    for k in (150, 500):
        trunc = {"ETH-EUR": cd["ETH-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
