import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

def spec(name, **params):
    fam = FAMILIES[name]
    base = fam.default_params()
    base.update(params)
    return normalize_spec({"family": name, "markets": ["BTC-EUR"], "interval": "1h", "params": base}, fam)


def closes(path):
    return bars([(x, x * 1.002, x * 0.998, x) for x in path])


def w(name, path, **params):
    fam = FAMILIES[name]
    return fam.targets({"BTC-EUR": closes(path)}, spec(name, **params))["BTC-EUR"].to_numpy()


def test_range_ends_long_at_the_highs_and_flat_at_the_lows():
    up = [100 * (1.01 ** i) for i in range(40)]
    got = w("range_band", up, n=10, hi=0.8, lo=0.4)
    assert got[-1] == 1
    down = up + [up[-1] * (0.97 ** i) for i in range(1, 30)]
    assert w("range_band", down, n=10, hi=0.8, lo=0.4)[-1] == 0


def test_week_mom_holds_a_positive_return():
    path = [100.0] * 30 + [100 * (1.01 ** i) for i in range(40)]
    got = w("week_mom", path, lag=20, thr=0.05, every=10)
    assert np.isfinite(got).any()
    assert got[-1] == 1


def test_pyramid_adds_quarters_on_new_highs():
    path = [100 + i for i in range(30)]
    got = w("pyramid_high", path, n=5, drop=0.5)
    finite = got[np.isfinite(got)]
    assert finite[-1] == 1
    assert set(np.round(finite, 2)).issubset({0, 0.25, 0.5, 0.75, 1})


def test_no_lookahead_on_a_prefix():
    path = [100 * (1.002 ** i) for i in range(80)]
    for name, params in (
        ("range_band", {"n": 8, "hi": 0.8, "lo": 0.3}),
        ("week_mom", {"lag": 12, "thr": 0.02, "every": 6}),
        ("pyramid_high", {"n": 6, "drop": 0.2}),
    ):
        full = w(name, path, **params)
        cut = w(name, path[:50], **params)
        assert np.array_equal(np.nan_to_num(full[:50]), np.nan_to_num(cut)), name
