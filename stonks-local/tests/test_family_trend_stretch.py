import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["trend_stretch"]


def spec(markets=("ETH-EUR",), **params):
    return normalize_spec({"family": "trend_stretch", "markets": list(markets), "interval": "4h", "params": params},
                          FAM)


def closes(c, market="ETH-EUR"):
    c = np.asarray(c, dtype=np.float64)
    return {market: pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))},
                                 index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))}


def wiggle(n, seed=0, vol=0.01):
    return np.exp(np.random.default_rng(seed).normal(0, vol, n))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready and FAM.multi_market
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(1400, 1), "ETH-EUR": synth(1400, 2, price=1500)}
    for _ in range(25):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mw in (1.0, 0.5):
            s = spec(("BTC-EUR", "ETH-EUR"), **p)
            s["risk"]["maxWeight"] = mw
            v = FAM.targets(cd, s).to_numpy()
            first = int(np.argmax(~np.isnan(v).all(axis=1)))
            assert not np.isnan(v[first:]).any() and (v[first:] >= 0).all()
            assert (v[first:].sum(axis=1) <= mw + 1e-12).all()
    ex = FAM.explain(spec(("BTC-EUR", "ETH-EUR"), concentrate=True))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_plain_macd_when_stretch_off():
    cd = {"ETH-EUR": synth(900, 4, price=1500)}
    w = FAM.targets(cd, spec(fast=5, slow=30, signal=9, stretchLen=0))["ETH-EUR"].to_numpy()
    m = FAMILIES["macd_trend"]
    ref = m.targets(cd, normalize_spec({"family": "macd_trend", "markets": ["ETH-EUR"], "interval": "4h",
                                        "params": {"fast": 5, "slow": 30, "signal": 9}}, m))["ETH-EUR"].to_numpy()
    np.testing.assert_array_equal(w, ref)


def test_blowoff_exit_and_rearm():
    # calm drift, then a parabolic run (sells into it), then a crash (MACD turns off), then a steady recovery (buys)
    calm = 100 * np.cumprod(np.full(200, 1.001)) * wiggle(200, 1)
    run = calm[-1] * np.cumprod(np.full(40, 1.03))
    crash = run[-1] * np.cumprod(np.full(60, 0.97))
    rec = crash[-1] * np.cumprod(np.full(150, 1.006)) * wiggle(150, 2, 0.002)
    c = np.concatenate([calm, run, crash, rec])
    p = dict(fast=5, slow=40, signal=9, stretchLen=20, volLen=60, exitZ=2.0, rearm="cross")
    w = FAM.targets(closes(c), spec(**p))["ETH-EUR"].to_numpy()
    plain = FAM.targets(closes(c), spec(**{**p, "stretchLen": 0}))["ETH-EUR"].to_numpy()
    assert (plain[215:240] == 1).all()                 # plain MACD rides the whole run
    assert w[205] == 1.0 and (w[212:240] == 0).all()   # the stretch exit has sold early in the run
    assert (w[240:275] == 0).all()                     # no re-buy into the crash
    assert w[300:].max() == 1.0                       # recross after the crash buys again


def test_calm_rearm_rebuys_while_trend_on():
    calm = 100 * np.cumprod(np.full(200, 1.001)) * wiggle(200, 1)
    run = calm[-1] * np.cumprod(np.full(30, 1.03))
    flat = run[-1] * np.cumprod(np.full(80, 1.0005)) * wiggle(80, 3, 0.002)
    c = np.concatenate([calm, run, flat])
    p = dict(fast=5, slow=60, signal=30, stretchLen=20, volLen=60, exitZ=2.0)
    cross = FAM.targets(closes(c), spec(rearm="cross", **p))["ETH-EUR"].to_numpy()
    calm_w = FAM.targets(closes(c), spec(rearm="calm", **p))["ETH-EUR"].to_numpy()
    assert (cross[225:230] == 0).all() and (calm_w[225:230] == 0).all()
    # the stretch cools during the flat phase: calm re-buys while the slow MACD may still be on
    assert calm_w[230:].max() == 1.0


def test_concentrate_gives_idle_slice_to_active_coin():
    n = 400
    up = 100 * np.cumprod(np.full(n, 1.004)) * wiggle(n, 1, 0.003)
    down = np.concatenate([up[:370], up[369] * np.cumprod(np.full(n - 370, 0.985))])
    cd = {**closes(up, "BTC-EUR"), **closes(down, "ETH-EUR")}
    p = dict(fast=5, slow=40, signal=9, stretchLen=0)
    eq = FAM.targets(cd, spec(("BTC-EUR", "ETH-EUR"), **p)).to_numpy()
    co = FAM.targets(cd, spec(("BTC-EUR", "ETH-EUR"), concentrate=True, **p)).to_numpy()
    assert eq[-1, 0] == 0.5 and eq[-1, 1] == 0.0
    assert co[-1, 0] == 1.0 and co[-1, 1] == 0.0
