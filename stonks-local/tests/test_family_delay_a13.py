import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["delay_a13"]
D1 = 86_400_000
SMA = {"family": "stale_trend", "params": {"coreLen": 20, "hiLook": 60, "staleBars": 0}}
UPS = {"family": "upday_share", "params": {"look": 20, "enter": 0.55, "exit": 0.5, "coreLen": 0, "combine": "and",
                                          "scope": "own"}}


def spec(delay="1", inner=SMA, markets=("BTC-EUR",)):
    return normalize_spec({"family": "delay_a13", "markets": list(markets), "interval": "1d",
                           "params": {"delay": delay, "inner": inner}}, FAM)


def candles():
    return {"BTC-EUR": synth(400, 3, step=D1), "ETH-EUR": synth(400, 4, step=D1)}


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"delay": "4", "inner": SMA}})           # not a listed delay
    assert FAM.validate({"params": {"delay": "1", "inner": {"family": "nope", "params": {}}}})
    assert FAM.validate({"params": {"delay": "1", "inner": {"family": "stale_trend", "params": {"coreLen": -5}}}})
    ex = FAM.explain(spec("3"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_delay_zero_is_the_inner_lead_and_delay_shifts_it():
    cd = candles()
    inner = FAMILIES["upday_share"]
    s_in = normalize_spec({"family": "upday_share", "markets": ["BTC-EUR", "ETH-EUR"], "interval": "1d",
                           "params": UPS["params"]}, inner)
    base = inner.targets(cd, s_in)
    w0 = FAM.targets(cd, spec("0", inner=UPS, markets=("BTC-EUR", "ETH-EUR")))
    for m in ("BTC-EUR", "ETH-EUR"):
        a, b = w0[m].to_numpy(), base[m].to_numpy()
        assert np.array_equal(np.nan_to_num(a, nan=-1), np.nan_to_num(b, nan=-1))
    for d in (1, 5):
        w = FAM.targets(cd, spec(str(d), inner=UPS, markets=("BTC-EUR", "ETH-EUR")))
        for m in ("BTC-EUR", "ETH-EUR"):
            a, b = w[m].to_numpy(), base[m].to_numpy()
            assert np.isnan(a[:d]).all()
            assert np.array_equal(np.nan_to_num(a[d:], nan=-1), np.nan_to_num(b[:-d], nan=-1))
            assert set(np.unique(a[np.isfinite(a)])) <= {0.0, 0.5}


def test_single_market_core_is_shifted():
    cd = {"BTC-EUR": synth(300, 5, step=D1)}
    a = FAM.targets(cd, spec("0"))["BTC-EUR"].to_numpy()
    b = FAM.targets(cd, spec("2"))["BTC-EUR"].to_numpy()
    assert np.isfinite(a).sum() > 200 and (np.diff(np.nan_to_num(a)) != 0).any()
    assert np.array_equal(np.nan_to_num(b[2:], nan=-1), np.nan_to_num(a[:-2], nan=-1))
