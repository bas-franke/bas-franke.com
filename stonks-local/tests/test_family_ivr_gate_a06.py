import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families import ivr_gate_a06 as ivr

FAM = FAMILIES["ivr_gate_a06"]
H1 = 3_600_000
T0 = 1_600_041_600_000 - (1_600_041_600_000 % 86_400_000)   # midnight UTC


def spec(**params):
    p = {"horizon": 24, "lookback": 5, "rankLen": 60, "exitRank": 0.2, "enterRank": 0.3, "side": "high",
         "trendSma": 0, "combine": "and", "decideHour": 0, **params}
    return normalize_spec({"family": "ivr_gate_a06", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def hourly(days_trend, days_chop, days_trend2, seed=0):
    """Trending stretches: hourly moves persist (AR(1) +0.6); choppy: they reverse (AR(1) -0.6)."""
    rng = np.random.default_rng(seed)
    r = []
    for phi, nd in ((0.6, days_trend), (-0.6, days_chop), (0.6, days_trend2)):
        e = rng.normal(0.0, 0.004, 24 * nd)
        x = np.zeros_like(e)
        for i in range(len(e)):
            x[i] = e[i] + (phi * x[i - 1] if i else 0.0)
        r.extend(x)
    c = 100 * np.exp(np.cumsum(r))
    o = np.concatenate([[100.0], c[:-1]])
    rows = [(a, max(a, b) * 1.001, min(a, b) * 0.999, b) for a, b in zip(o, c)]
    return {"BTC-EUR": bars(rows, start=T0, step=H1)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "exitRank": 0.5, "enterRank": 0.4}})
    rng = random.Random(3)
    assert sum(FAM.validate({"params": FAM.sample(rng)}) is None for _ in range(40)) == 40
    assert len(FAM.explain(spec(trendSma=50))["howItWorks"]) >= 4


def test_variance_ratio_separates_trend_and_chop():
    cd = hourly(40, 30, 30)
    idx, vr = ivr.daily_signal(cd["BTC-EUR"], spec()["params"], "1h")
    assert np.nanmean(vr[10:40]) > 1.5
    assert np.nanmean(vr[50:70]) < 0.7


def test_steps_aside_in_chop_and_returns_with_trend():
    cd = hourly(60, 25, 30)
    w = FAM.targets(cd, spec(lookback=10))["BTC-EUR"].to_numpy()
    day = lambda d: d * 24 + 23
    assert np.isnan(w[:24 * 10]).all()
    assert (w[day(40):day(60)] == 1).mean() > 0.8                   # trending: (mostly) held
    assert (w[day(72):day(85)] == 0).all()                          # choppy: out
    assert (w[day(105):] == 1).mean() > 0.8                         # trending again: back in
    lo = FAM.targets(cd, spec(lookback=10, side="low"))["BTC-EUR"].to_numpy()
    assert lo[day(80)] == 1


def test_decides_once_a_day_at_the_chosen_hour():
    cd = hourly(60, 25, 30)
    w = FAM.targets(cd, spec(decideHour=7))["BTC-EUR"].to_numpy()
    ts = np.asarray(cd["BTC-EUR"].index)
    ch = np.nonzero(np.diff(np.nan_to_num(w, nan=-1)))[0] + 1
    assert len(ch) >= 2
    assert all(((ts[i] + H1) % 86_400_000) == 7 * H1 for i in ch)


def test_and_core_blocks_below_sma():
    cd = hourly(60, 25, 30)
    c = cd["BTC-EUR"]
    k = np.linspace(1.0, 0.5, len(c))
    for col in ("open", "high", "low", "close"):
        c[col] = c[col] * k
    w = FAM.targets(cd, spec(trendSma=20))["BTC-EUR"].to_numpy()
    assert w[-1] == 0
