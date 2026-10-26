import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec, wick_hours_a22

FAM = FAMILIES["wick_hours_a22"]
H1 = 3_600_000
D1 = 86_400_000
T0 = 1_600_041_600_000 - (1_600_041_600_000 % D1)   # midnight UTC


def spec(**params):
    base = {"look": 5, "exitAbove": 0.0, "reenter": -0.1}
    base.update(params)
    return normalize_spec({"family": "wick_hours_a22", "markets": ["BTC-EUR"], "interval": "1h", "params": base}, FAM)


def hourly(days):
    """Flat price; each day one hourly bar spikes: 'up' = a +5 % high sold back (upper wick in every daily cut),
    'dn' = a -5 % low bought back (lower wick in every cut)."""
    rows = []
    for kind in days:
        for h in range(24):
            hi, lo = 100.1, 99.9
            if h == 7:
                hi, lo = (105.0, 99.9) if kind == "up" else (100.1, 95.0)
            rows.append((100.0, hi, lo, 100.0))
    return {"BTC-EUR": bars(rows, start=T0, step=H1)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(5)
    assert sum(FAM.validate({"params": FAM.sample(r)}) is None for _ in range(40)) == 40
    assert FAM.explain(spec(mode="bag"))["summary"]
    assert len(FAM.explain(spec())["howItWorks"]) >= 3


def test_daily_cut_matches_midnight_candles():
    c = hourly(["up"] * 3)
    d, last = wick_hours_a22.daily_cut(c["BTC-EUR"], 0)
    assert len(d) == 3
    assert (last - np.asarray(d.index)).tolist() == [23 * H1] * 3


def test_sells_on_upper_wicks_and_rebuys_on_lower_wicks():
    c = hourly(["dn"] * 8 + ["up"] * 8 + ["dn"] * 8)
    w = FAM.targets(c, spec())["BTC-EUR"].to_numpy()
    ts = np.asarray(c["BTC-EUR"].index)
    fin = np.isfinite(w)
    # decisions only on bars closing at 00:00 UTC
    assert np.all(((ts[fin] + H1) % D1) == 0)
    at = lambda day: w[24 * day - 1]       # decision at the close of day `day`
    assert at(8) == 1.0
    assert at(16) == 0.0
    assert at(24) == 1.0
    wb = FAM.targets(c, spec(mode="bag"))["BTC-EUR"].to_numpy()
    assert wb[24 * 16 - 1] == 0.0 and wb[24 * 24 - 1] == 1.0


def test_hour_shifts_decision_time():
    c = hourly(["dn"] * 8 + ["up"] * 8)
    w = FAM.targets(c, spec(hour=12))["BTC-EUR"].to_numpy()
    ts = np.asarray(c["BTC-EUR"].index)
    fin = np.isfinite(w)
    assert fin.any() and np.all(((ts[fin] + H1) % D1) == 12 * H1)
