import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["rskew_gate_a14"]
H1 = 3_600_000
T0 = 1_600_000_000_000 - (1_600_000_000_000 % 86_400_000)   # midnight UTC


def spec(**params):
    p = {"source": "intraday", "lookback": 3, "rankLen": 60, "exitPct": 0.2, "gap": 0.0,
         "trendSma": 0, "combine": "or", "decideHour": 0, **params}
    return normalize_spec({"family": "rskew_gate_a14", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "exitPct": 0.6, "gap": 0.3}})
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(24 * 500, 3, start=T0, step=H1, vol=0.005)}
    for _ in range(8):
        p = FAM.sample(rng)
        p["lookback"], p["rankLen"] = min(p["lookback"], 30), min(p["rankLen"], 200)
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    assert len(FAM.explain(spec(trendSma=50))["howItWorks"]) >= 3


def _path(crash_day: int, days: int = 120, seed: int = 0):
    day = np.array([0.004, -0.003, 0.002, -0.001, 0.006, -0.002, 0.001, -0.004] * 3)
    day -= day.mean()                      # identical days: identical skew, so ranks tie at ~0.5
    r = np.tile(day, days)
    r[24 * crash_day + 5] = -0.15          # one sudden intraday dump
    c = 100 * np.exp(np.cumsum(r))
    return bars([(x, x, x, x) for x in c], start=T0, step=H1)


def test_sells_after_an_intraday_dump_and_buys_back_once_it_leaves_the_window():
    df = _path(80)
    w = FAM.targets({"BTC-EUR": df}, spec())["BTC-EUR"].to_numpy()
    ts = np.asarray(df.index)
    day = (ts - T0) // 86_400_000
    # decision at the close of the bar ending 00:00 -> bar starting 23:00 of the day before
    held_before = w[(day == 79) & (ts % 86_400_000 == 23 * H1)][0]
    out_after = w[(day == 80) & (ts % 86_400_000 == 23 * H1)][0]
    back = w[(day == 86) & (ts % 86_400_000 == 23 * H1)][0]
    assert held_before == 1 and out_after == 0 and back == 1
    # weights only change at the decision hour
    ch = np.nonzero(np.diff(np.nan_to_num(w, nan=-1)))[0] + 1
    assert all(ts[i] % 86_400_000 == 23 * H1 for i in ch)


def test_daily_source_and_core():
    c = 100 * np.exp(np.linspace(0, 1, 24 * 120))
    up = bars([(x, x, x, x) for x in c], start=T0, step=H1)
    w = FAM.targets({"BTC-EUR": up}, spec(source="daily", lookback=10))["BTC-EUR"].to_numpy()
    assert np.isfinite(w).any()
    # an 'or' core with a tiny SMA on a rising path keeps it in
    w2 = FAM.targets({"BTC-EUR": up}, spec(trendSma=10, exitPct=0.6, gap=0.2))["BTC-EUR"].to_numpy()
    assert w2[-1] == 1


def test_no_look_ahead():
    cd = synth(24 * 200, 7, start=T0, step=H1, vol=0.006)
    for src in ("intraday", "daily"):
        s = spec(source=src, lookback=5, rankLen=60, trendSma=20, combine="and")
        full = FAM.targets({"BTC-EUR": cd}, s)["BTC-EUR"].to_numpy()
        for k in (24 * 90 + 7, 24 * 150 - 1):
            part = FAM.targets({"BTC-EUR": cd.iloc[:k]}, s)["BTC-EUR"].to_numpy()
            assert np.array_equal(np.nan_to_num(part, nan=-1), np.nan_to_num(full[:k], nan=-1))
