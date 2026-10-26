import random

import numpy as np
import pandas as pd

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["weekend_shock"]
DAY = 86_400_000
FRI = int(pd.Timestamp("2024-01-05", tz="UTC").value // 1_000_000)  # a Friday


def spec(**params):
    p = dict(FAM.default_params())
    p.update(params)
    return normalize_spec({"family": "weekend_shock", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def daily(xs, start=FRI - 4 * DAY):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs], start=start, step=DAY)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(2)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    for m in ("weekend", "rolling"):
        ex = FAM.explain(spec(mode=m))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_weekend_drop_sells_and_waits():
    # bars: Mon Tue Wed Thu Fri Sat Sun Mon Tue Wed ... (start = Monday 2024-01-01)
    xs = [100, 100, 100, 100, 100, 95, 90, 91, 92, 93, 94, 95]
    w = FAM.targets(daily(xs), spec(mode="weekend", dropMin=0.06, outDays=3, regain=False))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    assert (w[2:6] == 1.0).all()
    assert w[6] == 0.0                # Sunday close 90 vs Friday 100: -10.5 % -> out
    assert (w[7:9] == 0.0).all() and w[9] == 1.0   # 3 candles out (Sun, Mon, Tue), back on Wed


def test_weekend_mode_ignores_weekday_drops_rolling_does_not():
    xs = [100, 100, 90, 85, 85, 85, 85, 85]       # Wed/Thu drop
    s_w = spec(mode="weekend", dropMin=0.06, outDays=3, regain=False)
    s_r = spec(mode="rolling", dropMin=0.06, outDays=3, regain=False)
    assert (FAM.targets(daily(xs), s_w)["BTC-EUR"].to_numpy()[2:] == 1.0).all()
    wr = FAM.targets(daily(xs), s_r)["BTC-EUR"].to_numpy()
    assert wr[2] == 0.0 and wr[3] == 0.0


def test_regain_buys_back_early():
    xs = [100, 100, 100, 100, 100, 95, 90, 101, 101, 101]
    w = FAM.targets(daily(xs), spec(mode="weekend", dropMin=0.06, outDays=20, regain=True))["BTC-EUR"].to_numpy()
    assert w[6] == 0.0 and w[7] == 1.0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(700, 9, step=DAY, vol=0.05)}
    for s in (spec(mode="weekend", dropMin=0.05, outDays=7, regain=True),
              spec(mode="rolling", dropMin=0.08, outDays=10, regain=False)):
        full = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
        assert np.nanmin(full) == 0.0
        for k in (50, 500):
            trunc = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}, s)["BTC-EUR"].to_numpy()
            assert np.allclose(full[: k + 1], trunc, equal_nan=True)
