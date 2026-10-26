import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.froth_dip import POOL, required_markets


def spec(markets=("BTC-EUR",), interval="1d", **params):
    fam = FAMILIES["froth_dip"]
    return normalize_spec({"family": "froth_dip", "markets": list(markets), "interval": interval,
                           "params": params}, fam)


def flat_bars(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_sampling():
    fam = FAMILIES["froth_dip"]
    assert not fam.bot_ready and fam.validate({"params": fam.default_params()}) is None
    assert set(required_markets(spec())) == set(POOL)
    rng = random.Random(4)
    cd = {m: synth(900, k + 1) for k, m in enumerate(POOL)}
    for _ in range(12):
        p = fam.sample(rng)
        if fam.validate({"params": p}) is not None:
            continue
        t = fam.targets(cd, spec(("BTC-EUR", "ETH-EUR"), **p)).to_numpy()
        if np.isnan(t).all():
            continue
        first = int(np.argmax(~np.isnan(t).any(axis=1)))
        assert not np.isnan(t[first:]).any() and set(np.unique(t[first:])) <= {0.0, 0.5}
    ex = fam.explain(spec(frothThr=0.1))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_panic_buy_below_core_when_whole_pool_is_oversold():
    down = [100 - i for i in range(30)]
    crash = down + [60, 55, 50, 52, 54, 56]
    cd = {m: flat_bars(crash) for m in POOL}
    p = dict(coreSma=10, rsiPeriod=5, rsiBelow=30, breadthMin=0.9, sellAbove=90, maxHold=0, frothThr=0.0)
    w = FAMILIES["froth_dip"].targets(cd, spec(**p))["BTC-EUR"].to_numpy()
    assert w[20] == 1.0  # all falling in step: RSI 0 -> market-wide panic, dip trade held
    p_off = dict(p, breadthMin=1.0, rsiBelow=15)
    cd2 = {m: flat_bars(crash if m == "BTC-EUR" else [100 + (i % 2) for i in range(len(crash))]) for m in POOL}
    w2 = FAMILIES["froth_dip"].targets(cd2, spec(**p_off))["BTC-EUR"].to_numpy()
    assert w2[20] == 0.0  # only BTC falls: no market-wide panic, below its SMA -> cash


def test_froth_exit_overrides_core():
    n = 60
    btc = [100 + 0.5 * i for i in range(n)]                       # steady uptrend: core on
    alts = [100 * (1.0 if i < 30 else 1.06 ** (i - 29)) for i in range(n)]  # alts pump from bar 30
    cd = {m: flat_bars(btc if m == "BTC-EUR" else alts) for m in POOL}
    p = dict(coreSma=10, rsiPeriod=5, rsiBelow=20, breadthMin=1.0, sellAbove=90, maxHold=3,
             frothLook=10, frothThr=0.2, frothBand=0.05)
    w = FAMILIES["froth_dip"].targets(cd, spec(**p))["BTC-EUR"].to_numpy()
    assert w[28] == 1.0   # core on, no froth yet
    assert w[-1] == 0.0   # old alts +6 %/bar vs BTC +0.5 %: froth exit
    w_off = FAMILIES["froth_dip"].targets(cd, spec(**dict(p, frothThr=0.0)))["BTC-EUR"].to_numpy()
    assert w_off[-1] == 1.0
