import random

import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.froth_bag import member_params
from stonks_lab.families.froth_dip import POOL


def spec(markets=("BTC-EUR",), **params):
    fam = FAMILIES["froth_bag"]
    return normalize_spec({"family": "froth_bag", "markets": list(markets), "interval": "1d", "params": params}, fam)


def small(**kw):
    return {"coreSma": 20, "rsiPeriod": 6, "rsiBelow": 35.0, "breadthMin": 0.8, "sellAbove": 70.0, "maxHold": 15,
            "frothLook": 20, "frothThr": 0.1, "frothBand": 0.05, **kw}


def cands():
    return {m: synth(500, k + 1) for k, m in enumerate(POOL)}


def test_contract_and_sampling():
    fam = FAMILIES["froth_bag"]
    assert not fam.bot_ready and fam.validate({"params": fam.default_params()}) is None
    rng = random.Random(5)
    cd = cands()
    for _ in range(6):
        p = {**fam.sample(rng), "members": 4}
        if fam.validate({"params": p}) is not None:
            continue
        t = fam.targets(cd, spec(("BTC-EUR", "ETH-EUR"), **p)).to_numpy()
        if np.isnan(t).all():
            continue
        first = int(np.argmax(~np.isnan(t).any(axis=1)))
        assert not np.isnan(t[first:]).any()
        assert (t[first:] >= 0).all() and (t[first:].sum(axis=1) <= 1 + 1e-9).all()
    ex = fam.explain(spec(**small(spread=0.3, members=5, step=0.25)))
    assert ex["summary"] and len(ex["howItWorks"]) >= 5


def test_one_member_equals_froth_dip():
    cd = cands()
    p = small()
    a = FAMILIES["froth_dip"].targets(cd, {**spec(**p), "family": "froth_dip", "params": p})["BTC-EUR"].to_numpy()
    b = FAMILIES["froth_bag"].targets(cd, spec(**small(members=1, spread=0.4, step=0.0)))["BTC-EUR"].to_numpy()
    assert np.array_equal(np.isnan(a), np.isnan(b)) and np.allclose(a[~np.isnan(a)], b[~np.isnan(b)])


def test_average_of_members_and_rounding():
    cd = cands()
    p = small(members=6, spread=0.4, step=0.0)
    ms = member_params(p)
    assert ms[0] == {k: v for k, v in small().items()} and len({str(m) for m in ms}) == 6   # deterministic, distinct
    assert member_params(p) == ms
    fd = FAMILIES["froth_dip"]
    cols = [fd.targets(cd, {**spec(**p), "family": "froth_dip", "params": q})["BTC-EUR"].to_numpy() for q in ms]
    want = np.mean(np.stack(cols), axis=0)
    got = FAMILIES["froth_bag"].targets(cd, spec(**p))["BTC-EUR"].to_numpy()
    ok = np.isfinite(want)
    assert np.allclose(got[ok], want[ok]) and np.isnan(got[~ok]).all()
    vals = set(np.unique(np.round(want[ok], 9)))
    assert len(vals) > 2                                   # the bag holds partial positions
    r = FAMILIES["froth_bag"].targets(cd, spec(**{**p, "step": 0.5}))["BTC-EUR"].to_numpy()
    assert set(np.unique(r[np.isfinite(r)])) <= {0.0, 0.5, 1.0}


def test_off_switches_stay_off():
    ms = member_params(small(members=5, spread=0.5, coreSma=0, frothThr=0.0, maxHold=0))
    assert all(m["coreSma"] == 0 and m["frothThr"] == 0 and m["maxHold"] == 0 and m["frothBand"] == 0 for m in ms)
