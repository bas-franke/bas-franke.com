import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["weekend_hour_a21"]
WS = FAMILIES["weekend_shock"]
H1 = 3_600_000
DAY = 86_400_000
MON = 1_600_041_600_000 - (1_600_041_600_000 % DAY)
MON -= ((MON // DAY + 3) % 7) * DAY          # a Monday 00:00 UTC


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "weekend_hour_a21", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def hourly(closes):
    c = np.asarray(closes, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return {"BTC-EUR": bars([(a, max(a, b), min(a, b), b) for a, b in zip(o, c)], start=MON, step=H1)}


def path_with_weekend_drop(drop_hour_from_monday):
    """Flat 100 for 3 weeks; a 10 % step down at the given hour (relative to the 2nd Monday 00:00)."""
    n = 21 * 24
    c = np.full(n, 100.0)
    k = 7 * 24 + drop_hour_from_monday
    c[k:] = 90.0
    return c


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(1)
    assert sum(FAM.validate({"params": FAM.sample(rng)}) is None for _ in range(30)) == 30
    assert len(FAM.explain(spec(regain=True))["howItWorks"]) >= 4


def test_sells_after_weekend_drop_and_returns_after_out_days():
    c = path_with_weekend_drop(-10)            # drop on Sunday 14:00 -> inside Sat 00:00..Mon 00:00
    w = FAM.targets(hourly(c), spec(outDays=3))["BTC-EUR"].to_numpy()
    dec = 7 * 24 - 1                           # bar closing at the 2nd Monday 00:00
    assert np.isnan(w[:47]).all()
    assert w[dec - 24] == 1
    assert (w[dec:dec + 3 * 24] == 0).all()
    assert (w[dec + 3 * 24:] == 1).all()


def test_shift_moves_the_window():
    c = path_with_weekend_drop(+3)             # drop Monday 03:00: outside the native window, inside shift +6
    assert np.nanmin(FAM.targets(hourly(c), spec())["BTC-EUR"].to_numpy()) == 1
    w = FAM.targets(hourly(c), spec(shift=6))["BTC-EUR"].to_numpy()
    assert w[7 * 24 + 5] == 0 and w[7 * 24 + 4] == 1


def test_rolling_control_fires_on_weekdays():
    c = path_with_weekend_drop(24 * 2 + 5)     # Wednesday drop: weekend mode ignores, rolling sells
    assert np.nanmin(FAM.targets(hourly(c), spec())["BTC-EUR"].to_numpy()) == 1
    assert np.nanmin(FAM.targets(hourly(c), spec(mode="rolling"))["BTC-EUR"].to_numpy()) == 0


def test_shift0_matches_native_daily_rule():
    rng = np.random.default_rng(5)
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.012, 24 * 7 * 30)))
    cd = hourly(c)
    p = {"mode": "weekend", "dropMin": 0.04, "outDays": 5, "regain": True}
    w = FAM.targets(cd, spec(**p))["BTC-EUR"]
    d = cd["BTC-EUR"].iloc[23::24]             # last hour of each day = native daily close
    d = bars([(x, x, x, x) for x in d["close"]], start=MON, step=DAY)
    ws = WS.targets({"BTC-EUR": d}, normalize_spec({"family": "weekend_shock", "markets": ["BTC-EUR"],
                                                    "interval": "1d", "params": p}, WS))["BTC-EUR"].to_numpy()
    mine = w.to_numpy()[23::24]
    ok = np.isfinite(mine) & np.isfinite(ws)
    assert ok.sum() > 150 and (ws[ok] == 0).sum() > 0
    assert np.array_equal(mine[ok], ws[ok])
