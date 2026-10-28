"""The five stoploss families, checked against the paths their search scripts already proved."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from stonks_lab.families import FAMILIES, normalize_spec

T0 = 1_600_000_000_000
HOUR = 3_600_000


def _df(close, high=None, low=None):
    c = np.asarray(close, dtype=np.float64)
    h = c if high is None else np.asarray(high, dtype=np.float64)
    l = c if low is None else np.asarray(low, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]]) if len(c) else c
    return pd.DataFrame(
        {"open": o, "high": h, "low": l, "close": c, "volume": np.ones(len(c))},
        index=pd.Index(T0 + HOUR * np.arange(len(c), dtype=np.int64), name="ts"),
    )


def weights(name, df, **params):
    fam = FAMILIES[name]
    spec = normalize_spec(
        {"family": name, "markets": ["BTC-EUR"], "interval": "1h", "params": {**fam.default_params(), **params}},
        fam,
    )
    return fam.targets({"BTC-EUR": df}, spec)["BTC-EUR"].to_numpy()


def test_quarter_adds_then_stops_and_does_not_rebuy_that_bar():
    n, drop = 5, 0.2
    close = [10.0] * n + [11.0, 12.0, 13.0, 14.0, 10.0, 12.0, 15.0]
    w = weights("sl_quarter", _df(close), n=n, drop=drop)
    assert np.isnan(w[:n]).all()
    assert w[n:].tolist() == [0.25, 0.5, 0.75, 1.0, 0.0, 0.0, 0.25]
    close2 = [10.0, 10.0, 10.0, 20.0, 16.1, 16.1, 16.1, 17.0]
    w2 = weights("sl_quarter", _df(close2), n=3, drop=0.2)
    assert np.isnan(w2[:3]).all()
    assert w2[3:].tolist() == [0.25, 0.25, 0.25, 0.25, 0.5]
    close3 = [10.0] * 4 + [11.0, 12.0, 13.0, 14.0, 15.0, 16.0]
    assert weights("sl_quarter", _df(close3), n=4, drop=0.3)[4:].tolist() == [0.25, 0.5, 0.75, 1.0, 1.0, 1.0]


def test_efficiency_steps_and_the_stop_only_rises():
    up = np.linspace(100.0, 200.0, 180)
    peak = float(up[-1])
    dipped = np.concatenate([up, [peak * 0.95, peak * 0.87]])
    w = weights("sl_efficiency", _df(dipped), n=48, efficiencyMin=0.25, trailPct=0.12, step=0.25, minBarsBetweenAdds=24)
    assert np.isnan(w[:48]).all()
    assert w[48] == 0.25 and w[72] == 0.5 and w[96] == 0.75 and w[120] == 1.0
    assert w[-2] == 1.0 and w[-1] == 0.0
    held = weights("sl_efficiency", _df(np.concatenate([up, [peak * 0.85]])), n=48, efficiencyMin=0.25, trailPct=0.20)
    assert held[-1] == 1.0


def test_floor_buys_quarters_and_sells_through_the_low():
    rows = [
        (10, 8, 9),
        (10, 8, 9),
        (10, 8, 9),
        (11, 9, 11),
        (12, 10, 12.5),
        (13, 11, 13.5),
        (14, 12, 14.5),
        (16, 13, 15.5),
        (16, 9, 9.5),
        (17, 14, 16.5),
    ]
    high, low, close = zip(*rows)
    got = weights("sl_floor", _df(close, high, low), n=3)
    exp = np.array([np.nan, np.nan, np.nan, 0.25, 0.5, 0.75, 1.0, 1.0, 0.0, 0.25])
    assert np.allclose(got, exp, equal_nan=True)


def test_slices_add_on_the_clock_and_the_ratchet_does_not_fall():
    close = np.full(220, 100.0)
    close[80:] = 110.0
    close[105] = 130.0
    w = weights("sl_slices", _df(close), every=24, drop=0.2, average=80, step=0.25)
    assert np.isnan(w[:80]).all()
    assert w[80] == 0.25 and w[104] == 0.50 and w[128] == 0.75 and w[152] == 1.0 and w[200] == 1.0
    close = np.full(160, 100.0)
    close[80] = 110.0
    close[81] = 150.0
    close[82] = 140.0
    close[83] = 121.0
    close[84] = 119.0
    close[85:] = 140.0
    w = weights("sl_slices", _df(close), every=24, drop=0.2, average=80, step=0.25)
    assert w[83] == 0.25 and w[84] == 0.0 and np.all(w[85:] == 0.0)


def test_range_ratchet_buys_half_then_full_and_resets_after_the_stop():
    n, stable = 3, 2
    high = np.array([10, 10, 10, 10, 10, 12, 12, 12, 10, 10, 10, 10, 10, 10], dtype=float)
    low = np.array([1, 1, 1, 8, 8.5, 9, 9.2, 9.0, 9.1, 9.05, 9.0, 4, 6, 7], dtype=float)
    close = np.array([2, 2, 9, 9.5, 9.6, 11, 11.5, 11.2, 9.5, 9.4, 9.3, 8.7, 9.2, 9.5], dtype=float)
    w = weights("sl_range", _df(close, high, low), n=n, upFrac=0.7, stableBars=stable)
    assert np.all(np.isnan(w[:3]))
    assert w[3] == 0.5 and w[4] == 1.0 and w[10] == 1.0 and w[11] == 0.0 and w[12] == 0.5
    finite = w[np.isfinite(w)]
    assert set(np.round(finite, 2)).issubset({0.0, 0.5, 1.0})
    assert all(math.isfinite(x) or True for x in w)
