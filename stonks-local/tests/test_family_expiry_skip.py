import random

import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

DAY = 86_400_000
JAN1 = 1_704_067_200_000  # 2024-01-01 00:00 UTC


def spec(interval="1d", **params):
    fam = FAMILIES["expiry_skip"]
    p = fam.default_params()
    p.update(params)
    return normalize_spec({"family": "expiry_skip", "markets": ["ETH-EUR"], "interval": interval, "params": p}, fam)


def test_contract():
    fam = FAMILIES["expiry_skip"]
    assert not fam.bot_ready
    assert fam.validate({"params": {**fam.default_params(), "outStart": 1, "outEnd": 0}}) is not None
    rng = random.Random(3)
    ok = 0
    for _ in range(40):
        p = fam.sample(rng)
        ok += fam.validate({"params": p}) is None
    assert ok > 5
    ex = fam.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 2


def test_offsets_around_known_expiries():
    from stonks_lab.families.expiry_skip import expiry_offset
    # last Fridays 2024: Jan 26, Feb 23, Mar 29
    days = ["2024-01-22", "2024-01-26", "2024-01-29", "2024-02-02", "2024-02-20", "2024-03-29", "2024-04-01"]
    ts = np.array([pd.Timestamp(d).value // 1_000_000 for d in days], dtype=np.int64)
    rel, q = expiry_offset(ts)
    assert rel.tolist() == [-4, 0, 3, 7, -3, 0, 3]
    assert q.tolist() == [False, False, False, False, False, True, True]


def test_skips_the_window_using_next_bar_date():
    fam = FAMILIES["expiry_skip"]
    cd = {"ETH-EUR": synth(40, 1, start=JAN1, step=DAY)}
    w = fam.targets(cd, spec(outStart=-4, outEnd=-2))["ETH-EUR"].to_numpy()
    # Jan 26 is the expiry; out days Jan 22, 23, 24 -> decided at the closes of Jan 21, 22, 23 (index 20, 21, 22);
    # Feb 23 expiry: out Feb 19-21 -> decided at index 48.. (beyond 40 bars)
    exp = np.ones(40)
    exp[[20, 21, 22]] = 0
    np.testing.assert_array_equal(w, exp)
    wq = fam.targets(cd, spec(outStart=-4, outEnd=-2, quarterlyOnly=True))["ETH-EUR"].to_numpy()
    assert (wq == 1).all()


def test_trend_filter_and_no_lookahead():
    fam = FAMILIES["expiry_skip"]
    cd = {"ETH-EUR": synth(400, 5, start=JAN1, step=DAY)}
    s = spec(outStart=-3, outEnd=1, trendSma=30)
    full = fam.targets(cd, s)["ETH-EUR"].to_numpy()
    assert np.isnan(full[:29]).all() and not np.isnan(full[29:]).any()
    c = cd["ETH-EUR"]["close"].to_numpy()
    sma = np.convolve(c, np.ones(30) / 30, "valid")
    assert (full[29:][c[29:] <= sma] == 0).all()
    for k in (120, 333):
        trunc = {"ETH-EUR": cd["ETH-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(fam.targets(trunc, s)["ETH-EUR"].to_numpy(), full[: k + 1])
