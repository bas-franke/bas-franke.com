import random

import numpy as np

from _engine_util import H4, T0, bars, synth
from stonks_lab.data import DAY
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.mtf_trend import slow_regime

FAM = FAMILIES["mtf_trend"]


def spec(**params):
    return normalize_spec({"family": "mtf_trend", "markets": ["BTC-EUR"], "interval": "4h", "params": params}, FAM)


def day_aligned(closes):
    start = (T0 // DAY + 1) * DAY  # 6 four-hour bars per day, aligned to midnight
    return bars([(x, x, x, x) for x in closes], start=start, step=H4)


def test_contract_and_lookahead():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    for _ in range(20):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    cd = {"BTC-EUR": synth(900, 1, drift=0.002)}
    for entry in ("pullback", "ema"):
        for tf in ("1d", "1W"):
            s = spec(entry=entry, slowTf=tf, slowSma=5)
            full = FAM.targets(cd, s).to_numpy()
            first = int(np.argmax(~np.isnan(full[:, 0])))
            assert not np.isnan(full[first:]).any() and (full[first:] >= 0).all()
            for k in (300, 650):
                trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
                np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
                d = cd["BTC-EUR"].copy()
                for col in ("open", "high", "low", "close"):
                    x = d[col].to_numpy().copy()
                    x[k + 1:] *= 0.3
                    d[col] = x
                np.testing.assert_array_equal(FAM.targets({"BTC-EUR": d}, s).to_numpy()[: k + 1], full[: k + 1])
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 2


def test_regime_uses_only_completed_days():
    # day 0..3 closes 10, 11, 12, then day 3 drops to 5; SMA(2) of daily closes
    closes = [10] * 6 + [11] * 6 + [12] * 6 + [5] * 6
    df = day_aligned(closes)
    ts = np.asarray(df.index, dtype=np.int64)
    reg = slow_regime(ts, df["close"].to_numpy(float), H4, "1d", 2)
    # day 0 bars: no completed day except at the last bar (day 0 done, SMA(2) NaN) -> False
    assert not reg[:6].any()
    # the last bar of day 1 completes day 1: 11 > mean(10, 11) -> on through day 2's bars
    assert not reg[6:11].any() and reg[11:17].all()
    # last bar of day 2: 12 > 11.5 on; last bar of day 3 completes it: 5 < 8.5 -> off
    assert reg[17] and reg[18:23].all() and not reg[23]


def test_pullback_only_in_uptrend_and_exit_on_regime():
    # uptrend days, then a dip inside an uptrend day buys; a crash turns the regime off and sells
    up = []
    for d in range(10):
        up += [100 + d * 10] * 6
    dip = [195, 185, 175, 180, 190, 200]  # day 10: RSI(2) dips, regime on (day 9 close 190 > SMA)
    crash = [100] * 12
    df = day_aligned(up + dip + crash)
    s = spec(entry="pullback", slowTf="1d", slowSma=3, rsiPeriod=2, buyBelow=30, sellAbove=95, exitOnRegime=True)
    w = FAM.targets({"BTC-EUR": df}, s)["BTC-EUR"].to_numpy()
    assert (w[2:60] == 0).all()          # flat rising prices: RSI never under 30
    assert w[61] == 1                    # 185 after 195: RSI(2) = 0 -> buy
    i_off = 60 + 6 + 5                   # last bar of day 11 completes a crash day -> regime off -> sell
    assert w[i_off] == 0 and (w[i_off:] == 0).all()
    # same dip with the regime off (falling days) never buys
    down = []
    for d in range(10):
        down += [300 - d * 10] * 6
    df2 = day_aligned(down + dip)
    w2 = FAM.targets({"BTC-EUR": df2}, s)["BTC-EUR"].to_numpy()
    assert (w2[2:] == 0).all()


def test_ema_entry_needs_regime():
    up = np.linspace(100, 300, 120)
    df = day_aligned(list(up))
    s = spec(entry="ema", slowTf="1d", slowSma=3, fastEma=2, slowEma=6)
    w = FAM.targets({"BTC-EUR": df}, s)["BTC-EUR"].to_numpy()
    assert (w[5:17] == 0).all() and w[17] == 1  # day 2 completes the 3rd day
    assert (w[30:] == 1).all()
    down = np.linspace(300, 100, 120)
    w2 = FAM.targets({"BTC-EUR": day_aligned(list(down))}, s)["BTC-EUR"].to_numpy()
    assert (w2[5:] == 0).all()
