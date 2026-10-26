import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["floor_wrap_a07"]
H1 = 3_600_000
D1 = 86_400_000
T0 = 1_600_000_000_000 - (1_600_000_000_000 % D1)
SMA = {"family": "stale_trend", "params": {"coreLen": 50, "hiLook": 30, "staleBars": 0}}


def spec(floor, inner=SMA, markets=("BTC-EUR",), interval="1d", mw=1.0):
    return normalize_spec({"family": "floor_wrap_a07", "markets": list(markets), "interval": interval,
                           "params": {"floor": floor, "inner": inner}, "risk": {"maxWeight": mw}}, FAM)


def candles(n=600, seed=4):
    return {"BTC-EUR": synth(n, seed, start=T0, step=D1), "ETH-EUR": synth(n, seed + 1, start=T0, step=D1, price=1500)}


def test_validation_and_explain():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"floor": 0.3, "inner": {"family": "nope", "params": {}}}})
    assert FAM.validate({"params": {"floor": 0.3, "inner": {"family": "floor_wrap_a07", "params": {}}}})
    assert FAM.validate({"params": {"floor": 0.95, "inner": SMA}})
    assert len(FAM.explain(spec(0.3))["howItWorks"]) >= 3


def test_floor_zero_is_the_inner_lead_and_floor_lifts_the_out_state():
    cd = candles()
    inner_fam = FAMILIES["stale_trend"]
    raw = inner_fam.targets(cd, normalize_spec({"family": "stale_trend", "markets": ["BTC-EUR"], "interval": "1d",
                                                "params": SMA["params"]}, inner_fam))["BTC-EUR"].to_numpy()
    a = FAM.targets(cd, spec(0.0))["BTC-EUR"].to_numpy()
    assert np.array_equal(np.nan_to_num(a, nan=-1), np.nan_to_num(raw, nan=-1))
    b = FAM.targets(cd, spec(0.4))["BTC-EUR"].to_numpy()
    ok = np.isfinite(raw)
    assert (raw[ok] == 0).any() and (raw[ok] == 1).any()
    assert np.allclose(b[ok][raw[ok] == 0], 0.4) and np.allclose(b[ok][raw[ok] == 1], 1.0)
    assert np.isnan(b[~ok]).all()
    c = FAM.targets(cd, spec(0.4, mw=0.5))["BTC-EUR"].to_numpy()
    assert np.allclose(c[ok][raw[ok] == 0], 0.2) and np.nanmax(c) <= 0.5 + 1e-12


def test_multi_market_split_and_no_look_ahead():
    cd = candles()
    inner = {"family": "beta_shift", "params": {"coreSma": 60, "ethShare": 1, "heat": "eth_sma", "heatLen": 40,
                                                "heatThr": 0, "offWeight": 0.0}}
    s = spec(0.5, inner, markets=("BTC-EUR", "ETH-EUR"))
    full = FAM.targets(cd, s).to_numpy()
    rows = np.isfinite(full).all(axis=1)
    assert rows.any() and (full[rows] >= 0.25 - 1e-12).all() and (full[rows].sum(axis=1) <= 1 + 1e-12).all()
    for k in (300, 450):
        part = FAM.targets({m: d.iloc[:k] for m, d in cd.items()}, s).to_numpy()
        assert np.array_equal(np.nan_to_num(part, nan=-1), np.nan_to_num(full[:k], nan=-1))


def test_floor_sma_keeps_the_floor_only_above_the_average():
    from stonks_lab import indicators as ind
    cd = candles()
    inner_fam = FAMILIES["stale_trend"]
    raw = inner_fam.targets(cd, normalize_spec({"family": "stale_trend", "markets": ["BTC-EUR"], "interval": "1d",
                                                "params": SMA["params"]}, inner_fam))["BTC-EUR"].to_numpy()
    s = spec(0.4)
    s["params"]["floorSma"] = 120
    b = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
    c = cd["BTC-EUR"]["close"].to_numpy()
    sm = ind.sma(c, 120)
    ok = np.isfinite(raw) & np.isfinite(sm)
    out = ok & (raw == 0)
    assert (out & (c > sm)).any() and (out & (c <= sm)).any()
    assert np.allclose(b[out & (c > sm)], 0.4) and np.allclose(b[out & (c <= sm)], 0.0)
    assert np.allclose(b[ok & (raw == 1)], 1.0)
    part = FAM.targets({m: d.iloc[:400] for m, d in cd.items()}, s)["BTC-EUR"].to_numpy()
    assert np.array_equal(np.nan_to_num(part, nan=-1), np.nan_to_num(b[:400], nan=-1))
