"""Cross-check the ladder indicators (stonks_lab/families/_ta.py) against TAAPI on the same candles.

    .venv/Scripts/python tools/check_ladder_indicators.py [--market BTC-EUR] [--interval 1h]

Our readings are normalized (-1..+1) and TAAPI's are raw, so the check is the rank (Spearman) correlation over the
last 250 bars; 1.000 means the same indicator up to a monotone rescale. Last run (BTC-EUR 1h, 2026-10-27): 20 of 22
>= 0.98; stoch 0.71 (TAAPI's /bulk-candles ignores `period` for stoch and uses kPeriod 5), trix 0.92 (we divide by
its rolling std). tsi and efi are not on TAAPI; cmo, ultosc, ppo, psar, vwap and donchianchannels return no series
on /bulk-candles with these params. Uses 3 TAAPI requests.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stonks_lab import data, taapi  # noqa: E402
from stonks_lab.families import _ta  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--market", default="BTC-EUR")
ap.add_argument("--interval", default="1h")
a = ap.parse_args()
df = data.load_candles(a.market, a.interval).iloc[-500:]
c = df["close"]
NAMES = ["rsi", "stochrsi", "stoch", "willr", "cci", "mfi", "bbands", "fisher", "roc", "macd", "trix", "ao", "aroon",
         "dmi", "vortex", "supertrend", "ichimoku", "kama", "hma", "cmf", "keltnerchannels", "dpo"]
T = {}
for i in range(0, len(NAMES), 10):
    T.update(taapi.bulk_candles(df, [{"id": n, "indicator": n, "period": 14, "results": 300} for n in NAMES[i:i + 10]]))
def s(name, key):
    r = T[name]; return pd.Series(r[key], index=np.array(r['timestamp'], dtype=np.int64) * 1000)
def ours(name, n): return pd.Series(_ta.compute(name, df, n), index=df.index)
cl = lambda x: c.reindex(x.index)
pairs = {
 "rsi": (14, s("rsi","value")), "stochrsi": (14, s("stochrsi","valueFastK")), "stoch": (14, s("stoch","valueK")),
 "willr": (14, s("willr","value")), "cci": (14, s("cci","value")), "mfi": (14, s("mfi","value")),
 "bbands": (14, (cl(s("bbands","valueLowerBand")) - s("bbands","valueLowerBand")) / (s("bbands","valueUpperBand") - s("bbands","valueLowerBand"))),
 "fisher": (14, s("fisher","fisher")), "roc": (14, s("roc","value")), "macd": (12, s("macd","valueMACDHist")),
 "trix": (14, s("trix","value")), "ao": (34, s("ao","value")),
 "aroon": (14, s("aroon","valueAroonUp") - s("aroon","valueAroonDown")), "dmi": (14, s("dmi","plusdi") - s("dmi","minusdi")),
 "vortex": (14, s("vortex","plus") - s("vortex","minus")),
 "supertrend": (14, pd.Series(np.where(np.array(T["supertrend"]["valueAdvice"]) == "long", 1.0, -1.0), index=s("supertrend","value").index)),
 "ichimoku": (9, s("ichimoku","conversion") - s("ichimoku","base")), "kama": (14, cl(s("kama","value")) - s("kama","value")),
 "hma": (14, s("hma","value").diff()), "cmf": (14, s("cmf","value")),
 "keltner": (14, (cl(s("keltnerchannels","middle")) - s("keltnerchannels","middle")) / (s("keltnerchannels","upper") - s("keltnerchannels","lower"))),
 "dpo": (14, s("dpo","value")),
}
for k, (n, t) in pairs.items():
    o = ours(k, n)
    j = pd.concat([o, t], axis=1).dropna().iloc[-250:]
    sp = j.rank().corr().iloc[0, 1] if len(j) > 20 else float('nan')
    print(f"{k:11s} n={n:3d} rows={len(j):3d} spearman={sp:+.3f}")
