import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["mayer_band"]


def spec(**params):
    return normalize_spec({"family": "mayer_band", "markets": ["BTC-EUR"], "interval": "4h", "params": params}, FAM)


def candles(c):
    c = np.asarray(c, dtype=np.float64)
    return {"BTC-EUR": pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c,
                                     "volume": np.ones(len(c))},
                                    index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready
    assert FAM.validate({"params": {**FAM.default_params(), "cheap": 2.5, "rich": 2.0}}) is not None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(900, 2)}
    for _ in range(25):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        for mw in (1.0, 0.5):
            s = spec(**p)
            s["risk"]["maxWeight"] = mw
            v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
            first = FAM.warmup(p)
            assert np.isnan(v[:first]).all()
            if first < len(v):
                assert not np.isnan(v[first:]).any() and (v[first:] >= 0).all() and (v[first:] <= mw + 1e-12).all()
    ex = FAM.explain(spec(crashBelow=0.8))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_full_when_cheap_trimmed_when_rich():
    # flat at 100 for 50 bars, a blow-off to 1000 (~4.8 %/bar), then a crash to 500
    c = np.concatenate([np.full(50, 100.0), np.geomspace(100, 1000, 50), np.full(30, 1000.0), np.full(60, 500.0)])
    w = FAM.targets(candles(c), spec(sma=20, cheap=0.9, rich=1.5, richWeight=0.2, step=0.1))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:19]).all()
    assert abs(w[30] - 0.9) < 1e-9          # r = 1.0: 0.2 + 0.8 * 0.5/0.6 = 0.867, rounded to the 0.1 step
    assert w[95] <= 0.2 + 1e-9               # far above the average: rich
    assert (w[130:142] == 1.0).all()         # crashed to 0.5-0.7x the average: cheap, fully in


def test_crash_line_sells_everything():
    c = np.concatenate([np.full(40, 100.0), np.linspace(100, 50, 40)])
    w = FAM.targets(candles(c), spec(sma=20, cheap=0.9, rich=1.5, crashBelow=0.85, step=0.1))["BTC-EUR"].to_numpy()
    assert w[39] > 0.5
    assert (w[70:] == 0.0).all()


def test_hysteresis_limits_flips():
    rng = np.random.default_rng(0)
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 600)))
    tgt = FAM.targets(candles(c), spec(sma=50, cheap=0.9, rich=1.3, step=0.25))["BTC-EUR"].to_numpy()[49:]
    changes = np.count_nonzero(np.diff(tgt))
    fine = FAM.targets(candles(c), spec(sma=50, cheap=0.9, rich=1.3, step=0.05))["BTC-EUR"].to_numpy()[49:]
    assert changes < np.count_nonzero(np.diff(fine))
    assert np.allclose(np.round(tgt / 0.25) * 0.25, tgt)
