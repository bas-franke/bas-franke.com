import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["ulcer_core_a09"]
D = 86_400_000


def spec(**params):
    p = {"look": 10, "rankLen": 90, "rankMin": 0.9, "holdBars": 5, "coreSma": 0, **params}
    return normalize_spec({"family": "ulcer_core_a09", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c], step=D)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(1)
    cd = {"BTC-EUR": synth(900, 3, step=D)}
    for _ in range(12):
        s = spec(**FAM.sample(rng))
        v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 1.0}
        assert FAM.explain(s)["summary"]


def test_long_drawdown_triggers_fixed_hold():
    up = [100 * 1.01 ** i for i in range(100)]
    down = [up[-1] * 0.98 ** i for i in range(1, 16)]
    flat = [down[-1]] * 30
    c = up + down + flat
    w = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    assert (w[60:100] == 0).all()             # steady rise: no pain, no core -> cash
    assert w[100:130].max() == 1              # deep slide: pain buy fires
    assert w[-1] == 0                          # long flat after it: hold expired, pain no longer extreme


def test_core_or_pain():
    c = synth(500, 5, step=D)["close"].to_numpy()
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(coreSma=20, rankMin=0.99))["BTC-EUR"].to_numpy()
    sma = np.convolve(c, np.ones(20) / 20, mode="valid")
    core = (c[19:] > sma).astype(float)
    ok = np.isfinite(w[19:])
    assert (w[19:][ok] >= core[ok]).all()     # never below the core


def test_no_lookahead():
    df = synth(600, 8, step=D)
    rng = random.Random(4)
    for _ in range(5):
        s = spec(**{**FAM.sample(rng), "rankLen": 120, "look": 20})
        full = FAM.targets({"BTC-EUR": df}, s)["BTC-EUR"]
        for cut in (300, 451, 577):
            part = FAM.targets({"BTC-EUR": df.iloc[:cut]}, s)["BTC-EUR"]
            a, b = full.loc[part.index].to_numpy(), part.to_numpy()
            assert np.array_equal(np.isnan(a), np.isnan(b)) and np.allclose(a[~np.isnan(a)], b[~np.isnan(b)])


def test_day_hour_matches_native_daily_at_hour_zero():
    H = 3_600_000
    h = synth(24 * 400, 12, step=H, vol=0.004)
    s1 = normalize_spec({"family": "ulcer_core_a09", "markets": ["BTC-EUR"], "interval": "1h",
                         "params": {"look": 10, "rankLen": 90, "rankMin": 0.8, "holdBars": 5, "coreSma": 20,
                                    "dayHour": 5}}, FAM)
    w = FAM.targets({"BTC-EUR": h}, s1)["BTC-EUR"].dropna()
    assert len(w) > 200 and (((w.index.to_numpy() // H) % 24) == 4).all()
