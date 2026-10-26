import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["orb_day"]
H = 3_600_000
T0 = 1_600_041_600_000  # 2020-09-14 00:00 UTC


def spec(**params):
    p = {"startHour": 0, "rangeHours": 2, "buffer": 0.0, "sessionHours": 24, "stopAtLow": True, "trendDays": 0,
         **params}
    return normalize_spec({"family": "orb_day", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def day(rows):
    return bars(rows, start=T0, step=H)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "rangeHours": 8, "sessionHours": 8}})
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(24 * 60, 2, start=T0, step=H, vol=0.004)}
    for _ in range(10):
        p = FAM.sample(rng)
        p["trendDays"] = min(p["trendDays"], 20)
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_buys_breakout_and_is_flat_at_session_end():
    rows = [(100, 101, 99, 100), (100, 102, 98, 101)]          # range: high 102, low 98
    rows += [(101, 102, 100, 101.5), (101.5, 103, 101, 102.5)]  # bar 3 closes above 102: buy
    rows += [(102.5, 104, 102, 103)] * 19                       # rest of the day (bar 23 = last)
    rows += [(103, 103, 103, 103)] * 3                          # next day starts
    w = FAM.targets({"BTC-EUR": day(rows)}, spec())["BTC-EUR"].to_numpy()
    assert list(w[:4]) == [0, 0, 0, 1]
    assert (w[4:23] == 1).all() and w[23] == 0
    assert (w[24:] == 0).all()


def test_stop_at_range_low_and_one_trade_per_day():
    rows = [(100, 101, 99, 100), (100, 102, 98, 101), (101, 103, 101, 102.5), (102.5, 103, 97, 97.5),
            (97.5, 104, 97, 103)] + [(103, 103, 103, 103)] * 19
    w = FAM.targets({"BTC-EUR": day(rows)}, spec())["BTC-EUR"].to_numpy()
    assert list(w[:5]) == [0, 0, 1, 0, 0]      # stopped at the low; the second breakout is ignored
    w2 = FAM.targets({"BTC-EUR": day(rows)}, spec(stopAtLow=False))["BTC-EUR"].to_numpy()
    assert list(w2[:5]) == [0, 0, 1, 1, 1]


def test_start_hour_shifts_the_session():
    rows = [(100, 100, 100, 100)] * 6 + [(100, 101, 99, 100), (100, 101, 99, 100), (100, 103, 100, 102)]
    rows += [(102, 102, 102, 102)] * 21
    w = FAM.targets({"BTC-EUR": day(rows)}, spec(startHour=6))["BTC-EUR"].to_numpy()
    assert w[8] == 1 and (w[9:29] == 1).all() and w[29] == 0   # session 06:00..05:59, last candle 05:00 next day


def test_no_lookahead():
    df = synth(24 * 80, 5, start=T0, step=H, vol=0.006)
    s = spec(rangeHours=3, trendDays=10, buffer=0.002)
    full = FAM.targets({"BTC-EUR": df}, s)["BTC-EUR"].to_numpy()
    for k in (24 * 30 + 1, 24 * 50 + 14, 24 * 70 + 23):
        t = FAM.targets({"BTC-EUR": df.iloc[: k + 1]}, s)["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(t, full[: k + 1])
