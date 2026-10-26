import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.phase_shift import daily_candles

FAM = FAMILIES["phase_shift"]
H = 3_600_000
T0 = 1_600_041_600_000  # 2020-09-14 00:00 UTC


def hourly(n, seed=1):
    return synth(n, seed, start=T0, step=H, vol=0.004)


def spec(**params):
    p = {"preset": "sma130", "hour": 0, **params}
    return normalize_spec({"family": "phase_shift", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"preset": "nope", "hour": 0}})
    assert FAM.validate({"params": {"preset": "sma130", "hour": 24}})
    ex = FAM.explain(spec(hour=8))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and "08:00" in ex["summary"]


def test_daily_candles_open_at_the_hour_and_drop_unfinished_days():
    df = hourly(24 * 5 + 10)
    d, last = daily_candles(df, 6)
    assert ((np.asarray(d.index) // H) % 24 == 6).all()
    assert (last <= np.asarray(df.index)[-1]).all()
    # first day: hours 06..23 of day 0 is partial at the start (data begins 00:00): key covers 00..05 of day -1
    first = d.iloc[1]
    rows = df.loc[(df.index >= d.index[1]) & (df.index < d.index[1] + 86_400_000)]
    assert first["close"] == rows["close"].iloc[-1] and first["high"] == rows["high"].max()


def test_hour0_matches_inner_on_native_days_and_only_decides_once_a_day():
    df = hourly(24 * 400)
    w = FAM.targets({"BTC-EUR": df}, spec())["BTC-EUR"].to_numpy()
    ts = np.asarray(df.index)
    dec = np.isfinite(w)
    assert dec.any()
    assert ((ts[dec] // H) % 24 == 23).all()               # decided at the close of the 23:00 candle
    inner = FAMILIES["stale_trend"]
    d, _ = daily_candles(df, 0)
    ispec = normalize_spec({"family": "stale_trend", "markets": ["BTC-EUR"], "interval": "1d",
                            "params": {"coreLen": 130, "hiLook": 60, "staleBars": 0}}, inner)
    iw = inner.targets({"BTC-EUR": d}, ispec)["BTC-EUR"].to_numpy()
    iw = iw[np.isfinite(iw)]
    np.testing.assert_array_equal(w[dec][-len(iw):], iw)


def test_no_lookahead_hourly():
    df = hourly(24 * 300, seed=3)
    for hour in (0, 7, 17):
        full = FAM.targets({"BTC-EUR": df}, spec(hour=hour))["BTC-EUR"].to_numpy()
        for k in (24 * 200 + 5, 24 * 250 + 16, 24 * 260 + 23):
            t = FAM.targets({"BTC-EUR": df.iloc[: k + 1]}, spec(hour=hour))["BTC-EUR"].to_numpy()
            np.testing.assert_array_equal(t, full[: k + 1])


def test_hour_changes_the_decision_time():
    df = hourly(24 * 300, seed=4)
    w = FAM.targets({"BTC-EUR": df}, spec(hour=9))["BTC-EUR"].to_numpy()
    ts = np.asarray(df.index)
    assert ((ts[np.isfinite(w)] // H) % 24 == 8).all()
