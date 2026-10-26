import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pit_rotation"]
MK = ["BTC-EUR", "ETH-EUR", "SOL-EUR"]


def spec(markets=MK, **params):
    p = dict(FAM.default_params())
    p.update(params)
    return normalize_spec({"family": "pit_rotation", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def frame_of(c, vol=None):
    c = np.asarray(c, dtype=np.float64)
    v = np.ones(len(c)) if vol is None else np.asarray(vol, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": v},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def cd3(n=900):
    return {"BTC-EUR": synth(n, 1), "ETH-EUR": synth(n, 2, price=1500), "SOL-EUR": synth(n, 3, price=100)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready and FAM.multi_market
    rng = random.Random(5)
    cd = cd3()
    checked = 0
    for _ in range(40):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        p["lookback"], p["volLook"] = min(p["lookback"], 200), min(p["volLook"], 200)
        p["regimeSma"] = min(int(p["regimeSma"] or 0), 300)
        checked += 1
        for mw in (1.0, 0.6):
            s = spec(**p)
            s["risk"]["maxWeight"] = mw
            t = FAM.targets(cd, s).to_numpy()
            first = int(np.argmax(~np.isnan(t).all(axis=1)))
            assert first <= FAM.warmup(p)
            v = t[first:]
            assert not np.isnan(v).any() and (v >= 0).all() and (v.sum(axis=1) <= mw + 1e-9).all()
    assert checked >= 10
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_no_lookahead():
    cd = cd3()
    for p in ({"lookback": 6, "hold": 1, "count": 1, "universe": 2, "volLook": 10, "regimeSma": 0, "absMom": False},
              {"lookback": 20, "hold": 3, "count": 2, "universe": 3, "volLook": 30, "regimeSma": 40, "absMom": True}):
        s = spec(**p)
        full = FAM.targets(cd, s).to_numpy()
        rng = np.random.default_rng(7)
        for k in (300, 650):
            trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
            pert = {}
            for m, df in cd.items():
                d = df.copy()
                f = rng.uniform(0.3, 3.0, len(d) - k - 1)
                for col in ("open", "high", "low", "close", "volume"):
                    x = d[col].to_numpy().copy()
                    x[k + 1:] *= f
                    d[col] = x
                pert[m] = d
            np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])


def test_universe_excludes_low_turnover_leader():
    n = 80
    t = np.arange(n, dtype=np.float64)
    a = 100 * 1.005 ** t                     # big, modest gains
    b = 100 * 1.001 ** t                     # big, small gains
    c = 100 * 1.03 ** t                      # the best performer, but tiny turnover
    cd = {"BTC-EUR": frame_of(a, np.full(n, 1000.0)), "ETH-EUR": frame_of(b, np.full(n, 800.0)),
          "SOL-EUR": frame_of(c, np.full(n, 1.0))}
    w = FAM.targets(cd, spec(lookback=5, hold=1, count=1, universe=2, volLook=10, regimeSma=0, absMom=False))
    assert np.isnan(w.iloc[:9].to_numpy()).all()
    assert (w["BTC-EUR"].iloc[10:] == 1.0).all() and (w["SOL-EUR"].iloc[10:] == 0).all()
    w3 = FAM.targets(cd, spec(lookback=5, hold=1, count=1, universe=3, volLook=10, regimeSma=0, absMom=False))
    assert (w3["SOL-EUR"].iloc[10:] == 1.0).all()


def test_late_listing_joins_after_vollook_and_regime_gate():
    n = 120
    t = np.arange(n, dtype=np.float64)
    a = np.where(t < 90, 100 * 1.004 ** t, 100 * 1.004 ** 89 * 0.97 ** (t - 89))   # BTC rises, then crashes
    b = 100 * 1.002 ** t
    late = 50 * 1.02 ** np.arange(60, dtype=np.float64)                             # listed at bar 60
    cd = {"BTC-EUR": frame_of(a, np.full(n, 10.0)), "ETH-EUR": frame_of(b, np.full(n, 10.0))}
    sol = frame_of(late, np.full(60, 10.0))
    sol.index = pd.Index(T0 + H4 * np.arange(60, 120, dtype=np.int64), name="ts")
    cd["SOL-EUR"] = sol
    w = FAM.targets(cd, spec(lookback=5, hold=1, count=1, universe=3, volLook=10, regimeSma=0, absMom=False))
    assert np.nan_to_num(w["SOL-EUR"].iloc[:69].to_numpy()).max() == 0   # not eligible before volLook bars
    assert w["SOL-EUR"].iloc[75] == 1.0
    g = FAM.targets(cd, spec(lookback=5, hold=1, count=1, universe=3, volLook=10, regimeSma=20, absMom=False))
    assert g.iloc[110].sum() == 0            # BTC below its SMA: all cash
    assert g.iloc[80].sum() == 1.0


def test_hold_blocks_and_absmom():
    n = 60
    t = np.arange(n, dtype=np.float64)
    falling = {"BTC-EUR": frame_of(100 * 0.99 ** t), "ETH-EUR": frame_of(100 * 0.98 ** t)}
    w = FAM.targets(falling, spec(markets=["BTC-EUR", "ETH-EUR"], lookback=5, hold=1, count=1, universe=2,
                                  volLook=5, regimeSma=0, absMom=True))
    assert (w.iloc[6:].to_numpy() == 0).all()
    w2 = FAM.targets(falling, spec(markets=["BTC-EUR", "ETH-EUR"], lookback=5, hold=1, count=1, universe=2,
                                   volLook=5, regimeSma=0, absMom=False))
    assert (w2["BTC-EUR"].iloc[6:] == 1.0).all()
