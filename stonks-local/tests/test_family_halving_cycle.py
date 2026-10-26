import random
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.halving_cycle import cycle_months

FAM = FAMILIES["halving_cycle"]
D1 = 86_400_000


def ms(d):
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "halving_cycle", "markets": list(markets), "interval": "1d", "params": params},
                          FAM)


def daily(closes, start="2019-01-01"):
    c = np.asarray(closes, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(ms(start) + D1 * np.arange(len(c), dtype=np.int64), name="ts"))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready and FAM.multi_market
    rng = random.Random(5)
    cd = {"BTC-EUR": synth(1500, 2, start=ms("2019-01-01"), step=D1),
          "ETH-EUR": synth(1500, 3, start=ms("2019-01-01"), step=D1)}
    for _ in range(25):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mk in (["BTC-EUR"], ["BTC-EUR", "ETH-EUR"]):
            s = spec(mk, **p)
            W = FAM.targets(cd, s).to_numpy()
            first = int(np.argmax(np.isfinite(W).all(axis=1)))
            assert np.isfinite(W[first:]).all() and (W[first:] >= 0).all()
            assert (W[first:].sum(axis=1) <= 1 + 1e-9).all()
            assert first <= FAM.warmup(p)
    ex = FAM.explain(spec(trendSma=50, offSma=200))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]
    assert FAM.validate({"params": {**FAM.default_params(), "holdFrom": 10, "holdTo": 11}}) is not None


def test_cycle_months():
    since, until = cycle_months(np.array([ms("2020-05-11"), ms("2021-05-11"), ms("2024-04-19")]))
    assert abs(since[0]) < 1e-9 and abs(since[1] - 12) < 0.1
    assert abs(until[2] - 1 / 30.4375) < 1e-6


def test_hold_window_calendar():
    # 2019-01-01 .. 2025-12-31, flat price: hold only between 0 and 18 months after a halving (no pre window)
    n = (ms("2026-01-01") - ms("2019-01-01")) // D1
    cd = {"BTC-EUR": daily(np.full(n, 100.0))}
    w = FAM.targets(cd, spec(holdFrom=0, holdTo=18, preMonths=0))["BTC-EUR"]
    at = lambda d: float(w.loc[ms(d)])
    assert at("2019-06-01") == 0.0 and at("2020-05-12") == 1.0 and at("2021-10-01") == 1.0
    assert at("2022-06-01") == 0.0 and at("2024-04-21") == 1.0 and at("2025-12-01") == 0.0
    # with a 12-month pre window it also holds in the year before the 2024 halving
    w2 = FAM.targets(cd, spec(holdFrom=0, holdTo=18, preMonths=12))["BTC-EUR"]
    assert float(w2.loc[ms("2023-06-01")]) == 1.0 and float(w2.loc[ms("2022-06-01")]) == 0.0


def test_trend_gates():
    # falling price inside the window: trendSma blocks it; rising price outside: offSma holds it
    n = (ms("2023-01-01") - ms("2020-01-01")) // D1
    c = np.concatenate([np.linspace(200, 100, n // 2), np.linspace(100, 300, n - n // 2)])
    cd = {"BTC-EUR": daily(c, start="2020-01-01")}
    w = FAM.targets(cd, spec(holdFrom=0, holdTo=12, preMonths=0, trendSma=20, offSma=20))["BTC-EUR"]
    assert float(w.loc[ms("2020-12-01")]) == 0.0   # in window, below falling SMA
    assert float(w.loc[ms("2022-06-01")]) == 1.0   # outside window, above rising SMA
    w0 = FAM.targets(cd, spec(holdFrom=0, holdTo=12, preMonths=0))["BTC-EUR"]
    assert float(w0.loc[ms("2020-12-01")]) == 1.0 and float(w0.loc[ms("2022-06-01")]) == 0.0
