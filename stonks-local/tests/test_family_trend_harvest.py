import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["trend_harvest"]


def spec(**params):
    return normalize_spec({"family": "trend_harvest", "markets": ["BTC-EUR"], "interval": "1d",
                           "params": params}, FAM)


def run(closes, start_time=None, **params):
    df = bars([(x, x, x, x) for x in closes])
    return FAM.targets({"BTC-EUR": df}, spec(**params), start_time)["BTC-EUR"].to_numpy()


def test_contract():
    assert not FAM.bot_ready and FAM.anchored and FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "fast": 50, "slow": 40}})
    for r in ("cross", "pullback", "cooldown"):
        ex = FAM.explain(spec(reentry=r, sellFraction=0.5, core="ema"))
        assert ex["summary"] and len(ex["howItWorks"]) >= 4


# flat 50 bars, rally to +100 %, pull back to +60 %, rally again, then crash
PATH = [100.0] * 50 + list(np.linspace(101, 200, 20)) + list(np.linspace(195, 160, 8)) + \
       list(np.linspace(165, 260, 15)) + list(np.linspace(250, 80, 20))
BASE = dict(core="ema", fast=3, slow=40, tpPct=0.5)


def test_cross_lockout_sells_all_and_waits():
    w = run(PATH, **BASE, reentry="cross")
    i_on = int(np.argmax(w == 1))
    assert 49 <= i_on <= 51                        # buys when the fast EMA crosses up
    entry = PATH[i_on]
    i_tp = i_on + int(np.argmax(np.asarray(PATH[i_on:]) >= entry * 1.5))
    assert w[i_tp - 1] == 1 and w[i_tp] == 0       # take profit sells everything
    assert (w[i_tp:] == 0).all()                   # the core never switches off then on again: stays out


def test_pullback_and_cooldown_reenter_and_partial():
    w = run(PATH, **{**BASE, "tpPct": 0.9}, reentry="pullback", pullbackPct=0.1)
    i_tp = int(np.argmax(np.nan_to_num(np.diff(w), nan=0) < 0)) + 1
    assert w[i_tp] == 0
    later = w[i_tp:]
    assert (later == 1).any()                      # buys back after a 10 % pullback while the trend is on
    i_back = i_tp + int(np.argmax(later == 1))
    assert PATH[i_back] <= PATH[i_tp] * 0.9
    assert w[-1] == 0                              # the crash turns the core off
    wc = run(PATH, **BASE, reentry="cooldown", cooldownBars=3)
    j = int(np.argmax(np.nan_to_num(np.diff(wc), nan=0) < 0)) + 1
    assert wc[j] == 0 and (wc[j:j + 3] == 0).all() and wc[j + 3] == 1
    wp = run(PATH, **BASE, reentry="cross", sellFraction=0.5)
    assert set(np.unique(wp[~np.isnan(wp)])) == {0.0, 0.5, 1.0}


def test_anchor_starts_flat_and_buys_if_core_on():
    df_idx = bars([(x, x, x, x) for x in PATH]).index
    w = run(PATH, start_time=int(df_idx[60]), **BASE, reentry="cross")
    assert np.isnan(w[:60]).all() and w[60] == 1


def test_no_lookahead():
    cd = {"BTC-EUR": synth(900, 5, vol=0.04)}
    s = spec(core="macd", fast=5, slow=60, signal=9, tpPct=0.15, reentry="pullback", pullbackPct=0.05)
    full = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
    assert (full[~np.isnan(full)] == 1).any()
    for k in (300, 700):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s)["BTC-EUR"].to_numpy(), full[: k + 1])
