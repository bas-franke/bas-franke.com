"""Out-of-sample evaluation of one strategy spec: walk-forward folds plus an untouched holdout.

Splits (by time, on the spec's own candles; eval version 2):

    |-- seg 1 --|-- seg 2 --|-- seg 3 --| ... |-- seg K+2 --|========= holdout =========|
    D0                                                      H                          end
    (first bar of the data: union of the spec's markets)    (last HOLDOUT_DAYS = 365 days)

- Holdout = the last 365 days of data (or the last 25 % when there is less than two years). It is reported but
  NEVER used for the score, so the 20 search agents cannot overfit it.
- Fold boundaries depend on the DATA only, never on the spec: the history [D0, H) is cut into K+2 equal time
  segments (K = 6 folds) and fold k (1..K) tests segment k+2 from a fresh EUR 1000 start. So every spec on the same
  markets + interval (+ the same start/end limits) is tested on exactly the same windows, whatever its warm-up.
  D0 is the first bar of the union of the spec's markets: for BTC, ETH and the top-10 basket that is the start of
  the BTC/ETH history (2019-03); coins listed later (SOL/BNB/DOGE/AVAX, 2021-08) do NOT shift it. They join the
  strategy and buy-and-hold at their first candle inside a window (buy-and-hold keeps their share in cash until
  then).
- Warm-up comes from the data before each fold start: indicators are computed once over the whole history and
  decisions at bar t only use bars <= t (tested). The two leading segments (25 % of the history, ~1.6 years on 1d)
  are the fixed warm-up allowance. A fold is usable only when the strategy has a decision at the bar before the
  fold starts; a spec whose warm-up is longer than that loses its early folds instead of having them moved.
  Anchored families (dca_dip) restart their schedule at every window start.
- "train" of fold k is everything from the first warm bar up to that fold (expanding window, taken from one
  continuous in-sample run). Params are not fitted here; the score only looks at the test segments.
- Buy-and-hold for each window: the same markets, equal split, one taker market buy (+5 bps) at the window's first
  open, same fees.

Score (higher is better, roughly "percentage points"), over the usable test folds f:

    x_f    = ln(final_f / 1000) - ln(buyHoldFinal_f / 1000)       log excess return over buy-and-hold, fold f
    dd_f   = max drawdown of the strategy in test fold f (fraction, 0.3 = 30 %)
    X      = mean of x_f after dropping the single best fold        ("all folds chained, minus the luckiest one")
    N      = number of fills summed over all test folds
    score  = 100 * ( X - 0.5 * median_f(dd_f) ) - 10 * max(0, 1 - N / 20)

i.e. the typical out-of-sample excess (log) return over buy-and-hold, minus half the typical drawdown, minus up to
10 points when there are fewer than 20 trades in all test folds together (too few decisions to trust). The mean
(not the median) means a fold lost badly to buy and hold always counts, so sitting in cash through the bull folds
and "winning" the bear folds no longer scores well; dropping the best fold means one lucky fold counts for little.
Fewer than 3 usable folds gives score None.

Eligibility (scoreParts.eligible, used by the leaderboard; the score itself is still reported):

    participation = median over the usable folds of the time-average exposure (coin value / equity)
    eligible      = participation >= 10 %

A spec that sits in cash in most folds is not a strategy, whatever its score: it is never ranked or published.
Buy and hold is the benchmark of every fold, never a candidate.

EVAL_VERSION (= registry.EVAL_VERSION) is stored with every result; the leaderboard only compares results of the current
version, and ``lab.py rescore`` re-evaluates older rows in place. Version 1 (until 2026-10-26) started the folds after
each spec's own warm-up and used the median of x_f (findings #21/#22). Version 3 only changes the point-in-time
universe (coins eligible only from their first CoinMarketCap top-15 snapshot, findings #258-#260); results without
a universe are identical to version 2 (``lab.py rescore`` carries them forward without re-running).
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
# Kept literal (not imported from registry) so a worker process that already holds an older registry module
# still imports this one; tests assert it equals registry.EVAL_VERSION.
EVAL_VERSION = 3   # 3: point-in-time universe with dated CMC eligibility (universe.PIT_VERSION 2)
MIN_PARTICIPATION_PCT = 10.0   # median fold exposure needed to be ranked (eligible)
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
                   "risk": s["risk"], "execution": s["execution"],
                   **({"universe": s["universe"]} if s.get("universe") else {})})


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


def _targets_for(fam, spec, candles, full_targets, start, members=None):
    if fam.anchored:
        tg = fam.targets(candles, spec, start_time=bt.anchor_time(candles, spec, start))
        if members is not None:
            from . import universe
            tg = universe.apply_pit(tg, members)
        return tg
    return full_targets


def _bh_markets(spec, full_targets, index, members, a):
    """Buy and hold of the same markets; for a point-in-time universe: the members at the window start."""
    if members is None:
        return spec["markets"]
    i = min(int(np.searchsorted(index, int(a), side="left")), len(index) - 1)
    cols = list(full_targets.columns)
    ms = [m for j, m in enumerate(cols) if members[i, j]]
    return ms or spec["markets"]


def _run_window(fam, spec, candles, full_targets, index, a, b, fees, start_eur, members=None):
    bh = bt.buy_and_hold(_bh_markets(spec, full_targets, index, members, a), candles, start_eur, fees, start=a,
                         end=b, interval=spec["interval"], index=index)
    tg = _targets_for(fam, spec, candles, full_targets, a, members)
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
    """The score formula from the module docstring (eval version 2). Returns (score, parts)."""
    if len(fold_results) < MIN_FOLDS:
        return None, {"reason": f"only {len(fold_results)} usable folds (need {MIN_FOLDS})",
                      "folds": len(fold_results), "eligible": False, "evalVersion": EVAL_VERSION}
    xs, dds, expos, n = [], [], [], 0
    for res, bh in fold_results:
        f = max(float(res.equity[-1]), 1e-6) / res.start_eur
        b = max(float(bh.equity[-1]), 1e-6) / bh.start_eur
        xs.append(math.log(f) - math.log(b))
        dds.append(mt.max_drawdown(res.equity, res.start_eur))
        ex = np.asarray(res.exposure, dtype=np.float64)
        expos.append(float(np.mean(ex)) if len(ex) else 0.0)
        n += len(res.trades)
    kept = sorted(xs)[:-1]                       # drop the single best fold
    mx, mdd = float(np.mean(kept)), float(np.median(dds))
    penalty = TRADE_PENALTY * max(0.0, 1.0 - n / MIN_TRADES)
    score = 100.0 * (mx - DD_WEIGHT * mdd) - penalty
    part = 100.0 * float(np.median(expos))
    eligible = part >= MIN_PARTICIPATION_PCT
    parts = {"meanExcessLogPct": round(100 * mx, 3), "medianExcessLogPct": round(100 * float(np.median(xs)), 3),
             "bestExcessLogPct": round(100 * max(xs), 3), "worstExcessLogPct": round(100 * min(xs), 3),
             "medianDrawdownPct": round(100 * mdd, 3), "testTrades": n, "tradePenalty": round(penalty, 3),
             "foldsBeatBuyHold": int(sum(1 for x in xs if x > 0)), "folds": len(xs),
             "medianExposurePct": round(part, 2), "foldsInMarket": int(sum(1 for e in expos if e >= 0.01)),
             "eligible": bool(eligible), "evalVersion": EVAL_VERSION}
    if not eligible:
        parts["ineligibleReason"] = (f"median fold exposure {part:.1f} % < {MIN_PARTICIPATION_PCT:.0f} %: "
                                     "sits in cash most of the time")
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
    universe_name = spec.get("universe")
    if universe_name not in (None, "top10_pit"):
        raise ValueError(f"unknown universe {universe_name!r} (known: top10_pit)")
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
    members = None
    if universe_name is not None:              # point-in-time universe (stonks_lab/universe.py)
        from . import universe
        daily = candles if interval == "1d" else None
        members = universe.pit_members(index, list(full_targets.columns), daily=daily)
        full_targets = universe.apply_pit(full_targets, members)
    valid = ~np.isnan(full_targets.to_numpy(np.float64)).all(axis=1)
    if not valid.any():
        raise ValueError("strategy never produces a decision on this data (warm-up longer than the history?)")
    first_valid = int(np.argmax(valid))
    first_decision = int(index[first_valid])     # a window starting after this bar is warm
    # The first bar the strategy can trade (after its first decision); only used for the in-sample run.
    t0 = int(index[min(first_valid + 1, len(index) - 1)])
    d0 = int(index[0])                           # data start: fold boundaries depend on the data only
    t_end = int(index[-1]) + ims
    span = t_end - d0
    hold = holdout_days * DAY_MS
    h = t_end - hold if span >= 2 * hold else d0 + int(0.75 * span)
    h = int(index[int(np.searchsorted(index, h, side="left"))]) if h <= int(index[-1]) else t_end
    fp = data_fingerprint(candles, fam.markets_needed(spec), interval, h)

    # Walk-forward folds over [d0, h), identical for every spec on these markets + interval
    folds_out, fold_results, skipped = [], [], []
    k = n_folds
    while k >= MIN_FOLDS:
        seg = (h - d0) / (k + 2)
        if seg >= MIN_FOLD_BARS * ims:
            break
        k -= 1
    insample = None
    train = {"inSample": None, "period": None}
    if h > d0 and k >= MIN_FOLDS:
        seg = (h - d0) / (k + 2)

        def snap(x):  # fold boundaries sit on bar open times
            return int(index[min(int(np.searchsorted(index, int(x), side="left")), len(index) - 1)])

        if h > t0:
            insample, insample_bh = _run_window(fam, spec, candles, full_targets, index, t0, h, fees, start_eur,
                                                 members)
        for f in range(k):
            a = snap(d0 + seg * (f + 2))
            b = snap(d0 + seg * (f + 3)) if f < k - 1 else h
            if first_decision >= a:              # not warm by the fold start: unusable, never moved later
                skipped.append({"fold": f + 1, "testPeriod": [mt.iso_day(a), mt.iso_day(b - 1)],
                                "reason": "warm-up not finished at the fold start"})
                continue
            res, bh = _run_window(fam, spec, candles, full_targets, index, a, b, fees, start_eur, members)
            if len(res.ts) < 2:
                continue
            fold_results.append((res, bh))
            folds_out.append({"fold": f + 1, "testPeriod": [mt.iso_day(a), mt.iso_day(b - 1)],
                              "trainPeriod": [mt.iso_day(t0), mt.iso_day(a - 1)],
                              "test": res.metrics, "train": _slice_metrics(insample, insample_bh, a, interval)})
        if insample is not None:
            train = {"inSample": insample.metrics, "period": [mt.iso_day(t0), mt.iso_day(h - 1)],
                     "foldTrainAggregate": _agg([f["train"] for f in folds_out])}
    score, parts = compute_score(fold_results)
    validation = _agg([f["test"] for f in folds_out])

    # Holdout
    holdout = None
    equity = bh_equity = []
    if h < t_end:
        hres, hbh = _run_window(fam, spec, candles, full_targets, index, h, t_end, fees, start_eur, members)
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
    if skipped:
        parts["skippedFolds"] = skipped
    if universe_name is not None:
        parts["universe"] = universe_name
    elif len(markets) > 2:
        parts["survivorshipBiased"] = True     # a fixed list picked today: see universe.is_survivorship_biased
    return {
        "score": score,
        "scoreParts": parts,
        "evalVersion": EVAL_VERSION,
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
