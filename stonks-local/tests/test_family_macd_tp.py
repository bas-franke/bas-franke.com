import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["macd_tp"]


def spec(**params):
    return normalize_spec({"family": "macd_tp", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    for _ in range(40):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec(tpPct=0.3, stretchPct=0.5, pullbackPct=0.1))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_plain_macd_holds_uptrend_and_exits_downtrend():
    xs = [100.0] * 30 + list(np.linspace(100, 130, 30)) + list(np.linspace(130, 80, 30))
    w = FAM.targets(closes(xs), spec(fast=3, slow=10, signal=3, tpPct=0, stretchPct=0, pullbackPct=0))
    w = w["BTC-EUR"].to_numpy()
    assert np.isnan(w[:5]).all()
    assert w[45] == 1.0
    assert w[85] == 0.0


def test_take_profit_then_locked_until_fresh_cross():
    xs = [100.0] * 30 + list(np.linspace(100, 160, 40))
    w = FAM.targets(closes(xs), spec(fast=3, slow=10, signal=3, tpPct=0.2, stretchPct=0, pullbackPct=0))
    w = w["BTC-EUR"].to_numpy()
    on = np.flatnonzero(w == 1.0)
    assert len(on) > 0
    first = on[0]
    # it entered and then sold once the close was 20 % above the entry close, and stays out in the uptrend
    entry = xs[first]
    exit_bar = next(t for t in range(first, len(xs)) if xs[t] >= entry * 1.2)
    assert w[exit_bar] == 0.0 and (w[exit_bar:] == 0.0).all()
    assert (w[first:exit_bar] == 1.0).all()


def test_pullback_reentry():
    xs = [100.0] * 70 + list(100 * 1.02 ** np.arange(17))
    xs = xs + [xs[85] * 0.94] + list(xs[85] * 0.94 * 1.02 ** np.arange(1, 6))
    base = dict(fast=5, slow=40, signal=30, tpPct=0.3, stretchPct=0)
    w0 = FAM.targets(closes(xs), spec(**base, pullbackPct=0))["BTC-EUR"].to_numpy()[80:]
    w1 = FAM.targets(closes(xs), spec(**base, pullbackPct=0.04))["BTC-EUR"].to_numpy()[80:]
    assert list(w0) == [1.0] * 5 + [0.0] * 8           # profit taken at bar 85, then locked (MACD still on)
    assert list(w1) == [1.0] * 5 + [0.0] * 2 + [1.0] * 6  # bought back after the 6 % dip under the exit close


def test_stretch_exit_and_no_buy_when_stretched():
    xs = [100.0] * 40 + list(np.linspace(100, 200, 25))
    w = FAM.targets(closes(xs), spec(fast=3, slow=20, signal=3, tpPct=0, stretchPct=0.15, pullbackPct=0))
    w = w["BTC-EUR"].to_numpy()
    assert (w[-5:] == 0.0).all()   # far above the slow EMA: sold / not bought
    assert (w == 1.0).any()


def test_max_weight():
    s = spec(fast=3, slow=10, signal=3, tpPct=0, stretchPct=0, pullbackPct=0)
    s["risk"]["maxWeight"] = 0.5
    w = FAM.targets(closes([100.0] * 20 + list(np.linspace(100, 130, 30))), s)["BTC-EUR"].to_numpy()
    assert set(np.unique(w[~np.isnan(w)])) <= {0.0, 0.5}
    assert (w == 0.5).any()


def test_no_lookahead():
    cd = {"BTC-EUR": synth(700, 7, drift=0.0006, vol=0.03)}
    for s in (spec(fast=8, slow=60, signal=12, tpPct=0.15, stretchPct=0, pullbackPct=0.05),
              spec(fast=5, slow=40, signal=9, tpPct=0, stretchPct=0.2, pullbackPct=0.04)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (150, 450):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
