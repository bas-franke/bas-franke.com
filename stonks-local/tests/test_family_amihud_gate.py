import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["amihud_gate"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), "look": 1, "rankLen": 3, "exitAt": 0.15, "reenter": 0.35, **params}
    return normalize_spec({"family": "amihud_gate", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def turnover_bars(turnover):
    """closes rise 1 % per candle (constant |return|), volume set so that volume x close = the given EUR turnover."""
    n = len(turnover)
    c = 100.0 * 1.01 ** np.arange(n)
    v = np.asarray(turnover, dtype=np.float64) / c
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": v},
                        index=pd.Index(T0 + H4 * np.arange(n, dtype=np.int64), name="ts"))


TURN = [1, 1, 1, 1, 2, 3, 4, 0.5, 0.5, 0.5]


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "exitAt": 0.3, "reenter": 0.2}})
    rng = random.Random(17)
    cd = {"BTC-EUR": synth(1500, 2), "ETH-EUR": synth(1500, 3)}
    for m in cd.values():
        m["volume"] = np.random.default_rng(5).lognormal(0, 0.5, len(m))
    for _ in range(10):
        p = FAM.sample(rng)
        df = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p))
        v = df.to_numpy()
        ok = np.isfinite(v).all(axis=1)
        assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
        assert (v[np.isfinite(v)] <= 0.5 + 1e-12).all()
    ex = FAM.explain(spec(coreLen=20))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3
    assert "BTC-EUR" in FAM.required_markets(spec(markets=("ETH-EUR",), scope="btc"))


def test_low_side_steps_aside_in_heavy_churn():
    w = FAM.targets({"BTC-EUR": turnover_bars(TURN)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all()
    # rising turnover at a constant move -> illiquidity at a trailing low -> out; thin market -> back in
    assert list(w[4:]) == [0, 0, 0, 1, 1, 1]


def test_high_side_steps_aside_in_thin_markets():
    w = FAM.targets({"BTC-EUR": turnover_bars(TURN)}, spec(side="high"))["BTC-EUR"].to_numpy()
    assert list(w[4:]) == [1, 1, 1, 0, 0, 1]


def test_btc_scope_and_core():
    eth = turnover_bars([1] * 10)
    btc = turnover_bars(TURN)
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(markets=("ETH-EUR",), scope="btc"))["ETH-EUR"].to_numpy()
    assert list(w[4:]) == [0, 0, 0, 1, 1, 1]
    # OR with a rising-price core keeps it invested through the churn
    w = FAM.targets({"BTC-EUR": btc}, spec(coreLen=2, combine="or"))["BTC-EUR"].to_numpy()
    assert list(w[4:]) == [1] * 6


def test_no_lookahead():
    """truncating the candles, or scrambling prices and volumes after bar k, never changes decisions up to k."""
    rng = np.random.default_rng(9)
    cd = {"BTC-EUR": synth(1400, 1), "ETH-EUR": synth(1400, 2, price=1500)}
    for df in cd.values():
        df["volume"] = rng.lognormal(0, 0.6, len(df))
    for params in ({"look": 10, "rankLen": 200}, {"look": 30, "rankLen": 300, "side": "high", "coreLen": 50},
                   {"look": 5, "rankLen": 100, "scope": "btc", "coreLen": 20, "combine": "or"}):
        s = spec(markets=("BTC-EUR", "ETH-EUR"), exitAt=0.2, reenter=0.5, **params)
        full = FAM.targets(cd, s).to_numpy()
        assert np.isfinite(full).any()
        for k in (450, 900):
            trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
            pert = {}
            for m, df in cd.items():
                d = df.copy()
                f = rng.uniform(0.3, 3.0, len(d) - k - 1)
                for col in ("open", "high", "low", "close", "volume"):
                    x = d[col].to_numpy().copy()
                    x[k + 1:] *= f if col != "volume" else rng.uniform(0.1, 10.0, len(d) - k - 1)
                    d[col] = x
                pert[m] = d
            np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])
