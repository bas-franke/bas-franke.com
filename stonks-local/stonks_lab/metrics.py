"""Performance metrics for an equity curve (EUR at every bar close) plus its fills.

All percentages are percent numbers (12.5 = 12.5 %). Crypto trades 24/7, so a year is 365 days of bars:
bars_per_year = 365*24*3600*1000 / interval_ms. Per-bar returns include the first bar against the starting cash.

- returnPct      final/start - 1
- cagrPct        (final/start)^(1/years) - 1, years = bars * interval / 365 days (None under 30 days: too noisy)
- maxDrawdownPct largest peak-to-trough fall of the equity curve (starting cash counts as the first peak), >= 0
- sharpe         mean(r)/std(r, ddof=1) * sqrt(bars_per_year), r = per-bar simple returns, no risk-free rate
- sortino        mean(r)/sqrt(mean(min(r,0)^2)) * sqrt(bars_per_year)
- trades         number of fills (buys + sells); roundTrips = sells that closed a position completely
- winRatePct     share of sell fills with positive realized P&L (net of both fees, average-cost basis)
- feesEur        all fees paid
- exposurePct    time-average of coin value / equity
- turnover       traded EUR (buys + sells) / average equity; turnoverPerYear the same per year
- vsBuyHoldPct   returnPct - buy-and-hold returnPct over the same bars (when a benchmark curve is given)
"""
from __future__ import annotations

import datetime as dt
import math

import numpy as np

try:  # the data module is written in parallel; keep a local copy of the table
    from .data import INTERVAL_MS as _DATA_INTERVAL_MS  # type: ignore
except Exception:  # noqa: BLE001
    _DATA_INTERVAL_MS = None

INTERVAL_MS = dict(_DATA_INTERVAL_MS) if _DATA_INTERVAL_MS else {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000,
    "4h": 14_400_000, "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000,
    "1W": 604_800_000,
}
YEAR_MS = 365 * 24 * 3600 * 1000


def bars_per_year(interval: str) -> float:
    return YEAR_MS / INTERVAL_MS[interval]


def _r(x, nd=2):
    if x is None:
        return None
    x = float(x)
    return round(x, nd) if math.isfinite(x) else None


def iso_day(ts_ms: int) -> str:
    return dt.datetime.fromtimestamp(int(ts_ms) / 1000, dt.timezone.utc).strftime("%Y-%m-%d")


def max_drawdown(equity: np.ndarray, start: float | None = None) -> float:
    """Largest fall from a running peak, as a fraction (0.25 = 25 %)."""
    e = np.asarray(equity, dtype=np.float64)
    if start is not None:
        e = np.concatenate([[start], e])
    if len(e) == 0:
        return 0.0
    peak = np.maximum.accumulate(e)
    with np.errstate(invalid="ignore", divide="ignore"):
        dd = 1.0 - e / peak
    return float(np.nanmax(dd)) if len(dd) else 0.0


def compute(equity, ts, trades: list[dict], start_eur: float, interval: str | None, exposure=None,
            bh_equity=None) -> dict:
    e = np.asarray(equity, dtype=np.float64)
    n = len(e)
    if n == 0:
        return {"bars": 0, "finalEur": start_eur, "returnPct": 0.0}
    final = float(e[-1])
    ret = final / start_eur - 1.0
    imss = INTERVAL_MS.get(interval) if interval else None
    years = n * imss / YEAR_MS if imss else None
    cagr = None
    if years and years * 365 >= 30 and final > 0:
        cagr = (final / start_eur) ** (1.0 / years) - 1.0
    r = np.diff(np.concatenate([[start_eur], e])) / np.concatenate([[start_eur], e[:-1]])
    r = r[np.isfinite(r)]
    sharpe = sortino = None
    if imss and len(r) > 1:
        ann = math.sqrt(YEAR_MS / imss)
        sd = float(np.std(r, ddof=1))
        mu = float(np.mean(r))
        sharpe = mu / sd * ann if sd > 0 else 0.0
        down = math.sqrt(float(np.mean(np.minimum(r, 0.0) ** 2)))
        sortino = mu / down * ann if down > 0 else (0.0 if mu <= 0 else None)
    buys = sum(1 for t in trades if t["side"] == "buy")
    sells = [t for t in trades if t["side"] == "sell"]
    wins = sum(1 for t in sells if t.get("pnl", 0.0) > 0)
    fees = sum(t["fee"] for t in trades)
    traded = sum(t["eur"] for t in trades)
    mean_eq = float(np.mean(e)) if n else start_eur
    out = {
        "bars": n,
        "start": iso_day(ts[0]) if len(ts) else None,
        "end": iso_day(ts[-1]) if len(ts) else None,
        "years": _r(years, 3),
        "finalEur": _r(final),
        "returnPct": _r(ret * 100, 3),
        "cagrPct": _r(None if cagr is None else cagr * 100, 3),
        "maxDrawdownPct": _r(max_drawdown(e, start_eur) * 100, 3),
        "sharpe": _r(sharpe, 3),
        "sortino": _r(sortino, 3),
        "trades": buys + len(sells),
        "buys": buys,
        "sells": len(sells),
        "roundTrips": sum(1 for t in sells if t.get("closed")),
        "winRatePct": _r(wins / len(sells) * 100, 2) if sells else None,
        "feesEur": _r(fees),
        "exposurePct": _r(float(np.mean(exposure)) * 100, 2) if exposure is not None and len(exposure) else None,
        "turnover": _r(traded / mean_eq if mean_eq > 0 else 0.0, 3),
        "turnoverPerYear": _r(traded / mean_eq / years if mean_eq > 0 and years else None, 3),
    }
    if bh_equity is not None and len(bh_equity):
        b = np.asarray(bh_equity, dtype=np.float64)
        bh_ret = float(b[-1]) / start_eur - 1.0
        out["buyHoldReturnPct"] = _r(bh_ret * 100, 3)
        out["buyHoldMaxDrawdownPct"] = _r(max_drawdown(b, start_eur) * 100, 3)
        out["vsBuyHoldPct"] = _r((ret - bh_ret) * 100, 3)
    return out
