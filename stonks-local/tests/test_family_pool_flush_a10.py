import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.pool_flush_a10 import POOL, daily_core, required_markets

FAM = FAMILIES["pool_flush_a10"]
H = 3_600_000
T0 = 1_600_041_600_000  # 2020-09-14 00:00 UTC


def hourly(n, seed=1, drift=0.0, vol=0.002):
    return synth(n, seed, start=T0, step=H, vol=vol, drift=drift)


def spec(market="BTC-EUR", **params):
    return normalize_spec({"family": "pool_flush_a10", "markets": [market], "interval": "1h", "params": params}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    s = spec(source="pool")
    assert set(POOL) <= set(required_markets(s))
    assert required_markets(spec(source="own")) == ["BTC-EUR"]
    ex = FAM.explain(s)
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_pool_crash_buys_and_holds_for_hold_hours():
    n = 24 * 30
    btc = hourly(n, seed=1)
    candles = {"BTC-EUR": btc}
    crash_at = 24 * 20 + 5
    for k, a in enumerate(POOL):
        df = hourly(n, seed=10 + k).copy()
        f = np.ones(n)
        f[crash_at:] = 0.7                       # every alt drops 30 % in one hour
        for col in ("open", "high", "low", "close"):
            df[col] = df[col] * f
        candles[a] = df
    w = FAM.targets(candles, spec(coreDays=0, source="pool", flushHours=24, dropMin=0.2, holdHours=10))["BTC-EUR"]
    w = w.to_numpy()
    assert np.nanmax(w[:crash_at]) == 0
    assert (w[crash_at:crash_at + 10] == 1).all()
    assert (w[crash_at + 10:] == 0).all()
    # own source ignores the alt crash
    wo = FAM.targets(candles, spec(coreDays=0, source="own", flushHours=24, dropMin=0.2, holdHours=10))["BTC-EUR"]
    assert np.nanmax(wo.to_numpy()) == 0


def test_daily_core_changes_only_at_23h_and_follows_trend():
    up = hourly(24 * 60, seed=2, drift=0.001)
    core = daily_core(up, 10)
    ts = np.asarray(up.index)
    ch = np.flatnonzero(np.diff(core.astype(int)) != 0) + 1
    assert ((ts[ch] // H) % 24 == 23).all()
    assert core[-24:].all()
    w = FAM.targets({"BTC-EUR": up}, spec(coreDays=10, source="own", dropMin=0.3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[0]) and w[-1] == 1


def test_no_lookahead():
    n = 24 * 40
    candles = {"BTC-EUR": hourly(n, seed=5, vol=0.01)}
    for k, a in enumerate(POOL):
        candles[a] = hourly(n, seed=30 + k, vol=0.02)
    s = spec(coreDays=5, source="pool", flushHours=12, dropMin=0.05, holdHours=20)
    full = FAM.targets(candles, s)["BTC-EUR"].to_numpy()
    for k in (24 * 10 + 3, 24 * 25 + 23, 24 * 33 + 11):
        cut = {m: d.iloc[: k + 1] for m, d in candles.items()}
        t = FAM.targets(cut, s)["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(t, full[: k + 1])
