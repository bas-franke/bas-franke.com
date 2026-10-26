import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.clock_a13 import PRESETS, period_hours, required_markets
from stonks_lab.families.phase_shift import daily_candles

FAM = FAMILIES["clock_a13"]
H = 3_600_000
T0 = 1_600_041_600_000  # 2020-09-14 00:00 UTC
MARKETS = {"wick_eth": ["ETH-EUR"], "beta_shift": ["BTC-EUR", "ETH-EUR"], "ratio_btc": ["BTC-EUR"],
           "duo": ["BTC-EUR", "ETH-EUR"], "era12": ["BTC-EUR"]}


def hourly(n, seed=1):
    return synth(n, seed, start=T0, step=H, vol=0.004)


def spec(preset, hour):
    return normalize_spec({"family": "clock_a13", "markets": MARKETS[preset], "interval": "1h",
                           "params": {"preset": preset, "hour": hour}}, FAM)


def candles_for(s, n, seed=0):
    return {m: hourly(n, seed=seed + i) for i, m in enumerate(required_markets(s))}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"preset": "nope", "hour": 0}})
    assert FAM.validate({"params": {"preset": "duo", "hour": 24}})
    for preset in PRESETS:
        ex = FAM.explain(spec(preset, 7))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_every_preset_decides_at_the_shifted_close_and_hour0_matches_inner():
    for preset in PRESETS:
        s = spec(preset, 5)
        cd = candles_for(s, 24 * 900, seed=3)
        w = FAM.targets(cd, s)
        ts = np.asarray(w.index)
        dec = np.isfinite(w.to_numpy(np.float64)).any(axis=1)
        assert dec.any(), preset
        per = period_hours(preset)
        assert (((ts[dec] // H) - 5) % per == per - 1).all(), preset
    # hour 0 = the inner family on the native candles
    s = spec("ratio_btc", 0)
    cd = candles_for(s, 24 * 900, seed=4)
    w = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
    name, params = PRESETS["ratio_btc"]
    inner = FAMILIES[name]
    daily = {m: daily_candles(df, 0)[0] for m, df in cd.items()}
    ispec = normalize_spec({"family": name, "markets": ["BTC-EUR"], "interval": "1d", "params": params}, inner)
    iw = inner.targets(daily, ispec)["BTC-EUR"].to_numpy()
    iw = iw[np.isfinite(iw)]
    got = w[np.isfinite(w)]
    np.testing.assert_array_equal(got[-len(iw):], iw[-len(got):] if len(got) < len(iw) else iw)


def test_no_lookahead():
    for preset in ("ratio_btc", "beta_shift", "era12"):
        s = spec(preset, 9)
        cd = candles_for(s, 24 * 700, seed=6)
        full = FAM.targets(cd, s).to_numpy(np.float64)
        n = len(next(iter(cd.values())))
        for k in (24 * 600 + 3, 24 * 650 + 20):
            cut = {m: df.iloc[: k + 1] for m, df in cd.items()}
            part = FAM.targets(cut, s).to_numpy(np.float64)
            np.testing.assert_array_equal(part, full[: k + 1])
        assert n == 24 * 700
