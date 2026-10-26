import random

import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

H1 = 3_600_000
MON = 1_704_067_200_000  # 2024-01-01 00:00 UTC, a Monday


def spec(interval="1h", **params):
    fam = FAMILIES["time_window"]
    return normalize_spec({"family": "time_window", "markets": ["BTC-EUR"], "interval": interval,
                           "params": params}, fam)


def test_contract():
    fam = FAMILIES["time_window"]
    assert not fam.bot_ready and fam.validate({"params": fam.default_params()}) is not None  # = buy and hold
    rng = random.Random(1)
    for _ in range(30):
        assert fam.validate({"params": fam.sample(rng)}) is None
    ex = fam.explain(spec(dayStart=5, dayCount=2))
    assert ex["summary"] and len(ex["howItWorks"]) >= 2 and "Saturday through Sunday" in ex["summary"]


def test_hour_window_uses_next_bar_open():
    cd = {"BTC-EUR": synth(48, 1, start=MON, step=H1)}
    w = FAMILIES["time_window"].targets(cd, spec(hourStart=22, hourCount=3))["BTC-EUR"].to_numpy()
    # bars opening 21:00, 22:00, 23:00 decide for 22:00, 23:00, 00:00 -> hold
    exp = np.zeros(48)
    exp[[21, 22, 23, 45, 46, 47]] = 1
    np.testing.assert_array_equal(w, exp)


def test_weekend_window_daily_with_weight():
    cd = {"BTC-EUR": synth(14, 1, start=MON, step=24 * H1)}
    s = spec("1d", dayStart=5, dayCount=2)
    s["risk"]["maxWeight"] = 0.5
    w = FAMILIES["time_window"].targets(cd, s)["BTC-EUR"].to_numpy()
    # Friday's and Saturday's decisions hold Saturday and Sunday
    np.testing.assert_array_equal(w, [0, 0, 0, 0, .5, .5, 0] * 2)


def test_trend_filter_and_no_lookahead():
    fam = FAMILIES["time_window"]
    cd = {"BTC-EUR": synth(600, 3, start=MON, step=H1)}
    s = spec(dayStart=0, dayCount=5, hourStart=8, hourCount=10, trendSma=50)
    full = fam.targets(cd, s)["BTC-EUR"].to_numpy()
    assert np.isnan(full[:49]).all() and not np.isnan(full[49:]).any()
    c = cd["BTC-EUR"]["close"].to_numpy()
    sma = np.convolve(c, np.ones(50) / 50, "valid")
    assert (full[49:][c[49:] <= sma] == 0).all()
    for k in (200, 450):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(fam.targets(trunc, s)["BTC-EUR"].to_numpy(), full[: k + 1])
        d = cd["BTC-EUR"].copy()
        for col in ("open", "high", "low", "close"):
            x = d[col].to_numpy().copy()
            x[k + 1:] *= 3
            d[col] = x
        np.testing.assert_array_equal(fam.targets({"BTC-EUR": d}, s)["BTC-EUR"].to_numpy()[: k + 1], full[: k + 1])
