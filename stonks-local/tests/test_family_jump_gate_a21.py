import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["jump_gate_a21"]
H1 = 3_600_000
T0 = 1_600_041_600_000 - (1_600_041_600_000 % 86_400_000)   # midnight UTC


def spec(**params):
    p = {"mode": "jump", "lookback": 5, "rankLen": 60, "exitRank": 0.2, "enterRank": 0.3, "trendSma": 0,
         "combine": "and", "decideHour": 0, **params}
    return normalize_spec({"family": "jump_gate_a21", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def hourly(days_jumpy, days_smooth, days_jumpy2, seed=0):
    rng = np.random.default_rng(seed)
    r = []
    for kind, nd in (("j", days_jumpy), ("s", days_smooth), ("j", days_jumpy2)):
        x = rng.normal(0.0, 0.003, 24 * nd)
        if kind == "j":
            spikes = rng.choice(len(x), size=2 * nd, replace=False)   # ~2 isolated spikes a day
            x[spikes] += rng.choice([-1, 1], size=len(spikes)) * 0.03
        else:
            x = rng.normal(0.0, 0.006, 24 * nd)                        # smooth, continuous moves
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


def test_steps_aside_in_smooth_stretch_and_returns_with_jumps():
    cd = hourly(60, 25, 30)
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    day = lambda d: d * 24 + 23                                       # last hour of day d (decision at 00:00)
    assert np.isnan(w[:24 * 5]).all()
    assert (w[day(40):day(60)] == 1).all()                            # jumpy: held
    assert (w[day(70):day(85)] == 0).all()                            # smooth stretch: out
    assert (w[day(100):] == 1).all()                                  # jumps again: back in


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
    k = np.linspace(1.0, 0.5, len(c))                                 # steady fall: close below its SMA
    for col in ("open", "high", "low", "close"):
        c[col] = c[col] * k
    w = FAM.targets(cd, spec(trendSma=20))["BTC-EUR"].to_numpy()
    assert w[-1] == 0
