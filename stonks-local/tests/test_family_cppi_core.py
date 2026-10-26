import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["cppi_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"mult": 4.0, "floorPct": 0.75, "ratchet": True, "resetMode": "sma", "resetSma": 3, "resetBars": 5,
         "minStep": 0.0, "outBelow": 0.3, **params}
    return normalize_spec({"family": "cppi_core", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "mult": 1.0, "floorPct": 0.9}})
    rng = random.Random(7)
    cd = {"BTC-EUR": synth(800, 2), "ETH-EUR": synth(800, 3, price=1500)}
    for _ in range(10):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}):
            continue
        t = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p)).to_numpy()
        ok = np.isfinite(t).all(axis=1)
        assert ok.any() and not np.isnan(t[int(np.argmax(ok)):]).any()
        assert (t[ok].sum(axis=1) <= 1 + 1e-12).all()
    ex = FAM.explain(spec(markets=("BTC-EUR", "ETH-EUR")))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_full_in_rally_sells_into_crash_and_resets_above_sma():
    path = [100, 100, 100, 110, 120, 130, 120, 110, 100, 95, 90, 92, 95, 100, 110]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    assert (w[2:6] == 1).all()                 # cushion 25 % x 4 = fully in, rally keeps it full
    assert 0 < w[6] < 1 and w[7] < w[6]        # own drawdown eats the cushion: sells step by step
    assert w[8] > 0 and (w[9:12] == 0).all()  # target under outBelow: all in euros
    assert (w[12:] == 1).all()  # back above the 3-bar SMA: fresh cushion


def test_time_reset_and_anchor():
    path = [100, 100, 100, 70, 60, 55, 50, 50, 50, 50, 50, 50]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(resetMode="time", resetBars=4))["BTC-EUR"].to_numpy()
    assert w[3] == 0 and (w[4:7] == 0).all() and w[7] == 1
    df = closes(path)
    w2 = FAM.targets({"BTC-EUR": df}, spec(resetMode="time"), start_time=int(df.index[5]))["BTC-EUR"].to_numpy()
    assert np.isnan(w2[:5]).all() and w2[5] == 1   # paper equity starts fresh at the anchor
