import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.phase_shift import daily_candles

FAM = FAMILIES["hourcheck_a19"]
H = 3_600_000
T0 = 1_600_041_600_000  # 2020-09-14 00:00 UTC
MK = {"wick_pressure": ["ETH-EUR"], "beta_shift": ["BTC-EUR", "ETH-EUR"], "duo_core": ["BTC-EUR", "ETH-EUR"]}


def hourly(n, seed=1):
    return synth(n, seed, start=T0, step=H, vol=0.004)


def data(n, seed=1):
    return {"BTC-EUR": hourly(n, seed), "ETH-EUR": hourly(n, seed + 50)}


def spec(preset="wick_pressure", hour=0):
    return normalize_spec({"family": "hourcheck_a19", "markets": MK[preset], "interval": "1h",
                           "params": {"preset": preset, "hour": hour}}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"preset": "nope", "hour": 0}})
    assert FAM.validate({"params": {"preset": "beta_shift", "hour": 24}})
    ex = FAM.explain(spec("beta_shift", 8))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and "08:00" in ex["summary"]


def test_hour0_matches_inner_family_on_native_days():
    c = data(24 * 420)
    for preset, (name, params) in __import__("stonks_lab.families.hourcheck_a19", fromlist=["PRESETS"]).PRESETS.items():
        s = spec(preset)
        w = FAM.targets(c, s)
        ts = np.asarray(c["BTC-EUR"].index)
        inner = FAMILIES[name]
        d = {m: daily_candles(c[m], 0)[0] for m in c}
        ispec = normalize_spec({"family": name, "markets": MK[preset], "interval": "1d", "params": params}, inner)
        iw = inner.targets(d, ispec)
        for m in MK[preset]:
            col = w[m].to_numpy()
            dec = np.isfinite(col)
            assert ((ts[dec] // H) % 24 == 23).all()
            ref = iw[m].to_numpy()
            ref = ref[np.isfinite(ref)]
            np.testing.assert_allclose(col[dec][-len(ref):], ref)


def test_hour_moves_decision_time():
    c = data(24 * 300, seed=4)
    w = FAM.targets(c, spec("beta_shift", 9))
    ts = np.asarray(c["BTC-EUR"].index)
    for m in ("BTC-EUR", "ETH-EUR"):
        assert ((ts[np.isfinite(w[m].to_numpy())] // H) % 24 == 8).all()


def test_no_lookahead_hourly():
    c = data(24 * 300, seed=3)
    for preset in ("wick_pressure", "beta_shift"):
        for hour in (0, 13):
            full = FAM.targets(c, spec(preset, hour))
            for k in (24 * 250 + 5, 24 * 270 + 22):
                part = FAM.targets({m: df.iloc[: k + 1] for m, df in c.items()}, spec(preset, hour))
                for m in MK[preset]:
                    np.testing.assert_array_equal(part[m].to_numpy(), full[m].to_numpy()[: k + 1])
