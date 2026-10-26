import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from test_families import lookahead_problems

FAM = FAMILIES["sig_bag_a12"]
H1 = 3_600_000
T0 = 1_600_000_000_000 - (1_600_000_000_000 % 86_400_000)
A = {"family": "stale_trend", "params": {"coreLen": 30, "hiLook": 60, "staleBars": 0}}
B = {"family": "stale_trend", "params": {"coreLen": 90, "hiLook": 60, "staleBars": 0}}


def spec(mode, wA=0.5, a=A, b=B, mw=1.0):
    return normalize_spec({"family": "sig_bag_a12", "markets": ["BTC-EUR"], "interval": "1h",
                           "params": {"mode": mode, "wA": wA, "a": a, "b": b}, "risk": {"maxWeight": mw}}, FAM)


def candles(n=3000, seed=4):
    return {"BTC-EUR": synth(n, seed, start=T0, step=H1, vol=0.01)}


def held(t):
    v = t["BTC-EUR"].to_numpy()
    out, last = np.full(len(v), np.nan), np.nan
    for i, x in enumerate(v):
        last = x if np.isfinite(x) else last
        out[i] = last
    return out


def test_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "a": {"family": "nope", "params": {}}}})
    assert FAM.validate({"params": {**FAM.default_params(), "b": {"family": "stale_trend",
                                                                    "params": {"coreLen": -1}}}})
    assert len(FAM.explain(spec("and"))["howItWorks"]) >= 3


def test_modes_combine_members_and_reassert_on_member_decisions():
    cd = candles()
    a, b = held(FAM.targets(cd, spec("a"))), held(FAM.targets(cd, spec("b")))
    ok = np.isfinite(a) & np.isfinite(b)
    assert ok.sum() > 1000 and (a[ok] != b[ok]).any()          # the members disagree sometimes
    np.testing.assert_allclose(held(FAM.targets(cd, spec("avg", 0.25)))[ok], 0.25 * a[ok] + 0.75 * b[ok])
    np.testing.assert_allclose(held(FAM.targets(cd, spec("and")))[ok], np.minimum(a, b)[ok])
    np.testing.assert_allclose(held(FAM.targets(cd, spec("or")))[ok], np.maximum(a, b)[ok])
    np.testing.assert_allclose(held(FAM.targets(cd, spec("avg", mw=0.6)))[ok], 0.6 * (0.5 * a + 0.5 * b)[ok])
    raw = FAM.targets(cd, spec("avg"))["BTC-EUR"].to_numpy()
    assert np.isnan(raw[~ok]).all()                              # nothing before both members decided
    # daily members on hourly bars: the bag re-asserts once a day (missed limits retried), NaN in between
    da = {"family": "hourshift_a14", "params": {"hour": "05", "period": "24", "inner": A}}
    db = {"family": "hourshift_a14", "params": {"hour": "05", "period": "24", "inner": B}}
    r2 = FAM.targets(candles(24 * 200), spec("avg", a=da, b=db))["BTC-EUR"]
    ts = np.asarray(r2.index)[np.isfinite(r2.to_numpy())]
    assert len(ts) > 50 and (((ts // H1) % 24) == 4).all()


def test_no_look_ahead():
    cd = candles()
    for mode in ("avg", "and", "or"):
        assert not lookahead_problems(FAM, cd, spec(mode), cuts=(700, 50))
