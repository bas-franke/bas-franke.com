import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["volume_clock"]


def spec(**params):
    return normalize_spec({"family": "volume_clock", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def rows(xs, vols=None):
    df = bars([(x, x * 1.01, x * 0.99, x) for x in xs])
    if vols is not None:
        df["volume"] = np.asarray(vols, dtype=np.float64)
    return {"BTC-EUR": df}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(3)
    assert all(FAM.validate({"params": FAM.sample(r)}) is None for _ in range(40))
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_time_clock_is_plain_sma():
    xs = list(np.linspace(100, 200, 40)) + list(np.linspace(200, 120, 30))
    w = FAM.targets(rows(xs), spec(clock="time", lenDays=10))["BTC-EUR"].to_numpy()
    c = np.asarray(xs)
    assert np.isnan(w[8])
    for i in range(9, len(xs)):
        assert w[i] == (1.0 if c[i] > c[i - 9:i + 1].mean() else 0.0)


def test_constant_turnover_equals_time_clock():
    cd = synth(300, 4, step=86_400_000)
    cd["volume"] = 1000.0 / cd["close"]                 # EUR turnover is 1000 every day
    s_v = spec(clock="volume", lenDays=20, normDays=60, minFrac=0.25, maxMult=3.0)
    s_t = spec(clock="time", lenDays=20)
    wv = FAM.targets({"BTC-EUR": cd}, s_v)["BTC-EUR"].to_numpy()
    wt = FAM.targets({"BTC-EUR": cd}, s_t)["BTC-EUR"].to_numpy()
    assert np.isnan(wv[20])                              # median turnover needs half of normDays
    np.testing.assert_array_equal(wv[40:], wt[40:])


def test_busy_market_shortens_window():
    # long rise, then a heavy-volume drop: the volume clock sells, the 30-day SMA still holds
    xs = list(np.linspace(100, 300, 80)) + [290.0, 285.0, 282.0]
    vols = [1.0 / x for x in xs[:80]] + [40.0 / x for x in xs[80:]]
    s_v = spec(clock="volume", lenDays=30, normDays=60, minFrac=0.05, maxMult=3.0)
    wv = FAM.targets(rows(xs, vols), s_v)["BTC-EUR"].to_numpy()
    wt = FAM.targets(rows(xs, vols), spec(clock="time", lenDays=30))["BTC-EUR"].to_numpy()
    assert wv[79] == 1.0 and wt[79] == 1.0
    assert wt[-1] == 1.0
    assert wv[-1] == 0.0


def test_bands_hysteresis():
    xs = [100.0] * 12 + [103.0, 101.5, 99.0, 97.0]
    w = FAM.targets(rows(xs), spec(clock="time", lenDays=10, enterBand=0.02, exitBand=0.02))["BTC-EUR"].to_numpy()
    assert w[11] == 0.0
    assert w[12] == 1.0          # 103 > avg 100.3 * 1.02
    assert w[14] == 1.0          # 99 >= avg ~100.35 * 0.98
    assert w[15] == 0.0          # 97 < avg ~100.05 * 0.98


def test_no_lookahead():
    cd = synth(500, 7, step=86_400_000, drift=0.0008)
    cd["volume"] = np.random.default_rng(1).lognormal(0, 0.8, len(cd))
    for s in (spec(clock="volume", lenDays=30, normDays=90, weight="volume", minFrac=0.2, maxMult=4.0,
                   enterBand=0.01, exitBand=0.02),
              spec(clock="volume", lenDays=60, normDays=120, weight="equal")):
        full = FAM.targets({"BTC-EUR": cd}, s).to_numpy()
        for k in (120, 250, 400):
            trunc = {"BTC-EUR": cd.iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
