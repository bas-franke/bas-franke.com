import numpy as np
import pandas as pd

from stonks_lab.families import get_family, normalize_spec

H = 3_600_000


def _hourly(close):
    c = np.asarray(close, dtype=np.float64)
    idx = pd.Index(np.arange(len(c), dtype=np.int64) * H, name="ts")
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))}, index=idx)


def _spec(**params):
    fam = get_family("mtf_guard_a24")
    p = {"inner": {"family": "ema_cross", "params": {"fast": 3, "slow": 10}}, **params}
    return fam, normalize_spec({"family": fam.name, "markets": ["BTC-EUR"], "interval": "1h", "params": p}, fam)


def test_daily_lead_only_changes_after_a_day_closes():
    close = 100 * np.exp(np.linspace(0, 1, 24 * 40))       # steady uptrend, 40 days
    fam, spec = _spec(leadTf="1d", guardLook=0)
    w = fam.targets({"BTC-EUR": _hourly(close)}, spec)["BTC-EUR"].to_numpy()
    first = int(np.argmax(np.nan_to_num(w) > 0))
    assert first % 24 == 23                                  # the last hour of a day: that daily candle has closed
    assert np.all(np.isnan(w[:first]) | (w[:first] == 0))


def test_hourly_guard_sells_a_crash_within_the_day_and_waits():
    close = np.r_[100 * np.exp(np.linspace(0, 1, 24 * 30)), np.full(48, 0.0)]
    close[24 * 30:] = close[24 * 30 - 1] * np.r_[np.linspace(0.99, 0.85, 6), np.full(42, 0.85)]
    fam, spec = _spec(leadTf="1d", guardTf="same", guardLook=12, guardDrop=0.05, guardHold=10, guardCut=1.0)
    w = fam.targets({"BTC-EUR": _hourly(close)}, spec)["BTC-EUR"].to_numpy()
    crash = 24 * 30
    assert w[crash - 1] == 1.0
    cut = crash + int(np.argmax(w[crash:] == 0))
    assert cut <= crash + 6                                  # sold within hours, not at the next daily close
    assert np.all(w[cut:cut + 10] == 0)                      # stays out for guardHold hours


def test_half_cut_and_slices():
    close = np.r_[100 * np.exp(np.linspace(0, 1, 24 * 30)), np.full(6, 0.0)]
    close[24 * 30:] = close[24 * 30 - 1] * 0.8
    fam, spec = _spec(leadTf="1d", guardLook=12, guardDrop=0.05, guardHold=3, guardCut=0.5, step=0.1)
    w = fam.targets({"BTC-EUR": _hourly(close)}, spec)["BTC-EUR"].to_numpy()
    f = w[np.isfinite(w)]
    up = np.diff(f)
    assert up.max() <= 0.1 + 1e-9                            # buys in 10 % slices
    assert w[24 * 30] == 0.5                                 # the guard halves the position at once
