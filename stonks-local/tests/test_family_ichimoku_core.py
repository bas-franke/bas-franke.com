import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["ichimoku_core"]


def spec(**params):
    base = {"tenkan": 2, "kijun": 4, "senkouB": 6, "shift": 0, "tkCross": False, "chikou": False,
            "exitLine": "cloud"}
    base.update(params)
    return normalize_spec({"family": "ichimoku_core", "markets": ["BTC-EUR"], "interval": "1d", "params": base}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(7)
    ok = 0
    for _ in range(60):
        p = FAM.sample(r)
        if FAM.validate({"params": p}) is None:
            ok += 1
    assert ok > 0
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_buys_above_cloud_sells_below():
    xs = [100.0] * 8 + [110.0, 120.0, 125.0, 118.0, 90.0]
    w = FAM.targets(closes(xs), spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:5]).all()
    assert (w[5:8] == 0.0).all()     # flat: close == cloud top, not above
    assert w[8] == 1.0               # 110 > cloud top (spans ~100-105)
    assert w[11] == 1.0              # 118 still above the cloud bottom
    assert w[12] == 0.0              # 90 under the cloud bottom: sells


def test_shift_lags_cloud():
    xs = [100.0] * 10 + [200.0] * 3 + [150.0]
    # no shift: cloud follows the jump, 150 is under the bottom (midpoints 150-175) -> exit at last bar via top?
    lag = FAM.targets(closes(xs), spec(shift=5, exitLine="cloud"))["BTC-EUR"].to_numpy()
    assert lag[10] == 1.0 and lag[-1] == 1.0   # lagged cloud still at 100: holds through the pullback


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(tenkan=9, kijun=26, senkouB=52, shift=26, tkCross=True, chikou=True, exitLine="kijun"),
              spec(tenkan=20, kijun=60, senkouB=120, shift=30, exitLine="cloud")):
        full = FAM.targets(cd, s).to_numpy()
        for k in (200, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
