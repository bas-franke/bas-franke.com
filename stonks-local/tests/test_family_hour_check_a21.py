import random

import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["hour_check_a21"]
H1 = 3_600_000
DAY = 86_400_000
T0 = 1_600_041_600_000 - (1_600_041_600_000 % DAY)


def spec(markets, **params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "hour_check_a21", "markets": markets, "interval": "1h", "params": p}, FAM)


def hourly(n_days, seed, price):
    return synth(24 * n_days, seed, start=T0, step=H1, drift=0.00005, vol=0.006, price=price)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(2)
    assert sum(FAM.validate({"params": FAM.sample(rng)}) is None for _ in range(20)) == 20
    for pre in ("duo", "flow_committee", "beta_shift", "bag_split"):
        assert len(FAM.explain(spec(["BTC-EUR", "ETH-EUR"], preset=pre))["howItWorks"]) >= 3


def test_hour0_reproduces_native_daily_decisions():
    cd = {"BTC-EUR": hourly(700, 1, 20000.0), "ETH-EUR": hourly(700, 2, 1500.0)}
    for pre, mk in (("duo", ["BTC-EUR", "ETH-EUR"]), ("flow_committee", ["ETH-EUR"]),
                    ("beta_shift", ["BTC-EUR", "ETH-EUR"])):
        s = spec(mk, preset=pre)
        w = FAM.targets(cd, s)
        from stonks_lab.families.hour_check_a21 import _inner
        from stonks_lab.families.phase_shift import daily_candles
        f, inner = _inner(s)
        daily = {m: daily_candles(cd[m], 0, 24)[0] for m in f.markets_needed(inner) if m in cd}
        ref = f.targets(daily, inner)
        for m in mk:
            got = w[m].to_numpy()[23::24]
            exp = ref[m].to_numpy()
            ok = np.isfinite(exp)
            assert ok.sum() > 100, pre
            assert np.allclose(got[ok], exp[ok]), pre
        assert np.isnan(w[mk[0]].to_numpy()[np.arange(len(w)) % 24 != 23]).all()


def test_hour_shift_changes_decision_time():
    cd = {"BTC-EUR": hourly(500, 3, 20000.0), "ETH-EUR": hourly(500, 4, 1500.0)}
    w = FAM.targets(cd, spec(["ETH-EUR"], preset="flow_committee", hour=9))["ETH-EUR"]
    ts = np.asarray(w.index)[np.isfinite(w.to_numpy())]
    assert len(ts) > 100 and (((ts + H1) % DAY) == 9 * H1).all()
