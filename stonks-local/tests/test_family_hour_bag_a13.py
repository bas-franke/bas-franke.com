import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["hour_bag_a13"]
PS = FAMILIES["phase_shift"]
H = 3_600_000
T0 = 1_600_041_600_000  # 2020-09-14 00:00 UTC


def hourly(n, seed=1):
    return synth(n, seed, start=T0, step=H, vol=0.004)


def wavy(n, seed=1):
    """Hourly candles swinging +-30 % around a flat line every ~90 days: crosses its 130-day SMA often."""
    df = synth(n, seed, start=T0, step=H, drift=0.0, vol=0.002)
    f = np.exp(0.3 * np.sin(2 * np.pi * np.arange(n) / (24 * 90)))
    for col in ("open", "high", "low", "close"):
        df[col] = df[col].to_numpy() * f
    return df


def spec(**params):
    p = {"preset": "sma130", "phases": 4, "offset": 0, **params}
    return normalize_spec({"family": "hour_bag_a13", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def ps_spec(hour):
    return normalize_spec({"family": "phase_shift", "markets": ["BTC-EUR"], "interval": "1h",
                           "params": {"preset": "sma130", "hour": hour}}, PS)


def ffill(a):
    out, last = a.copy(), np.nan
    for i, x in enumerate(a):
        if x == x:
            last = x
        out[i] = last
    return out


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"preset": "sma130", "phases": 5, "offset": 0}})
    ex = FAM.explain(spec(phases=3, offset=2))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and "02:00, 10:00, 18:00" in ex["howItWorks"][1]


def test_bag_is_mean_of_phase_shift_tranches_and_only_emits_changes():
    df = wavy(24 * 420, seed=2)
    cd = {"BTC-EUR": df}
    w = FAM.targets(cd, spec(phases=4, offset=3))["BTC-EUR"].to_numpy()
    parts = [ffill(PS.targets(cd, ps_spec(h))["BTC-EUR"].to_numpy()) for h in (3, 9, 15, 21)]
    mean = np.mean(parts, axis=0)
    got = ffill(w)
    ok = np.isfinite(mean)
    assert ok.any()
    np.testing.assert_allclose(got[ok], mean[ok])
    assert np.isnan(got[~ok]).all()
    # emitted at the tranches' decision hours (23:00 of each shifted day), in quarter steps
    dec = np.flatnonzero(np.isfinite(w))
    hrs = set(((np.asarray(df.index)[dec] // H) % 24).tolist())
    assert hrs == {2, 8, 14, 20}
    assert set(np.round(w[dec] * 4, 9)) <= {0.0, 1.0, 2.0, 3.0, 4.0}
    assert len(set(np.round(w[dec] * 4, 9)) - {0.0, 4.0}) > 0   # partial positions do occur


def test_no_lookahead():
    df = hourly(24 * 300, seed=3)
    full = FAM.targets({"BTC-EUR": df}, spec(phases=3, offset=5))["BTC-EUR"].to_numpy()
    rng = np.random.default_rng(7)
    for k in (24 * 200 + 5, 24 * 250 + 16, 24 * 260 + 23):
        trunc = FAM.targets({"BTC-EUR": df.iloc[: k + 1]}, spec(phases=3, offset=5))["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(trunc, full[: k + 1])
        d = df.copy()
        f = rng.uniform(0.3, 3.0, len(d) - k - 1)
        for col in ("open", "high", "low", "close"):
            x = d[col].to_numpy().copy()
            x[k + 1:] *= f
            d[col] = x
        pert = FAM.targets({"BTC-EUR": d}, spec(phases=3, offset=5))["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(pert[: k + 1], full[: k + 1])
