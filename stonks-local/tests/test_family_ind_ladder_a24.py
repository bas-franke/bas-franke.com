import numpy as np
import pandas as pd

from stonks_lab.families import _step, _ta, get_family, normalize_spec


def _candles(close, vol=1.0):
    c = np.asarray(close, dtype=np.float64)
    idx = pd.Index(np.arange(len(c), dtype=np.int64) * 3_600_000, name="ts")
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.full(len(c), vol)},
                        index=idx)


def test_walk_moves_one_slice_per_bar():
    goal = np.array([np.nan, 1, 1, 1, np.nan, 0, 0])
    w = _step.walk(goal, np.array([False] + [True] * 6), 0.1, 1)
    assert np.isnan(w[0])
    assert np.allclose(w[1:], [0.1, 0.2, 0.3, 0.3, 0.2, 0.1])


def test_walk_every_and_guard():
    goal = np.ones(7)
    w = _step.walk(goal, np.ones(7, bool), 0.25, 2)
    assert np.allclose(w, [0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1.0])
    g = np.array([0, 0, 0, 1, 1, 0, 0], bool)
    w = _step.walk(goal, np.ones(7, bool), 0.25, 1, g)
    assert np.allclose(w, [0.25, 0.5, 0.75, 0.5, 0.25, 0.5, 0.75])
    w = _step.walk(goal, np.ones(7, bool), 0.25, 1, g, guard_exit=True)
    assert np.allclose(w, [0.25, 0.5, 0.75, 0, 0, 0.25, 0.5])


def test_guard_mask_drawdown():
    c = np.array([100, 110, 120, 100, 90, 95.0])
    g = _step.guard_mask(c, 0, 3, 0.2)
    assert g.tolist() == [False, False, False, False, True, False]


def test_ladder_revert_buys_dips_in_slices():
    fam = get_family("ind_ladder_a24")
    close = np.r_[np.full(40, 100.0), np.linspace(100, 70, 20), np.linspace(70, 110, 40)]
    df = _candles(close)
    spec = normalize_spec({"family": fam.name, "markets": ["BTC-EUR"], "interval": "1h",
                           "params": {"indicator": "rsi", "n": 10, "mode": "revert", "thr": 0.3, "step": 0.1}}, fam)
    w = fam.targets({"BTC-EUR": df}, spec)["BTC-EUR"].to_numpy()
    d = np.diff(w[np.isfinite(w)])
    assert np.all(np.isin(np.round(d, 9), [0, 0.1, -0.1]))   # only ever one 10 % slice per bar
    assert np.nanmax(w[40:62]) >= 0.3                        # scaled in during the fall
    assert w[-1] < np.nanmax(w)                              # scaled out into the rally


def test_ladder_trend_level_is_on_the_step_grid():
    fam = get_family("ind_ladder_a24")
    rng = np.random.default_rng(3)
    df = _candles(100 * np.exp(np.cumsum(rng.normal(0, 0.01, 600))))
    for ind in _ta.ALL:
        spec = normalize_spec({"family": fam.name, "markets": ["BTC-EUR"], "interval": "1h",
                               "params": {"indicator": ind, "n": 12, "mode": "trend_level", "thr": 0.5,
                                          "step": 0.25}}, fam)
        w = fam.targets({"BTC-EUR": df}, spec)["BTC-EUR"].to_numpy()
        f = w[np.isfinite(w)]
        assert len(f), ind
        assert np.allclose(f / 0.25, np.round(f / 0.25)), ind
        assert f.min() >= 0 and f.max() <= 1, ind


def test_step_wrap_full_step_reproduces_lead():
    wrap, lead = get_family("step_wrap_a24"), get_family("ema_cross")
    rng = np.random.default_rng(5)
    df = _candles(100 * np.exp(np.cumsum(rng.normal(0, 0.02, 400))))
    cd = {"BTC-EUR": df}
    base = {"markets": ["BTC-EUR"], "interval": "1d"}
    lw = lead.targets(cd, normalize_spec({**base, "family": "ema_cross", "params": {}}, lead))["BTC-EUR"].to_numpy()
    ww = wrap.targets(cd, normalize_spec({**base, "family": wrap.name, "params": {"step": 1.0}}, wrap))
    assert np.array_equal(np.nan_to_num(lw, nan=-1), np.nan_to_num(ww["BTC-EUR"].to_numpy(), nan=-1))
    w10 = wrap.targets(cd, normalize_spec({**base, "family": wrap.name, "params": {"step": 0.1}}, wrap))["BTC-EUR"]
    assert np.nanmax(np.abs(np.diff(w10.dropna().to_numpy()))) <= 0.1 + 1e-9
