import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["volsplit_a11"]
H1 = 3_600_000
T0 = 1_600_041_600_000 - (1_600_041_600_000 % 86_400_000)   # midnight UTC


def spec(**params):
    return normalize_spec({"family": "volsplit_a11", "markets": ["BTC-EUR"], "interval": "1h", "params": params}, FAM)


def hourly(day_moves):
    """day_moves: (busy_return, quiet_return) per day; hours 12-15 busy (volume 3), 0-11 quiet (0.5), rest 1."""
    rows, vols, px = [], [], 100.0
    for b, q in day_moves:
        for h in range(24):
            if 12 <= h < 16:
                r, v = b / 4, 3.0
            elif h < 12:
                r, v = q / 12, 0.5
            else:
                r, v = 0.0, 1.0
            nx = px * np.exp(r)
            rows.append((px, max(px, nx) * 1.001, min(px, nx) * 0.999, nx))
            vols.append(v / nx)            # EUR volume = volume x close
            px = nx
    df = bars(rows, start=T0, step=H1)
    df["volume"] = vols
    return {"BTC-EUR": df}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(3)
    assert sum(FAM.validate({"params": FAM.sample(r)}) is None for _ in range(40)) == 40
    ex = FAM.explain(spec(trendSma=50, combine="or"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3
    assert FAM.explain(spec(mode="plain"))["summary"]


def test_busy_hours_rise_quiet_fall():
    # busy hours push up, quiet hours drift down more: the plain trend is down, the busy-hour trend is up
    c = hourly([(0.02, -0.03)] * 30)
    w = FAM.targets(c, spec(lookback=5, volLook=5))["BTC-EUR"].to_numpy()
    assert w[-1] == 1.0
    wp = FAM.targets(c, spec(mode="plain", lookback=5, volLook=5))["BTC-EUR"].to_numpy()
    assert wp[-1] == 0.0


def test_quiet_drift_up_is_ignored_and_sells():
    # quiet hours drift up, busy hours sell off: plain trend up, split signal down
    c = hourly([(-0.02, 0.03)] * 30)
    w = FAM.targets(c, spec(lookback=5, volLook=5, loWeight=0.0))["BTC-EUR"].to_numpy()
    assert w[-1] == 0.0
    wp = FAM.targets(c, spec(mode="plain", lookback=5, volLook=5))["BTC-EUR"].to_numpy()
    assert wp[-1] == 1.0
    # buys in a busy rally, sells once the busy hours turn down
    c = hourly([(0.03, 0.0)] * 20 + [(-0.05, 0.0)] * 8)
    w = FAM.targets(c, spec(lookback=5, volLook=5))["BTC-EUR"].to_numpy()
    assert w[24 * 20 - 1] == 1.0 and w[-1] == 0.0


def test_decides_once_per_day():
    c = hourly([(0.02, 0.0)] * 15 + [(-0.06, 0.0)] * 5)
    w = FAM.targets(c, spec(lookback=3, volLook=5, decideHour=0))["BTC-EUR"].to_numpy()
    fin = w[np.isfinite(w)]
    changes = np.nonzero(np.diff(fin))[0]
    ts = np.asarray(c["BTC-EUR"].index)[np.isfinite(w)]
    for k in changes:                      # every change happens on a bar closing at 00:00 UTC
        assert (ts[k + 1] + H1) % 86_400_000 == 0
