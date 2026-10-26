import random

import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.month_turn import in_window

FAM = FAMILIES["month_turn"]
DAY = 86_400_000
T_JAN25 = int(pd.Timestamp("2024-01-25", tz="UTC").value // 1_000_000)


def spec(**params):
    p = {"mode": "in", "offset": -2, "length": 4, "trendSma": 0, **params}
    return normalize_spec({"family": "month_turn", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"mode": "in", "offset": 20, "length": 15, "trendSma": 0}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(800, 2, step=DAY)}
    for _ in range(10):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}):
            continue
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    ex = FAM.explain(spec(trendSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_window_days():
    days = [pd.Timestamp(d, tz="UTC").value // 1_000_000 for d in
            ("2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02", "2024-02-03", "2024-02-28")]
    assert list(in_window(np.array(days), -2, 4)) == [False, True, True, True, True, False, True]


def test_targets_hold_in_window_for_next_bar():
    cd = {"BTC-EUR": synth(20, 1, start=T_JAN25, step=DAY)}   # 2024-01-25 .. 2024-02-13
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    # the window is Jan 30 .. Feb 2; the decision on bar t is for bar t+1 (Jan 29 close -> hold Jan 30)
    assert list(w[3:9]) == [0, 1, 1, 1, 1, 0]
    wo = FAM.targets(cd, spec(mode="out"))["BTC-EUR"].to_numpy()
    assert list(wo[3:9]) == [1, 0, 0, 0, 0, 1]
