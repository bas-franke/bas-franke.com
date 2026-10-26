"""Cross-check our indicator definitions (stonks/SPEC.md §3) against TAAPI's /bulk-candles on the same candles.

    python tools/check_indicators.py [--market BTC-EUR] [--interval 1h] [--bars 500]

Reference implementations here are deliberately simple numpy loops following SPEC:
EMA seeded with the SMA of the first n closes, alpha = 2/(n+1); RSI with Wilder's smoothing;
Bollinger = SMA +- k * population std; MACD = EMA(fast) - EMA(slow), signal = EMA(signal) of MACD.
Alternative definitions are computed too, so a mismatch shows *which* convention TAAPI uses.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stonks_lab import data, taapi  # noqa: E402

NAN = float("nan")


def sma(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), NAN)
    for i in range(n - 1, len(x)):
        out[i] = x[i - n + 1:i + 1].mean()
    return out


def ema(x: np.ndarray, n: int, seed: str = "sma") -> np.ndarray:
    """EMA over ``x`` (leading NaNs are skipped). seed='sma': first value = SMA of the first n values (SPEC);
    seed='first': first value = the first input, output from the start."""
    out = np.full(len(x), NAN)
    valid = np.nonzero(~np.isnan(x))[0]
    if len(valid) < n:
        return out
    s = valid[0]
    a = 2.0 / (n + 1)
    if seed == "sma":
        i0 = s + n - 1
        out[i0] = x[s:i0 + 1].mean()
    else:
        i0 = s
        out[i0] = x[s]
    for i in range(i0 + 1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def rsi(close: np.ndarray, n: int = 14, smoothing: str = "wilder") -> np.ndarray:
    """smoothing='wilder' (SPEC): seed = mean of the first n gains/losses, then (prev*(n-1)+x)/n.
    smoothing='sma': plain n-bar mean of gains/losses (Cutler)."""
    d = np.diff(close)
    g, l = np.clip(d, 0, None), np.clip(-d, 0, None)
    out = np.full(len(close), NAN)
    if len(d) < n:
        return out
    if smoothing == "wilder":
        ag, al = g[:n].mean(), l[:n].mean()
        for i in range(n, len(close)):
            if i > n:
                ag = (ag * (n - 1) + g[i - 1]) / n
                al = (al * (n - 1) + l[i - 1]) / n
            out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    else:
        for i in range(n, len(close)):
            ag, al = g[i - n:i].mean(), l[i - n:i].mean()
            out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def macd(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9, seed: str = "sma"):
    line = ema(close, fast, seed) - ema(close, slow, seed)
    sig = ema(line, signal, seed)
    return line, sig, line - sig


def macd_talib(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9):
    """TA-Lib alignment: both EMAs start at bar slow-1; the fast EMA is seeded with the SMA of the ``fast``
    closes ending there (not of the first ``fast`` closes). Signal = SMA-seeded EMA of the MACD line."""
    slow_e = ema(close, slow)
    fast_e = np.full(len(close), NAN)
    i0 = slow - 1
    a = 2.0 / (fast + 1)
    fast_e[i0] = close[i0 - fast + 1:i0 + 1].mean()
    for i in range(i0 + 1, len(close)):
        fast_e[i] = a * close[i] + (1 - a) * fast_e[i - 1]
    line = fast_e - slow_e
    sig = ema(line, signal)
    return line, sig, line - sig


def bollinger(close: np.ndarray, n: int = 20, k: float = 2.0, ddof: int = 0):
    mid = sma(close, n)
    sd = np.full(len(close), NAN)
    for i in range(n - 1, len(close)):
        sd[i] = close[i - n + 1:i + 1].std(ddof=ddof)
    return mid + k * sd, mid, mid - k * sd


def compare(name: str, ours: np.ndarray, ts: np.ndarray, theirs: pd.Series, tail: int) -> tuple[float, float, int]:
    """Max |diff| and max relative diff over the last ``tail`` bars that both sides have."""
    s = pd.Series(ours, index=ts).reindex(theirs.index)
    both = pd.concat([s, theirs], axis=1).dropna().iloc[-tail:]
    diff = (both.iloc[:, 0] - both.iloc[:, 1]).abs()
    rel = diff / both.iloc[:, 1].abs().clip(lower=1e-12)
    return float(diff.max()), float(rel.max()), len(both)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", default="BTC-EUR")
    ap.add_argument("--interval", default="1h")
    ap.add_argument("--bars", type=int, default=500, help="candles sent to TAAPI (max 500)")
    ap.add_argument("--tail", type=int, default=0, help="compare only the last N bars (0 = all that overlap)")
    args = ap.parse_args()

    df = data.load_candles(args.market, args.interval).iloc[-args.bars:]
    close = df["close"].to_numpy()
    ts = df.index.to_numpy()
    res = args.bars
    inds = [
        {"id": "rsi", "indicator": "rsi", "period": 14, "results": res},
        {"id": "ema", "indicator": "ema", "period": 20, "results": res},
        {"id": "sma", "indicator": "sma", "period": 20, "results": res},
        {"id": "macd", "indicator": "macd", "optInFastPeriod": 12, "optInSlowPeriod": 26,
         "optInSignalPeriod": 9, "results": res},
        {"id": "bb", "indicator": "bbands", "period": 20, "stddev": 2, "results": res},
    ]
    out = taapi.bulk_candles(df, inds)
    t = {k: taapi.to_frame(v) for k, v in out.items()}
    tail = args.tail or res
    print(f"{args.market} {args.interval}: {len(df)} candles {data._iso(int(ts[0]))} .. {data._iso(int(ts[-1]))}")
    print(f"TAAPI rows: " + ", ".join(f"{k}={len(v)}" for k, v in t.items()))

    m_spec = macd(close)
    m_first = macd(close, seed="first")
    m_talib = macd_talib(close)
    bb_pop, bb_samp = bollinger(close), bollinger(close, ddof=1)
    checks = [
        ("SMA(20)", "spec", sma(close, 20), "sma", "value"),
        ("EMA(20)", "SMA seed (SPEC)", ema(close, 20), "ema", "value"),
        ("EMA(20)", "first-close seed", ema(close, 20, "first"), "ema", "value"),
        ("RSI(14)", "Wilder (SPEC)", rsi(close), "rsi", "value"),
        ("RSI(14)", "SMA/Cutler", rsi(close, smoothing="sma"), "rsi", "value"),
        ("MACD line", "SMA seed (SPEC)", m_spec[0], "macd", "valueMACD"),
        ("MACD signal", "SMA seed (SPEC)", m_spec[1], "macd", "valueMACDSignal"),
        ("MACD hist", "SMA seed (SPEC)", m_spec[2], "macd", "valueMACDHist"),
        ("MACD line", "first-close seed", m_first[0], "macd", "valueMACD"),
        ("MACD signal", "first-close seed", m_first[1], "macd", "valueMACDSignal"),
        ("MACD line", "TA-Lib aligned", m_talib[0], "macd", "valueMACD"),
        ("MACD signal", "TA-Lib aligned", m_talib[1], "macd", "valueMACDSignal"),
        ("MACD hist", "TA-Lib aligned", m_talib[2], "macd", "valueMACDHist"),
        ("BB upper", "population std (SPEC)", bb_pop[0], "bb", "valueUpperBand"),
        ("BB middle", "SMA (SPEC)", bb_pop[1], "bb", "valueMiddleBand"),
        ("BB lower", "population std (SPEC)", bb_pop[2], "bb", "valueLowerBand"),
        ("BB upper", "sample std", bb_samp[0], "bb", "valueUpperBand"),
    ]
    print(f"\n{'indicator':<12} {'our definition':<24} {'max |diff|':>14} {'max rel':>10} {'bars':>6}")
    for label, variant, ours, key, col in checks:
        if col not in t[key]:
            print(f"{label:<12} {variant:<24} TAAPI returned no {col}: {list(t[key].columns)}")
            continue
        d, r, n = compare(label, ours, ts, t[key][col].astype(float), tail)
        print(f"{label:<12} {variant:<24} {d:>14.6g} {r:>10.2e} {n:>6}")


if __name__ == "__main__":
    main()
