import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.alt_froth import OLD_ALTS

FAM = FAMILIES["winter_core_a14"]
D = 86_400_000


def spec(market="BTC-EUR", **params):
    p = {"highLen": 300, "depth": 0.6, "coreSma": 0, **params}
    return normalize_spec({"family": "winter_core_a14", "markets": [market], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c], step=D)


def pool(alt_path):
    return {m: closes(alt_path) for m in OLD_ALTS}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(1)
    cd = {"BTC-EUR": synth(900, 3, step=D), **{m: synth(900, 10 + i, step=D) for i, m in enumerate(OLD_ALTS)}}
    for _ in range(12):
        s = spec(**FAM.sample(rng))
        v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 1.0}
        assert FAM.explain(s)["summary"]


def test_holds_in_alt_winter_only():
    n = 600
    btc = [100.0] * n
    alt = [100.0] * 300 + [100 * 0.98 ** i for i in range(1, 101)] + [100 * 0.98 ** 100] * 200
    w = FAM.targets({"BTC-EUR": closes(btc), **pool(alt)}, spec())["BTC-EUR"].to_numpy()
    assert (w[200:300] == 0).all()            # alts at their high: no winter, no core -> euros
    assert w[399] == 1 and w[450] == 1        # alts down ~87 %: hold BTC
    assert np.isnan(w[:199]).all()            # pool needs 200 bars of history


def test_core_or_winter_and_self_excluded():
    c = synth(500, 5, step=D)["close"].to_numpy()
    flat = [50.0] * 500
    cd = {"BTC-EUR": closes(c), **pool(flat)}
    w = FAM.targets(cd, spec(coreSma=20))["BTC-EUR"].to_numpy()
    sma = np.convolve(c, np.ones(20) / 20, mode="valid")
    core = (c[19:] > sma).astype(float)
    ok = np.isfinite(w[19:])
    assert ok.any() and (w[19:][ok] == core[ok]).all()   # flat alts: no winter, pure core
    # traded alt is dropped from its own pool: a crash in XRP alone is no winter for XRP
    crash = [100.0] * 300 + [100 * 0.97 ** i for i in range(1, 201)]
    cd2 = {**pool(flat), "XRP-EUR": closes(crash)}
    w2 = FAM.targets(cd2, spec(market="XRP-EUR"))["XRP-EUR"].to_numpy()
    assert np.nanmax(w2) == 0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(700, 8, step=D), **{m: synth(700, 30 + i, step=D) for i, m in enumerate(OLD_ALTS)}}
    rng = random.Random(4)
    for _ in range(4):
        s = spec(**{**FAM.sample(rng), "highLen": 300})
        full = FAM.targets(cd, s)["BTC-EUR"]
        for cut in (320, 451, 650):
            part = FAM.targets({k: v.iloc[:cut] for k, v in cd.items()}, s)["BTC-EUR"]
            a, b = full.iloc[:cut].to_numpy(), part.to_numpy()
            assert np.array_equal(np.isnan(a), np.isnan(b)) and np.allclose(a[~np.isnan(a)], b[~np.isnan(b)])
