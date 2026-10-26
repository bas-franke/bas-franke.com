import math

import numpy as np
import pytest

import _engine_util  # noqa: F401  (sys.path)
from stonks_lab import indicators as ind

nan = np.nan


def eq(a, b, tol=1e-12):
    a, b = np.asarray(a, float), np.asarray(b, float)
    assert a.shape == b.shape
    assert np.all((np.isnan(a) & np.isnan(b)) | (np.abs(a - b) <= tol)), (a, b)


def test_sma():
    eq(ind.sma([1, 2, 3, 4, 5], 3), [nan, nan, 2, 3, 4])
    eq(ind.sma([1, 2], 3), [nan, nan])
    eq(ind.sma([1, nan, 3, 4, 5], 2), [nan, nan, nan, 3.5, 4.5])


def test_ema_seeded_with_sma():
    # seed = mean(1,2,3) = 2 at index 2; alpha = 0.5
    eq(ind.ema([1, 2, 3, 4, 5], 3), [nan, nan, 2, 3, 4])
    eq(ind.ema([10, 0, 0, 0], 1), [10, 0, 0, 0])
    # leading NaNs are skipped: seeded from the first n defined values
    eq(ind.ema([nan, nan, 1, 2, 3, 4], 3), [nan, nan, nan, nan, 2, 3])
    x = [3.0, 5.0, 4.0, 8.0, 6.0]
    a = 2 / 4
    s = (3 + 5 + 4) / 3
    e3 = a * 8 + (1 - a) * s
    eq(ind.ema(x, 3), [nan, nan, s, e3, a * 6 + (1 - a) * e3])


def test_rsi_wilder():
    # d = +1, +1, -1, +1 ; n = 2
    # i=2: ag=1, al=0 -> 100 ; i=3: ag=(1+0)/2=.5, al=(0+1)/2=.5 -> 50 ; i=4: ag=(.5+1)/2=.75, al=.25 -> 75
    eq(ind.rsi([1, 2, 3, 2, 3], 2), [nan, nan, 100, 50, 75])
    eq(ind.rsi([5, 5, 5, 5], 2), [nan, nan, 50, 50])
    eq(ind.rsi([5, 4, 3], 2), [nan, nan, 0])


def test_macd():
    c = np.linspace(1, 50, 60) + np.sin(np.arange(60))
    line, sig, hist = ind.macd(c, 3, 6, 4)
    eq(line, ind.ema(c, 3) - ind.ema(c, 6))
    eq(sig, ind.ema(line, 4))
    assert np.isnan(sig[:8]).all() and np.isfinite(sig[8])  # slow-1 + signal-1 = 5 + 3
    eq(hist, line - sig)


def test_bollinger_population_std():
    mid, up, lo = ind.bollinger([1, 2, 3], 3, 2)
    sd = math.sqrt(2 / 3)
    eq(mid, [nan, nan, 2])
    eq(up, [nan, nan, 2 + 2 * sd])
    eq(lo, [nan, nan, 2 - 2 * sd])


def test_atr():
    # TR = 1, max(2, 1.5, 0.5)=2, max(2, 1.5, 0.5)=2 ; n=2: seed (1+2)/2=1.5 then (1.5+2)/2 = 1.75
    eq(ind.atr([2, 3, 4], [1, 1, 2], [1.5, 2.5, 3], 2), [nan, 1.5, 1.75])


def test_donchian_and_prior_windows():
    x = [1, 3, 2, 5, 4]
    eq(ind.rolling_max(x, 2), [nan, 3, 3, 5, 5])
    eq(ind.rolling_min(x, 2), [nan, 1, 2, 2, 4])
    eq(ind.prior_max(x, 2), [nan, nan, 3, 3, 5])
    eq(ind.prior_min(x, 2), [nan, nan, 1, 2, 2])
    up, lo = ind.donchian([2, 4, 3], [1, 2, 1], 2)
    eq(up, [nan, 4, 4])
    eq(lo, [nan, 1, 1])


def test_returns_and_zscore():
    eq(ind.rolling_return([100, 110, 121, 100], 2), [nan, nan, 0.21, 100 / 110 - 1])
    z = ind.zscore([1, 2, 3, 3, 3, 3], 3)
    eq(z[:2], [nan, nan])
    assert z[2] == pytest.approx(1 / math.sqrt(2 / 3))
    assert z[5] == 0.0  # flat window: std 0 -> 0


def test_shift_refuses_lookahead():
    eq(ind.shift([1, 2, 3], 1), [nan, 1, 2])
    with pytest.raises(ValueError):
        ind.shift([1, 2, 3], -1)


@pytest.mark.parametrize("fn", [
    lambda c: ind.sma(c, 7), lambda c: ind.ema(c, 7), lambda c: ind.rsi(c, 7), lambda c: ind.macd(c, 5, 13, 4)[1],
    lambda c: ind.bollinger(c, 9, 2)[2], lambda c: ind.prior_max(c, 5), lambda c: ind.zscore(c, 6),
    lambda c: ind.rolling_return(c, 4),
])
def test_no_lookahead(fn):
    rng = np.random.default_rng(3)
    c = 100 + np.cumsum(rng.normal(0, 1, 300))
    full = fn(c)
    for k in (50, 120, 299):
        eq(fn(c[: k + 1]), full[: k + 1], tol=1e-9)
        d = c.copy()
        d[k + 1:] = rng.normal(500, 50, len(d) - k - 1)
        eq(fn(d)[: k + 1], full[: k + 1], tol=1e-9)
