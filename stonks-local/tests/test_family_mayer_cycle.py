import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["mayer_cycle"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "mayer_cycle", "markets": list(markets), "interval": "1d", "params": params}, FAM)


def frame_of(c):
    c = np.asarray(c, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready and FAM.multi_market
    assert FAM.validate({"params": {**FAM.default_params(), "cheap": 1.1, "rich": 1.05}}) is not None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2)}
    for _ in range(20):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mk in (["BTC-EUR"], ["BTC-EUR", "ETH-EUR"]):
            for mw in (1.0, 0.6):
                s = spec(mk, **p)
                s["risk"]["maxWeight"] = mw
                t = FAM.targets(cd, s).to_numpy()
                first = int(np.argmax(~np.isnan(t).all(axis=1)))
                assert first <= FAM.warmup(p)
                v = t[first:]
                assert not np.isnan(v).any() and (v >= 0).all() and (v.sum(axis=1) <= mw + 1e-9).all()
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], slopeBars=20))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_sizes_by_multiple():
    # flat at 100 for 60 bars (multiple 1), then a jump to 300 (multiple 2.5), then a crash to 40 (multiple ~0.13).
    c = np.concatenate([np.full(60, 100.0), np.full(70, 300.0), np.full(40, 40.0)])
    w = FAM.targets({"BTC-EUR": frame_of(c)}, spec(sma=20, cheap=0.9, rich=2.0, floorWeight=0.2, step=0.1))
    w = w["BTC-EUR"].to_numpy()
    assert np.isnan(w[:19]).all()
    # multiple 1.0: (2.0 - 1.0) / 1.1 = 0.909 -> 0.2 + 0.8 * 0.909 = 0.927 -> step 0.9
    assert np.allclose(w[25:60], 0.9)
    # far above its 20-bar average right after the jump: floor
    assert np.allclose(w[60:63], 0.2)
    # back near the average once it has caught up
    assert np.allclose(w[90:130], 0.9)
    # crashed far below the average: full size
    assert np.allclose(w[130:140], 1.0)


def test_cycle_filter_and_split():
    c = np.concatenate([np.linspace(100, 200, 100), np.linspace(200, 80, 100)])
    cd = {"BTC-EUR": frame_of(c), "ETH-EUR": frame_of(c)}
    w = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], sma=20, cheap=0.5, rich=3.0, floorWeight=0.0, slopeBars=5,
                             step=0.05)).to_numpy()
    assert np.isnan(w[:24]).all()
    assert (w[30:100] > 0.2).all() and (w[30:100] <= 0.5 + 1e-12).all()  # half a slot each at most
    assert (w[130:] == 0).all()  # falling average: cash
