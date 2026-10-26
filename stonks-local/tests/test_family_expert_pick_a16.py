import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["expert_pick_a16"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "expert_pick_a16", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "minLen": 100, "maxLen": 90}})
    rng = random.Random(5)
    cd = {"BTC-EUR": synth(900, 2), "ETH-EUR": synth(900, 3)}
    for _ in range(8):
        p = FAM.sample(rng)
        df = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p))
        v = df.to_numpy()
        ok = np.isfinite(v).all(axis=1)
        assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
        assert (v[np.isfinite(v)] <= 0.5 + 1e-12).all() and (v[np.isfinite(v)] >= 0).all()
    ex = FAM.explain(spec(topK=2))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_follows_hold_in_steady_rise_and_cash_rule_in_crash():
    # a steady rise: every expert holds; then a long fall: SMA experts go to cash and outscore hold
    path = list(np.linspace(100, 200, 60)) + list(np.linspace(199, 60, 80))
    p = dict(n=2, minLen=3, maxLen=6, window=10, topK=1, withHold=True, paperFee=0.0)
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(**p))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:16]).all()
    assert (w[20:60] == 1).all()          # rising: everyone long
    assert (w[-30:] == 0).all()           # falling: the best expert is an SMA rule in cash


def test_hold_only_bank_and_topk_average():
    path = list(np.linspace(100, 50, 40)) + list(np.linspace(51, 150, 40))
    p = dict(n=2, minLen=3, maxLen=6, window=5, topK=3, withHold=True, paperFee=0.0)
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(**p))["BTC-EUR"].to_numpy()
    # topK = all three experts: average position; in the late rise all three hold
    assert (w[-10:] == 1).all()
    assert set(np.round(w[np.isfinite(w)] * 3).astype(int)) <= {0, 1, 2, 3}
    assert (w[20:40] == 1 / 3).all()      # falling: only hold is long


def test_no_lookahead_truncation():
    cd = {"BTC-EUR": synth(700, 4)}
    s = spec(n=4, minLen=5, maxLen=40, window=30, topK=2)
    full = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
    for cut in (120, 333, 600):
        part = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[:cut]}, s)["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(part, full[:cut])
