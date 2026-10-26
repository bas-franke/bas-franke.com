import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["rotation_gate"]
ROT = FAMILIES["rotation_momentum"]
MK = ["BTC-EUR", "ETH-EUR", "SOL-EUR"]


def spec(markets=MK, fam="rotation_gate", **params):
    return normalize_spec({"family": fam, "markets": list(markets), "interval": "1d", "params": params},
                          FAMILIES[fam])


def frame_of(c):
    c = np.asarray(c, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def cd3(n=900):
    return {"BTC-EUR": synth(n, 1), "ETH-EUR": synth(n, 2, price=1500), "SOL-EUR": synth(n, 3, price=100)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready and FAM.multi_market
    assert FAM.validate({"params": {**FAM.default_params(), "gate": "breadth", "breadthMin": 0.2,
                                    "band": 0.2}}) is not None
    rng = random.Random(4)
    cd = cd3()
    for _ in range(30):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mw in (1.0, 0.6):
            s = spec(**p)
            s["risk"]["maxWeight"] = mw
            t = FAM.targets(cd, s).to_numpy()
            first = int(np.argmax(~np.isnan(t).all(axis=1)))
            assert first <= FAM.warmup(p) + 1, (p, first)
            v = t[first:]
            assert not np.isnan(v).any() and (v >= 0).all() and (v.sum(axis=1) <= mw + 1e-9).all()
    for g in ("none", "btc_sma", "index_sma", "breadth", "btc_mom"):
        ex = FAM.explain(spec(gate=g, band=0.02))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_btc_sma_band0_equals_rotation_momentum():
    cd = cd3()
    for lb, top, L in ((20, 2, 50), (7, 1, 120)):
        a = FAM.targets(cd, spec(lookback=lb, top=top, gate="btc_sma", gateLen=L, band=0.0)).to_numpy()
        b = ROT.targets(cd, spec(fam="rotation_momentum", lookback=lb, top=top, regimeSma=L)).to_numpy()
        np.testing.assert_array_equal(a, b)
    a = FAM.targets(cd, spec(lookback=15, top=2, gate="none")).to_numpy()
    b = ROT.targets(cd, spec(fam="rotation_momentum", lookback=15, top=2, regimeSma=0)).to_numpy()
    np.testing.assert_array_equal(a, b)


def test_no_lookahead():
    cd = cd3()
    for p in ({"lookback": 20, "top": 2, "gate": "index_sma", "gateLen": 40, "band": 0.03, "breadthMin": 0.5},
              {"lookback": 10, "top": 1, "gate": "breadth", "gateLen": 30, "band": 0.1, "breadthMin": 0.6},
              {"lookback": 15, "top": 2, "gate": "btc_mom", "gateLen": 25, "band": 0.02, "breadthMin": 0.5},
              {"lookback": 15, "top": 2, "gate": "btc_sma", "gateLen": 60, "band": 0.05, "breadthMin": 0.5}):
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
                for col in ("open", "high", "low", "close"):
                    x = d[col].to_numpy().copy()
                    x[k + 1:] *= f
                    d[col] = x
                pert[m] = d
            np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])


def test_gates_go_to_cash_in_a_crash_and_hold_the_leader_in_a_rally():
    n = 200
    t = np.arange(n, dtype=np.float64)
    up = t < 100
    a = np.where(up, 100 * 1.02 ** t, 100 * 1.02 ** 99 * 0.98 ** (t - 99))   # leader, then crashes
    b = np.where(up, 100 * 1.01 ** t, 100 * 1.01 ** 99 * 0.985 ** (t - 99))
    c = np.where(up, 100 * 1.005 ** t, 100 * 1.005 ** 99 * 0.99 ** (t - 99))
    cd = {"BTC-EUR": frame_of(a), "ETH-EUR": frame_of(b), "SOL-EUR": frame_of(c)}
    for g in ("btc_sma", "index_sma", "breadth", "btc_mom"):
        w = FAM.targets(cd, spec(lookback=10, top=1, gate=g, gateLen=20, band=0.0, breadthMin=0.5))
        assert (w["BTC-EUR"].iloc[30:100] == 1.0).all(), g          # strongest riser held during the rally
        assert (w.iloc[140:].to_numpy() == 0).all(), g               # gate (and negative returns) -> cash


def test_band_delays_switching():
    # BTC oscillates gently around a flat SMA: with a wide band the gate never switches on; ETH keeps rising.
    n = 300
    t = np.arange(n, dtype=np.float64)
    btc = 100 * (1 + 0.01 * np.sin(t / 3))
    eth = 100 * 1.01 ** t
    sol = 100 * 1.005 ** t
    cd = {"BTC-EUR": frame_of(btc), "ETH-EUR": frame_of(eth), "SOL-EUR": frame_of(sol)}
    plain = FAM.targets(cd, spec(lookback=10, top=1, gate="btc_sma", gateLen=30, band=0.0)).iloc[60:]
    wide = FAM.targets(cd, spec(lookback=10, top=1, gate="btc_sma", gateLen=30, band=0.05)).iloc[60:]
    assert plain["ETH-EUR"].sum() > 0 and wide.to_numpy().sum() == 0
    # breadth: ETH and SOL above their SMAs (2/3) -> on at breadthMin 0.6
    br = FAM.targets(cd, spec(lookback=10, top=1, gate="breadth", gateLen=30, breadthMin=0.6, band=0.0)).iloc[60:]
    assert (br["ETH-EUR"] == 1.0).all()
