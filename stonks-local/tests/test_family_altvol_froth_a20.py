import random

import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["altvol_froth_a20"]
POOL = ["XRP-EUR", "ADA-EUR", "LTC-EUR"]
D = 86_400_000


def spec(markets=("BTC-EUR",), **params):
    p = {"volLen": 5, "rankLen": 20, "qOut": 0.9, "qIn": 0.5, "mode": "alone", "frothLook": 5, "frothThr": 0.1,
         **params}
    return normalize_spec({"family": "altvol_froth_a20", "markets": list(markets), "interval": "1d",
                           "params": p}, FAM)


def series(rets, price=100.0):
    c = price * np.exp(np.cumsum(rets))
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(1_600_000_000_000 + D * np.arange(len(c), dtype=np.int64), name="ts"))


def market(alt_amp, alt_drift=0.0, n=80, wild_from=60):
    """BTC wiggles +-1 %; alts wiggle +-1 % until wild_from, then +-alt_amp (with optional drift)."""
    sgn = np.where(np.arange(n) % 2 == 0, 1.0, -1.0)
    btc = 0.01 * sgn
    cd = {"BTC-EUR": series(btc), "ETH-EUR": series(btc, 50.0)}
    for j, m in enumerate(POOL):
        a = 0.01 * sgn * (1 + 0.1 * j)
        a[wild_from:] = alt_amp * sgn[wild_from:] + alt_drift
        cd[m] = series(a, 10.0 + j)
    return cd


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "qIn": 0.9, "qOut": 0.8}})
    rng = random.Random(4)
    cd = {m: synth(900, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    for _ in range(8):
        p = FAM.sample(rng)
        p["rankLen"] = min(p["rankLen"], 300)
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        assert rows.any()
        first = int(np.argmax(rows))
        assert not np.isnan(v[first:]).any()
        assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    assert set(FAM.markets_needed(spec(["ETH-EUR"]))) >= {"ETH-EUR", "BTC-EUR", "XRP-EUR", "MIOTA-EUR"}
    assert FAM.explain(spec(mode="and"))["summary"]


def test_sells_when_alts_turn_wild_and_holds_otherwise():
    calm = FAM.targets(market(0.01), spec())["BTC-EUR"].to_numpy()
    ok = np.isfinite(calm)
    assert ok.any() and (calm[ok] == 1).all()
    wild = FAM.targets(market(0.05), spec())["BTC-EUR"].to_numpy()
    assert np.isnan(wild[:24]).all()
    assert (wild[30:60] == 1).all()
    assert wild[61] == 0 or wild[62] == 0                # vol ratio jumps to a 20-bar high: out


def test_and_mode_needs_an_alt_lead():
    no_lead = FAM.targets(market(0.05), spec(mode="and"))["BTC-EUR"].to_numpy()
    ok = np.isfinite(no_lead)
    assert (no_lead[ok] == 1).all()                      # wild but not ahead of BTC: stay in
    lead = FAM.targets(market(0.05, alt_drift=0.04), spec(mode="and"))["BTC-EUR"].to_numpy()
    assert lead[64] == 0                                 # wild and +4 %/day ahead of BTC: out
    either = FAM.targets(market(0.01, alt_drift=0.04), spec(mode="or"))["BTC-EUR"].to_numpy()
    assert either[66] == 0                               # 'or': the lead alone is enough
