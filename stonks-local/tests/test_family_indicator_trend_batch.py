"""aroon_trend, vortex_trend, trix_trend, coppock_curve, williams_dip, elder_impulse."""
import random

import numpy as np
import pytest

from _engine_util import bars, synth
from stonks_lab import backtest as bt
from stonks_lab.families import FAMILIES, normalize_spec

NEW = ["aroon_trend", "vortex_trend", "trix_trend", "coppock_curve", "williams_dip", "elder_impulse"]


def spec(name, **params):
    return normalize_spec({"family": name, "markets": ["BTC-EUR"], "interval": "1d", "params": params},
                          FAMILIES[name])


def rows(xs):
    prev = xs[0]
    out = []
    for x in xs:
        out.append((prev, max(prev, x) * 1.002, min(prev, x) * 0.998, x))
        prev = x
    return bars(out)


def w_of(name, xs, **params):
    return FAMILIES[name].targets({"BTC-EUR": rows(xs)}, spec(name, **params))["BTC-EUR"].to_numpy()


# flat, then a long rise, then a long fall
UPDOWN = [100.0] * 60 + [100 * 1.01 ** k for k in range(1, 121)] + [100 * 1.01 ** 120 * 0.99 ** k
                                                                     for k in range(1, 121)]


@pytest.mark.parametrize("name", NEW)
def test_contract(name):
    fam = FAMILIES[name]
    assert fam.validate({"params": fam.default_params()}) is None
    r = random.Random(7)
    for _ in range(30):
        assert fam.validate({"params": fam.sample(r)}) is None
    ex = fam.explain(spec(name))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


@pytest.mark.parametrize("name", NEW)
def test_backtest_runs_and_weights_bounded(name):
    df = synth(900, seed=3)
    s = spec(name)
    w = FAMILIES[name].targets({"BTC-EUR": df}, s)["BTC-EUR"].to_numpy()
    fin = w[np.isfinite(w)]
    assert len(fin) > 0 and fin.min() >= 0 and fin.max() <= 1
    res = bt.run(s, {"BTC-EUR": df})
    assert res.metrics["bars"] == 900


@pytest.mark.parametrize("name,params", [
    ("aroon_trend", {"n": 20}),
    ("vortex_trend", {"n": 14, "band": 0.0}),
    ("trix_trend", {"n": 8, "signal": 5, "mode": "zero"}),
    ("elder_impulse", {"emaN": 10, "blue": "hold"}),
])
def test_trend_families_ride_rise_and_exit_fall(name, params):
    w = w_of(name, UPDOWN, **params)
    assert w[150] == 1.0   # deep in the rise
    assert w[-1] == 0.0    # deep in the fall


def test_aroon_values():
    from stonks_lab.families.aroon_trend import aroon
    h = np.array([1.0, 2, 3, 4, 5, 4, 3])
    l = h - 0.5
    up, dn = aroon(h, l, 4)
    assert np.isnan(up[3]) and up[4] == 100.0 and dn[4] == 0.0
    assert up[6] == 50.0  # high was 2 bars ago


def test_vortex_rise_favours_plus():
    from stonks_lab.families.vortex_trend import vortex
    df = rows(UPDOWN)
    vip, vim = vortex(df["high"], df["low"], df["close"], 14)
    assert np.isnan(vip[13]) and np.isfinite(vip[14])
    assert vip[150] > vim[150] and vip[-1] < vim[-1]


def test_coppock_buys_after_bottom():
    xs = [100 * 0.99 ** k for k in range(120)] + [100 * 0.99 ** 119 * 1.01 ** k for k in range(1, 121)]
    w = w_of("coppock_curve", xs, rocLong=14, rocShort=11, wma=10, buyBelow=0.0, exit="cross")
    assert w[100] == 0.0      # still falling: never bought
    assert w[-1] == 1.0       # recovered: holding


def test_wma():
    from stonks_lab.families.coppock_curve import wma
    out = wma([1.0, 2.0, 3.0], 3)
    assert np.isnan(out[1]) and out[2] == pytest.approx((1 + 4 + 9) / 6)


def test_williams_dip_trend_gate_and_cap():
    xs = [100 + k for k in range(80)] + [170, 160, 150] + [151, 152, 153, 154, 155, 156, 157, 158, 159, 160]
    on = w_of("williams_dip", xs, n=10, entryLevel=90, exitLevel=5, maxHold=3, trendSma=50)
    assert on[82] == 1.0              # the dip inside an uptrend
    assert on[85] == 0.0              # time cap of 3 candles
    down = [200 - k for k in range(80)] + [110, 100, 90, 91, 92]
    gated = w_of("williams_dip", down, n=10, entryLevel=90, exitLevel=5, maxHold=0, trendSma=50)
    assert np.nanmax(gated) == 0.0    # below the SMA: no dip buys


def test_elder_blue_modes_differ():
    df = synth(600, seed=11)
    ws = {b: FAMILIES["elder_impulse"].targets({"BTC-EUR": df}, spec("elder_impulse", blue=b))["BTC-EUR"].to_numpy()
          for b in ("hold", "half", "cash")}
    assert 0.5 in set(ws["half"][np.isfinite(ws["half"])])
    assert np.nansum(ws["cash"]) <= np.nansum(ws["hold"])
