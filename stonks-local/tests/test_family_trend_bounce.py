import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.trend_bounce import daily_core

DAY = 86_400_000
H6 = DAY // 4
T0 = 1_600_041_600_000 - (1_600_041_600_000 % DAY)  # a UTC midnight


def spec(interval="6h", **params):
    fam = FAMILIES["trend_bounce"]
    return normalize_spec({"family": "trend_bounce", "markets": ["BTC-EUR"], "interval": interval,
                           "params": params}, fam)


def w_of(c, **p):
    cd = {"BTC-EUR": bars([(x, x, x, x) for x in c], start=T0, step=H6)}
    return FAMILIES["trend_bounce"].targets(cd, spec(**p))["BTC-EUR"].to_numpy()


def test_contract_and_sampling():
    fam = FAMILIES["trend_bounce"]
    assert not fam.bot_ready and fam.validate({"params": fam.default_params()}) is None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(6000, 2, start=T0, step=H6 // 24)}  # 15m bars
    for _ in range(12):
        p = fam.sample(rng)
        assert fam.validate({"params": p}) is None, p
        t = fam.targets(cd, spec("15m", **p)).to_numpy()[:, 0]
        if np.isnan(t).all():
            continue
        first = int(np.argmax(~np.isnan(t)))
        assert not np.isnan(t[first:]).any() and t[first:].min() >= 0 and t[first:].max() <= 1.0
    ex = fam.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_daily_core_uses_only_completed_days():
    # 4 bars per day; daily closes 10, 10, 10, 20 -> with days=3 the SMA of days 1-3 is 10, day 3 close 20 > SMA
    closes = [10] * 8 + [10, 10, 10, 10] + [10, 10, 10, 20] + [5, 5, 5, 5]
    ts = T0 + H6 * np.arange(len(closes), dtype=np.int64)
    core = daily_core(ts, np.asarray(closes, dtype=float), 3)
    assert np.isnan(core[:12]).all()            # day 2 completes only at its last bar; usable from day 3 on
    assert (core[12:16] == 0.0).all()           # days 0-2 all 10: not above the SMA
    assert (core[16:20] == 1.0).all()           # day 3 closed at 20 > SMA(10,10,20)=13.3 -> on for day 4,
    # although day 4's own (unfinished) closes are 5: no look-ahead into the running day


def test_core_holds_uptrend_and_drops_in_downtrend():
    up = [100 + i for i in range(40)]           # 10 days rising
    down = [139 - 3 * i for i in range(40)]     # 10 days falling
    w = w_of(up + down, coreDays=3, coreWeight=1.0, lookback=6, threshold=4.9, volBars=12, volMinPct=15.0,
             exitZ=0.0, maxHoldBars=4)
    assert w[30] == 1.0
    assert w[-1] == 0.0


def test_bounce_buys_panic_dip_in_core_cash_and_sells_after_max_hold():
    calm = [100, 101] * 20                      # 10 days flat: core off (close not above its own SMA)
    w = w_of(calm + [70, 72, 74, 76, 78, 80, 82, 84], coreDays=3, coreWeight=1.0, lookback=8, threshold=2.0,
             volBars=8, volMinPct=1.0, exitZ=1.5, maxHoldBars=3)
    i = len(calm)
    assert w[i - 1] == 0.0
    assert w[i] == 1.0                          # bought at the panic bar's close
    assert w[i + 3] == 0.0                      # sold after maxHoldBars (or the rebound)


def test_core_weight_leaves_room_for_bounce():
    up = [100 + i for i in range(40)]
    w = w_of(up + [60], coreDays=3, coreWeight=0.5, lookback=8, threshold=2.0, volBars=8, volMinPct=0.5,
             exitZ=1.5, maxHoldBars=3)
    assert w[30] == 0.5
    assert w[-1] == 1.0
