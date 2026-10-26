import random

import numpy as np
import pandas as pd

from _engine_util import T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["donchian_vol"]
D1 = 86_400_000


def spec(**params):
    return normalize_spec({"family": "donchian_vol", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def frame_from_close(c, wiggle=0.002):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return pd.DataFrame({"open": o, "high": np.maximum(o, c) * (1 + wiggle), "low": np.minimum(o, c) * (1 - wiggle),
                         "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + D1 * np.arange(len(c), dtype=np.int64), name="ts"))


def range_then_trend_then_crash(calm=0.003):
    """60 bars ranging around 100 (alternating +-calm), 60 bars rising 1 %/bar, then 40 bars falling 3 %/bar."""
    r = np.concatenate([np.where(np.arange(60) % 2 == 0, calm, -calm), np.full(60, 0.01), np.full(40, -0.03)])
    return frame_from_close(100 * np.exp(np.cumsum(r)))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(700, 2)}
    for _ in range(25):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mw in (1.0, 0.5):
            s = spec(**p)
            s["risk"]["maxWeight"] = mw
            v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
            assert np.isnan(v[: FAM.warmup(p)]).all()
            rest = v[FAM.warmup(p):]
            assert not np.isnan(rest).any() and (rest >= 0).all() and (rest <= mw + 1e-12).all()
    ex = FAM.explain(spec(trendSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_buys_breakout_and_exits_on_crash():
    cd = {"BTC-EUR": range_then_trend_then_crash()}
    w = FAM.targets(cd, spec(entry=20, exit=10, atrMult=0, atrLen=5, volLookback=20, targetVol=3.0))["BTC-EUR"]
    w = w.to_numpy()
    assert (w[25:60] == 0).all()           # ranging: no breakout
    assert (w[62:120] == 1.0).all()        # rising: in at full size (calm market, target vol high)
    assert (w[125:] == 0).all()            # crash: the 10-bar low exit fired


def test_size_follows_volatility_and_is_fixed_in_trade():
    calm = FAM.targets({"BTC-EUR": range_then_trend_then_crash(0.003)},
                       spec(entry=20, exit=10, atrMult=0, atrLen=5, volLookback=40, targetVol=0.3))["BTC-EUR"]
    wild = FAM.targets({"BTC-EUR": range_then_trend_then_crash(0.03)},
                       spec(entry=20, exit=10, atrMult=0, atrLen=5, volLookback=40, targetVol=0.3))["BTC-EUR"]
    c, wl = calm.to_numpy()[70:115], wild.to_numpy()[70:115]
    assert (c > 0).all() and (wl > 0).all()
    assert len(set(c)) == 1 and len(set(wl)) == 1     # size fixed for the whole trade
    assert wl[0] < c[0]
    assert abs(wl[0] / 0.05 - round(wl[0] / 0.05)) < 1e-9


def test_chandelier_exits_before_channel():
    cd = {"BTC-EUR": range_then_trend_then_crash()}
    base = dict(entry=20, exit=100, atrLen=5, volLookback=20, targetVol=3.0)
    slow = FAM.targets(cd, spec(atrMult=0, **base))["BTC-EUR"].to_numpy()
    fast = FAM.targets(cd, spec(atrMult=2.0, **base))["BTC-EUR"].to_numpy()
    first_out = lambda w: 62 + int(np.argmax(w[62:] == 0))
    assert first_out(fast) < first_out(slow) and first_out(fast) <= 123


def test_trend_filter_blocks_entries():
    n = 400
    c = 100 * np.exp(np.cumsum(np.concatenate([np.full(200, -0.004), np.where(np.arange(200) % 10 == 0, 0.03,
                                                                                -0.004)])))
    cd = {"BTC-EUR": frame_from_close(c)}
    on = FAM.targets(cd, spec(entry=5, exit=3, atrMult=0, atrLen=5, volLookback=20, targetVol=3.0,
                              trendSma=300))["BTC-EUR"].to_numpy()
    off = FAM.targets(cd, spec(entry=5, exit=3, atrMult=0, atrLen=5, volLookback=20, targetVol=3.0,
                               trendSma=0))["BTC-EUR"].to_numpy()
    assert (off[300:] > 0).any() and (on[300:] == 0).all()


def test_no_lookahead():
    cd = {"BTC-EUR": synth(900, 3)}
    for p in (dict(entry=30, exit=10, atrMult=3.0, trendSma=100), dict(entry=8, exit=4, atrMult=0, volLookback=15)):
        s = spec(**p)
        full = FAM.targets(cd, s).to_numpy()
        rng = np.random.default_rng(7)
        for k in (300, 650):
            t = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}, s).to_numpy()
            np.testing.assert_array_equal(t, full[: k + 1])
            d = cd["BTC-EUR"].copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            np.testing.assert_array_equal(FAM.targets({"BTC-EUR": d}, s).to_numpy()[: k + 1], full[: k + 1])
