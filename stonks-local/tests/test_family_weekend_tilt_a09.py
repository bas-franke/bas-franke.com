import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["weekend_tilt_a09"]
D = 86_400_000
MON = 4 * D  # 1970-01-05 was a Monday


def spec(**params):
    p = {"look": 14, "exitBelow": -0.004, "enterAbove": 0.0, "coreSma": 0, "combine": "or", **params}
    return normalize_spec({"family": "weekend_tilt_a09", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def path(day_ret):
    """closes from a function (day index from a Monday) -> daily log return."""
    c, x = [], 100.0
    for i in range(120):
        x *= np.exp(day_ret(i))
        c.append(x)
    return bars([(v, v, v, v) for v in c], start=MON, step=D)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "exitBelow": 0.0, "enterAbove": -0.005}})
    rng = random.Random(2)
    cd = {"BTC-EUR": synth(500, 3, step=D)}
    for _ in range(12):
        s = spec(**FAM.sample(rng))
        v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 1.0}
        assert FAM.explain(s)["summary"]


def test_weekday_only_rally_steps_aside():
    # first 60 days flat-ish, then weekdays +1 %, weekends -1 %
    w = FAM.targets({"BTC-EUR": path(lambda i: 0.001 if i < 60 else (0.01 if i % 7 < 5 else -0.01))},
                    spec())["BTC-EUR"].to_numpy()
    assert (w[20:58] == 1).all()
    assert (w[80:] == 0).all()


def test_weekend_strength_holds():
    w = FAM.targets({"BTC-EUR": path(lambda i: 0.0 if i % 7 < 5 else 0.01)}, spec())["BTC-EUR"].to_numpy()
    assert (w[20:] == 1).all()


def test_or_core_holds_in_uptrend():
    p = path(lambda i: 0.01 if i % 7 < 5 else -0.005)   # weekday-led uptrend: tilt out, core in
    w_or = FAM.targets({"BTC-EUR": p}, spec(coreSma=10, combine="or"))["BTC-EUR"].to_numpy()
    w_and = FAM.targets({"BTC-EUR": p}, spec(coreSma=10, combine="and"))["BTC-EUR"].to_numpy()
    assert (w_or[30:] == 1).all() and (w_and[30:] == 0).all()


def test_no_lookahead():
    df = synth(400, 8, step=D)
    rng = random.Random(4)
    for _ in range(5):
        s = spec(**FAM.sample(rng))
        full = FAM.targets({"BTC-EUR": df}, s)["BTC-EUR"]
        for cut in (220, 301, 377):
            part = FAM.targets({"BTC-EUR": df.iloc[:cut]}, s)["BTC-EUR"]
            a, b = full.loc[part.index].to_numpy(), part.to_numpy()
            assert np.array_equal(np.isnan(a), np.isnan(b)) and np.allclose(a[~np.isnan(a)], b[~np.isnan(b)])
