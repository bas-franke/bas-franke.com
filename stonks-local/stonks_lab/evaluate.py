"""Out-of-sample evaluation of one strategy spec: walk-forward folds plus an untouched holdout.

Splits (by time, on the spec's own candles):

    |-- warm-up --|-- seg 1 --|-- seg 2 --|-- seg 3 --| ... |-- seg K+2 --|========= holdout =========|
                  T0                                                      H                          end
                  (first bar with a decision)                             (last HOLDOUT_DAYS = 365 days)

- Holdout = the last 365 days of data (or the last 25 % when there is less than two years). It is reported but
  NEVER used for the score, so the 20 search agents cannot overfit it.
- The history between T0 and H is cut into K+2 equal time segments (K = 6 folds). Fold k (1..K) tests segment k+2
  from a fresh EUR 1000 start; its "train" part is everything from T0 up to that segment (expanding window, taken from
  one continuous in-sample run). Params are not fitted here: "train" is the in-sample record the search agents saw
  implicitly; the score only looks at the test segments.
- Indicators are computed once over the whole history; decisions at bar t only use bars <= t (tested), so starting a
  fold in the middle of the data just means the indicators are already warm. Anchored families (dca_dip) restart their
  schedule at every window start.
- Buy-and-hold for each window: the same markets, equal split, one taker market buy (+5 bps) at the window's first
  open, same fees.

Score (higher is better, roughly "percentage points"):

    x_f    = ln(final_f / 1000) - ln(buyHoldFinal_f / 1000)       log excess return over buy-and-hold, test fold f
    dd_f   = max drawdown of the strategy in test fold f (fraction, 0.3 = 30 %)
    N      = number of fills summed over all test folds
    score  = 100 * ( median_f(x_f) - 0.5 * median_f(dd_f) ) - 10 * max(0, 1 - N / 20)

i.e. the typical out-of-sample excess (log) return over buy-and-hold, minus half the typical drawdown, minus up to
10 points when there are fewer than 20 trades in all test folds together (too few decisions to trust). Medians make
one lucky fold count for little. Fewer than 3 usable folds gives score None.
"""
from __future__ import annotations

import hashlib
import json
import math
import time
from functools import lru_cache

import numpy as np

from . import backtest as bt
from . import metrics as mt
from .families import get_family, normalize_spec

HOLDOUT_DAYS = 365
N_FOLDS = 6
MIN_FOLDS = 3
MIN_FOLD_BARS = 20
DD_WEIGHT = 0.5
MIN_TRADES = 20
TRADE_PENALTY = 10.0
DAY_MS = 86_400_000
START_EUR = 1000.0


# --------------------------------------------------------------------------------------------- identity

def _canon(v):
    if isinstance(v, float) and math.isfinite(v) and v.is_integer():
        return int(v)
    if isinstance(v, dict):
        return {k: _canon(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_canon(x) for x in v]
    return v


def canonical_spec(spec: dict) -> dict:
    """The parts of a spec that change its behaviour, defaults filled in, numbers normalized (2.0 -> 2)."""
    fam = get_family(spec["family"])
    s = normalize_spec(spec, fam)
    return _canon({"family": s["family"], "familyVersion": int(s.get("familyVersion") or fam.version),
                   "markets": list(s["markets"]), "interval": s["interval"], "params": s["params"],
                   "risk": s["risk"], "execution": s["execution"]})


def spec_hash(spec: dict) -> str:
    """sha256 hex of the canonical JSON (sorted keys, no spaces) of family, familyVersion, markets, interval,
    params, risk and execution."""
    blob = json.dumps(canonical_spec(spec), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def data_fingerprint(candles: dict, markets: list[str], interval: str, holdout_start: int | None) -> str:
    parts = {"interval": interval, "holdoutStart": holdout_start, "markets": {}}
    for m in sorted(markets):
        df = candles[m]
        idx = np.asarray(df.index, dtype=np.int64)
        parts["markets"][m] = [int(idx[0]) if len(idx) else None, int(idx[-1]) if len(idx) else None, len(idx),
                               round(float(df["close"].sum()), 6)]
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:16]


# --------------------------------------------------------------------------------------------- helpers

def _load(markets, interval, start=None, end=None):
    from . import data
    return data.load_many(markets, interval, start, end)


def _targets_for(fam, spec, candles, full_targets, start):
    if fam.anchored:
        return fam.targets(candles, spec, start_time=bt.anchor_time(candles, spec, start))
    return full_targets


def _run_window(fam, spec, candles, full_targets, index, a, b, fees, start_eur):
    bh = bt.buy_and_hold(spec["markets"], candles, start_eur, fees, start=a, end=b, interval=spec["interval"],
                         index=index)
    tg = _targets_for(fam, spec, candles, full_targets, a)
    res = bt.run(spec, candles, start_eur, fees, start=a, end=b, targets=tg, bh_equity=bh.equity)
    return res, bh


def _slice_metrics(res: bt.BacktestResult, bh: bt.BacktestResult, end_ts: int, interval: str) -> dict:
    """Metrics of the part of a continuous run before ``end_ts`` (both runs start at the same bar)."""
    k = int(np.searchsorted(res.ts, end_ts, side="left"))
    trades = [t for t in res.trades if t["time"] < end_ts]
    return mt.compute(res.equity[:k], res.ts[:k], trades, res.start_eur, interval, exposure=res.exposure[:k],
                      bh_equity=bh.equity[:k])


def _median(xs):
    xs = [x for x in xs if x is not None and math.isfinite(x)]
    return round(float(np.median(xs)), 4) if xs else None


def _agg(fold_metrics: list[dict]) -> dict:
    def col(k):
        return [m.get(k) for m in fold_metrics]
    rets = [x for x in col("returnPct") if x is not None]
    vs = [x for x in col("vsBuyHoldPct") if x is not None]
    return {
        "folds": len(fold_metrics),
        "medianReturnPct": _median(rets),
        "meanReturnPct": round(float(np.mean(rets)), 4) if rets else None,
        "worstReturnPct": min(rets) if rets else None,
        "medianVsBuyHoldPct": _median(vs),
        "worstVsBuyHoldPct": min(vs) if vs else None,
        "foldsBeatBuyHoldPct": round(100.0 * sum(1 for x in vs if x > 0) / len(vs), 1) if vs else None,
        "medianMaxDrawdownPct": _median(col("maxDrawdownPct")),
        "medianSharpe": _median(col("sharpe")),
        "trades": int(sum(m.get("trades") or 0 for m in fold_metrics)),
        "feesEur": round(float(sum(m.get("feesEur") or 0 for m in fold_metrics)), 2),
        "medianExposurePct": _median(col("exposurePct")),
    }


def compute_score(fold_results: list[tuple[bt.BacktestResult, bt.BacktestResult]]) -> tuple[float | None, dict]:
    """The score formula from the module docstring. Returns (score, parts)."""
    if len(fold_results) < MIN_FOLDS:
        return None, {"reason": f"only {len(fold_results)} usable folds (need {MIN_FOLDS})"}
    xs, dds, n = [], [], 0
    for res, bh in fold_results:
        f = max(float(res.equity[-1]), 1e-6) / res.start_eur
        b = max(float(bh.equity[-1]), 1e-6) / bh.start_eur
        xs.append(math.log(f) - math.log(b))
        dds.append(mt.max_drawdown(res.equity, res.start_eur))
        n += len(res.trades)
    mx, mdd = float(np.median(xs)), float(np.median(dds))
    penalty = TRADE_PENALTY * max(0.0, 1.0 - n / MIN_TRADES)
    score = 100.0 * (mx - DD_WEIGHT * mdd) - penalty
    parts = {"medianExcessLogPct": round(100 * mx, 3), "worstExcessLogPct": round(100 * min(xs), 3),
             "medianDrawdownPct": round(100 * mdd, 3), "testTrades": n, "tradePenalty": round(penalty, 3),
             "foldsBeatBuyHold": int(sum(1 for x in xs if x > 0)), "folds": len(xs)}
    return round(score, 4), parts


def _vs_sentence(m: dict, markets: list[str]) -> str:
    r, b = m.get("returnPct"), m.get("buyHoldReturnPct")
    if r is None or b is None:
        return ""
    what = " and ".join(x.split("-")[0] for x in markets) if len(markets) <= 2 else "the same coins"
    diff = r - b
    dd, bdd = m.get("maxDrawdownPct"), m.get("buyHoldMaxDrawdownPct")
    risk = ""
    if dd is not None and bdd is not None:
        risk = (f" Its worst fall was {dd:.0f} % against {bdd:.0f} % for buy and hold"
                + (" (a smoother ride)." if dd < bdd else "."))
    if diff >= 0:
        return (f"Over the last test year it returned {r:+.1f} % while buying and holding {what} returned "
                f"{b:+.1f} %: {diff:.1f} percentage points better.{risk}")
    return (f"Over the last test year it returned {r:+.1f} % against {b:+.1f} % for simply holding {what}: "
            f"{-diff:.1f} percentage points worse.{risk}")


@lru_cache(maxsize=16)
def _benchmarks_cached(a: int, b: int, interval: str) -> tuple:
    from . import data
    out = []
    try:
        from . import universe
        top = list(universe.top10())
    except Exception:  # noqa: BLE001
        top = []
    sets = [("Buy and hold BTC", ["BTC-EUR"]), ("Buy and hold ETH", ["ETH-EUR"])]
    if top:
        sets.append(("Equal-weight top-10 basket", top))
    for name, ms in sets:
        try:
            cd = data.load_many(ms, interval)
            ms_ok = [m for m in ms if len(cd[m])]
            res = bt.buy_and_hold(ms_ok, cd, START_EUR, start=a, end=b, interval=interval)
            out.append({"name": name, "markets": ms_ok, "returnPct": res.metrics["returnPct"],
                        "maxDrawdownPct": res.metrics["maxDrawdownPct"], "equity": res.equity_points(400)})
        except Exception:  # noqa: BLE001 - a missing download must not fail the evaluation
            continue
    return tuple(json.dumps(x) for x in out)


def benchmarks(a: int, b: int, interval: str = "1d") -> list[dict]:
    """Buy and hold BTC, ETH and an equal-weight top-10 basket over [a, b) (daily candles by default)."""
    return [json.loads(x) for x in _benchmarks_cached(int(a), int(b), interval)]


# --------------------------------------------------------------------------------------------- main entry

def evaluate(spec: dict, *, candles: dict | None = None, holdout_days: int = HOLDOUT_DAYS, n_folds: int = N_FOLDS,
             with_benchmarks: bool = True, start=None, end=None, fees: dict | None = None,
             start_eur: float = START_EUR) -> dict:
    """Walk-forward + holdout evaluation (see module docstring). Loads data itself unless ``candles`` is given.

    ``start``/``end`` (ms or date strings, passed to data.load_candles) limit the history used, e.g. for 1m data.
    """
    t_start = time.perf_counter()
    fam = get_family(spec["family"])
    spec = normalize_spec(spec, fam)
    err = fam.validate(spec)
    if err:
        raise ValueError(f"invalid params for {fam.name}: {err}")
    interval = spec["interval"]
    ims = mt.INTERVAL_MS[interval]
    markets = list(spec["markets"])
    if candles is None:
        candles = _load(fam.markets_needed(spec), interval, start, end)
    for m in fam.markets_needed(spec):
        if m not in candles or len(candles[m]) == 0:
            raise ValueError(f"no {interval} candles for {m}")

    full_targets = fam.targets(candles, spec)
    index = np.asarray(full_targets.index, dtype=np.int64)
    valid = ~np.isnan(full_targets.to_numpy(np.float64)).all(axis=1)
    if not valid.any():
        raise ValueError("strategy never produces a decision on this data (warm-up longer than the history?)")
    first_valid = int(np.argmax(valid))
    # The first trading bar is the one after the first decision.
    t0_i = min(first_valid + 1, len(index) - 1)
    t0 = int(index[t0_i])
    t_end = int(index[-1]) + ims
    span = t_end - int(index[0])
    hold = holdout_days * DAY_MS
    h = t_end - hold if span >= 2 * hold else int(index[0]) + int(0.75 * span)
    h = int(index[int(np.searchsorted(index, h, side="left"))]) if h <= int(index[-1]) else t_end
    fp = data_fingerprint(candles, fam.markets_needed(spec), interval, h)

    # Walk-forward folds over [t0, h)
    folds_out, fold_results = [], []
    k = n_folds
    while k >= MIN_FOLDS:
        seg = (h - t0) / (k + 2)
        if seg >= MIN_FOLD_BARS * ims:
            break
        k -= 1
    if h > t0 and k >= MIN_FOLDS:
        seg = (h - t0) / (k + 2)

        def snap(x):  # fold boundaries sit on bar open times
            return int(index[min(int(np.searchsorted(index, int(x), side="left")), len(index) - 1)])

        insample, insample_bh = _run_window(fam, spec, candles, full_targets, index, t0, h, fees, start_eur)
        for f in range(k):
            a = snap(t0 + seg * (f + 2))
            b = snap(t0 + seg * (f + 3)) if f < k - 1 else h
            res, bh = _run_window(fam, spec, candles, full_targets, index, a, b, fees, start_eur)
            if len(res.ts) < 2:
                continue
            fold_results.append((res, bh))
            folds_out.append({"fold": f + 1, "testPeriod": [mt.iso_day(a), mt.iso_day(b - 1)],
                              "trainPeriod": [mt.iso_day(t0), mt.iso_day(a - 1)],
                              "test": res.metrics, "train": _slice_metrics(insample, insample_bh, a, interval)})
        train = {"inSample": insample.metrics, "period": [mt.iso_day(t0), mt.iso_day(h - 1)],
                 "foldTrainAggregate": _agg([f["train"] for f in folds_out])}
    else:
        insample = None
        train = {"inSample": None, "period": None}
    score, parts = compute_score(fold_results)
    validation = _agg([f["test"] for f in folds_out])

    # Holdout
    holdout = None
    equity = bh_equity = []
    if h < t_end:
        hres, hbh = _run_window(fam, spec, candles, full_targets, index, h, t_end, fees, start_eur)
        holdout = dict(hres.metrics)
        holdout["testPeriod"] = [mt.iso_day(h), mt.iso_day(t_end - 1)]
        holdout["trainReturnPct"] = insample.metrics["returnPct"] if insample is not None else None
        n = len(hres.ts)
        sel = np.arange(n) if n <= 400 else np.unique(np.round(np.linspace(0, n - 1, 400)).astype(np.int64))
        equity = [[int(hres.ts[i]), round(float(hres.equity[i]), 2)] for i in sel]
        bh_equity = [[int(hbh.ts[i]), round(float(hbh.equity[i]), 2)] for i in sel]

    bench = []
    if with_benchmarks and holdout is not None:
        b_iv = interval if ims >= mt.INTERVAL_MS["1d"] else "1d"
        bench = benchmarks(h, t_end, b_iv)

    explanation = dict(fam.explain(spec))
    vs = _vs_sentence(holdout or {}, markets)
    explanation["vsBuyHold"] = vs
    return {
        "score": score,
        "scoreParts": parts,
        "spec_hash": spec_hash(spec),
        "fingerprint": fp,
        "spec": spec,
        "family": fam.name,
        "familyVersion": fam.version,
        "botReady": fam.bot_ready,
        "dataRange": [mt.iso_day(int(index[0])), mt.iso_day(t_end - 1)],
        "holdoutStart": mt.iso_day(h) if h < t_end else None,
        "folds": folds_out,
        "train": train,
        "validation": validation,
        "holdout": holdout,
        "equity": equity,
        "buyHoldEquity": bh_equity,
        "benchmarks": bench,
        "vsBuyHold": vs,
        "explanation": explanation,
        "runtimeSec": round(time.perf_counter() - t_start, 3),
    }
