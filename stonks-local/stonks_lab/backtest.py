"""Backtest engine: turns a family's target weights into orders and fills them with the SPEC §2 fill model.

Timeline of one bar t (bars are [open, high, low, close] with ts = open time):

1. Market orders (placed at the close of t-1, or limit orders that timed out with fallback "market") fill at
   open[t]: buys at open*(1+5 bps), sells at open*(1-5 bps), taker fee. Sells first, so their cash can fund buys.
2. Resting limit orders: a buy at p fills when low[t] < p, a sell when high[t] > p (strictly: touching is not
   enough), at p, maker fee. Sells before buys. postOnly limits always rest (the engine prices them away from the
   last close, so they can never be marketable when placed).
3. Risk exits on every open position: stopLossPct (average entry*(1-x)) and trailingStopPct (highest high since entry,
   from bars before t, *(1-x)) trigger when low[t] <= the stop and sell everything as a market order at
   min(open[t], stop)*(1-5 bps), taker (for a position opened during this bar: stop*(1-5 bps)). takeProfitPct
   triggers when high[t] > entry*(1+x) and fills there at maker (it is a resting limit). Stops win over take profit.
   After a risk exit the market is "stood down": no new buys until its target drops to 0 or rises above the level
   it had at the exit (otherwise a still-positive target would simply buy back on the next bar).
4. Equity is marked at close[t] (cash + coins*close; no exit fee is deducted for open positions).
5. Limit orders that have now been live for `timeoutBars` bars are cancelled, or with fallback "market" become a
   market order for the next open.
6. Decision at the close of t: target weights w (row t of the family's targets; NaN = no decision) against equity E
   (cash + coins at close). Per market: delta = w*E - coins*close. Target 0 sells the whole position (if worth
   >= EUR 5). Otherwise |delta| < max(EUR 5, 2 % of E) is ignored (no churn). A market that already has an open
   order keeps it if it still wants the same side, else the order is cancelled. Limit buys reserve their EUR (plus
   maker fee) from free cash like Bitvavo does, so a rotation sells first and buys on the next decision; market buys
   may also use the expected proceeds of market sells placed at the same close. Orders under EUR 5 are skipped.
   Limit prices: buy close*(1-limitOffsetBps), sell close*(1+limitOffsetBps).

Weights are clipped to >= 0 and each row is scaled down to sum <= risk.maxWeight.

Trading starts with the decision at the close of the bar *before* ``start`` (known at start), so a strategy can be
in the market from the first bar's open, like buy-and-hold. Window: start <= ts < end (bar open times, ms).

Speed: the per-bar loop runs on Python floats; while nothing can happen (no open orders, no position with stops,
targets unchanged and price-independent) it jumps straight to the next bar where the targets change.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import metrics as _metrics
from .families import get_family, normalize_spec

SLIPPAGE = 0.0005          # 5 bps adverse on every market order
MIN_ORDER_EUR = 5.0        # Bitvavo minOrderInQuoteAsset
CHURN_PCT = 0.02           # ignore deltas under 2 % of equity
DEFAULT_FEES = {"maker": 0.0015, "taker": 0.0025}
FAST_PATH = True           # skip idle bars (tests turn it off to prove it changes nothing)

_BUY, _SELL = 1, -1
_LIMIT, _MARKET = 0, 1


@dataclass
class BacktestResult:
    spec: dict
    markets: list
    ts: np.ndarray              # bar open times (ms) of the window
    equity: np.ndarray          # EUR at each bar close
    cash: np.ndarray
    exposure: np.ndarray        # coin value / equity at each bar close
    trades: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    start_eur: float = 1000.0
    interval: str | None = None

    @property
    def equity_series(self) -> pd.Series:
        return pd.Series(self.equity, index=pd.Index(self.ts, name="ts"), name="equity")

    def trades_frame(self) -> pd.DataFrame:
        return pd.DataFrame(self.trades)

    def equity_points(self, max_points: int = 400) -> list[list]:
        return downsample(self.ts, self.equity, max_points)


def downsample(ts, values, max_points: int = 400) -> list[list]:
    """[[t, value], ...] with at most ``max_points`` evenly spaced points; always keeps the first and last."""
    n = len(ts)
    if n == 0:
        return []
    if n <= max_points:
        idx = np.arange(n)
    else:
        idx = np.unique(np.round(np.linspace(0, n - 1, max_points)).astype(np.int64))
    return [[int(ts[i]), round(float(values[i]), 2)] for i in idx]


def _window(index: np.ndarray, start, end) -> tuple[int, int]:
    i0 = 0 if start is None else int(np.searchsorted(index, int(start), side="left"))
    i1 = len(index) if end is None else int(np.searchsorted(index, int(end), side="left"))
    return i0, i1


def _market_arrays(candles: dict, markets: list[str], index: np.ndarray):
    O, H, L, C, CF = [], [], [], [], []
    for m in markets:
        df = candles[m]
        mi = np.asarray(df.index, dtype=np.int64)
        if len(mi) == len(index) and np.array_equal(mi, index):
            o, h, l, c = (df[k].to_numpy(np.float64) for k in ("open", "high", "low", "close"))
        else:
            d = df[["open", "high", "low", "close"]].reindex(index)
            o, h, l, c = (d[k].to_numpy(np.float64) for k in ("open", "high", "low", "close"))
        cf = pd.Series(c).ffill().to_numpy(np.float64)
        O.append(o), H.append(h), L.append(l), C.append(c), CF.append(cf)
    return O, H, L, C, CF


def clean_weights(W: np.ndarray, max_weight: float) -> np.ndarray:
    W = np.array(W, dtype=np.float64, copy=True)
    nan_rows = np.isnan(W).all(axis=1)
    W = np.where(np.isnan(W), 0.0, W)
    W = np.clip(W, 0.0, None)
    s = W.sum(axis=1)
    over = s > max_weight + 1e-12
    if over.any():
        W[over] *= (max_weight / s[over])[:, None]
    W[nan_rows] = np.nan
    return W


def run(spec: dict, candles: dict, start_eur: float = 1000.0, fees: dict | None = None, start=None, end=None,
        targets: pd.DataFrame | None = None, interval: str | None = None,
        bh_equity: np.ndarray | None = None) -> BacktestResult:
    """Backtest ``spec`` on ``candles`` ({market: DataFrame}) between ``start`` (incl.) and ``end`` (excl.), ms.

    ``targets`` may be passed precomputed (``family.targets(candles, spec)``) to share work across windows; for an
    anchored family (dca_dip) it must have been computed with start_time = the bar before ``start``.
    ``bh_equity`` (same bars) adds vs-buy-and-hold metrics.
    """
    fam = get_family(spec["family"])
    spec = normalize_spec(spec, fam)
    fees = {**DEFAULT_FEES, **(fees or {})}
    interval = interval or spec.get("interval")
    if targets is None:
        st = None
        if fam.anchored and start is not None:
            st = anchor_time(candles, spec, start)
        targets = fam.targets(candles, spec, start_time=st)
    markets = list(targets.columns)
    index = np.asarray(targets.index, dtype=np.int64)
    i0, i1 = _window(index, start, end)
    if i1 <= i0:
        raise ValueError("empty backtest window")
    risk, ex = spec["risk"], spec["execution"]
    W = clean_weights(targets.to_numpy(np.float64), float(risk["maxWeight"]))
    O, H, L, C, CF = _market_arrays(candles, markets, index)
    eq, cash_arr, expo, trades = _simulate(W, index, O, H, L, C, CF, markets, i0, i1, float(start_eur), fees,
                                           risk, ex)
    ts = index[i0:i1]
    met = _metrics.compute(eq, ts, trades, float(start_eur), interval, exposure=expo, bh_equity=bh_equity)
    return BacktestResult(spec=spec, markets=markets, ts=ts, equity=eq, cash=cash_arr, exposure=expo,
                          trades=trades, metrics=met, start_eur=float(start_eur), interval=interval)


def anchor_time(candles: dict, spec: dict, start) -> int | None:
    """The bar before ``start`` (where the first decision happens) for anchored families."""
    if start is None:
        return None
    m = spec["markets"][0]
    idx = np.asarray(candles[m].index, dtype=np.int64)
    i = int(np.searchsorted(idx, int(start), side="left"))
    return int(idx[i - 1]) if i > 0 else (int(idx[0]) if len(idx) else None)


def _simulate(W, index, O, H, L, C, CF, markets, i0, i1, start_eur, fees, risk, ex):
    n, M = W.shape
    maker, taker = float(fees["maker"]), float(fees["taker"])
    slip_up, slip_dn = 1.0 + SLIPPAGE, 1.0 - SLIPPAGE
    sl = risk.get("stopLossPct") or 0.0
    tsl = risk.get("trailingStopPct") or 0.0
    tpp = risk.get("takeProfitPct") or 0.0
    risk_on = bool(sl or tsl or tpp)
    use_market = ex.get("orderType", "limit") == "market"
    off = float(ex.get("limitOffsetBps", 0) or 0) / 1e4
    timeout = max(1, int(ex.get("timeoutBars", 1) or 1))
    fallback_market = ex.get("fallback", "cancel") == "market"

    Ol = [a.tolist() for a in O]
    Hl = [a.tolist() for a in H]
    Ll = [a.tolist() for a in L]
    CFl = [a.tolist() for a in CF]
    Wl = W.tolist()
    ts = index.tolist()

    # Next bar (> t) whose target row differs from the previous row, for the idle fast path.
    Wc = np.where(np.isnan(W), -1.0, W)
    chg = np.zeros(n, dtype=bool)
    if n > 1:
        chg[1:] = (Wc[1:] != Wc[:-1]).any(axis=1)
    chg_pos = np.flatnonzero(chg)

    def next_change(t):
        k = int(np.searchsorted(chg_pos, t, side="right"))
        return int(chg_pos[k]) if k < len(chg_pos) else n

    nw = i1 - i0
    cash_arr = np.empty(nw)
    units_arr = np.zeros((M, nw))

    cash = start_eur
    reserved = 0.0
    units = [0.0] * M
    basis = [0.0] * M   # EUR spent incl. fees for the current coins (for realized P&L)
    avg = [0.0] * M     # average entry price (fees excluded), for stops
    peak = [0.0] * M
    orders = [None] * M  # [side, kind, price, qty_or_eur, age, reason, reserve]
    blocked = [None] * M
    last_w = [0.0] * M
    trades = []

    def fill_sell(j, t, q, px, fee_rate, liq, reason):
        nonlocal cash
        u = units[j]
        if q > u:
            q = u
        if q <= 0:
            return
        gross = q * px
        fee = gross * fee_rate
        cash += gross - fee
        cost = basis[j] * (q / u)
        pnl = gross - fee - cost
        closed = q >= u * (1 - 1e-12)
        if closed:
            units[j] = 0.0
            basis[j] = 0.0
            avg[j] = 0.0
            peak[j] = 0.0
        else:
            units[j] = u - q
            basis[j] -= cost
        trades.append({"time": ts[t], "market": markets[j], "side": "sell", "price": px, "amount": q, "eur": gross,
                       "fee": fee, "liquidity": liq, "reason": reason, "pnl": pnl, "closed": closed})

    def fill_buy(j, t, eur, px, fee_rate, liq, reason):
        nonlocal cash
        q = eur / px
        fee = eur * fee_rate
        cash -= eur + fee
        u = units[j]
        if u <= 0:
            peak[j] = px
            avg[j] = px
        else:
            avg[j] = (avg[j] * u + px * q) / (u + q)
        units[j] = u + q
        basis[j] += eur + fee
        trades.append({"time": ts[t], "market": markets[j], "side": "buy", "price": px, "amount": q, "eur": eur,
                       "fee": fee, "liquidity": liq, "reason": reason, "pnl": 0.0, "closed": False})

    def cancel(j):
        nonlocal reserved
        o = orders[j]
        if o is not None:
            if o[0] == _BUY and o[1] == _LIMIT:
                reserved -= o[6]
                if reserved < 1e-9:
                    reserved = 0.0
            orders[j] = None

    t = i0 - 1 if i0 > 0 else i0
    while t < i1:
        if t >= i0:
            held = [u > 0 for u in units]
            any_orders = False
            for o in orders:
                if o is not None:
                    any_orders = True
                    break
            if any_orders:
                # 1. market orders at the open: sells, then buys
                for side in (_SELL, _BUY):
                    for j in range(M):
                        o = orders[j]
                        if o is None or o[1] != _MARKET or o[0] != side:
                            continue
                        op = Ol[j][t]
                        if op != op:  # no candle for this market in this bar: wait
                            continue
                        orders[j] = None
                        if side == _SELL:
                            fill_sell(j, t, o[3], op * slip_dn, taker, "taker", o[5])
                        else:
                            px = op * slip_up
                            eur = min(o[3], (cash - reserved) / (1.0 + taker))
                            if eur >= MIN_ORDER_EUR:
                                fill_buy(j, t, eur, px, taker, "taker", o[5])
                # 2. resting limit orders: sells, then buys
                for side in (_SELL, _BUY):
                    for j in range(M):
                        o = orders[j]
                        if o is None or o[1] != _LIMIT or o[0] != side:
                            continue
                        p = o[2]
                        if side == _SELL:
                            hv = Hl[j][t]
                            if hv == hv and hv > p:
                                orders[j] = None
                                fill_sell(j, t, o[3], p, maker, "maker", o[5])
                        else:
                            lv = Ll[j][t]
                            if lv == lv and lv < p:
                                orders[j] = None
                                reserved -= o[6]
                                if reserved < 1e-9:
                                    reserved = 0.0
                                eur = min(o[3], (cash - reserved) / (1.0 + maker))
                                if eur > 0:
                                    fill_buy(j, t, eur, p, maker, "maker", o[5])
            # 3. risk exits
            if risk_on:
                for j in range(M):
                    if units[j] <= 0:
                        continue
                    lv = Ll[j][t]
                    if lv != lv:
                        continue
                    trig = -1.0
                    why = None
                    if sl:
                        trig = avg[j] * (1.0 - sl)
                        why = "stop_loss"
                    if tsl:
                        tp_ = peak[j] * (1.0 - tsl)
                        if tp_ > trig:
                            trig, why = tp_, "trailing_stop"
                    exited = False
                    if why is not None and lv <= trig:
                        ref = min(Ol[j][t], trig) if held[j] else trig
                        cancel(j)
                        fill_sell(j, t, units[j], ref * slip_dn, taker, "taker", why)
                        exited = True
                    elif tpp and Hl[j][t] > avg[j] * (1.0 + tpp):
                        cancel(j)
                        fill_sell(j, t, units[j], avg[j] * (1.0 + tpp), maker, "maker", "take_profit")
                        exited = True
                    if exited:
                        blocked[j] = last_w[j]
                    elif held[j]:
                        hv = Hl[j][t]
                        if hv > peak[j]:
                            peak[j] = hv
            # 4. mark the state at this close
            k = t - i0
            cash_arr[k] = cash
            for j in range(M):
                units_arr[j, k] = units[j]
            # 5. limit order timeouts
            if any_orders:
                for j in range(M):
                    o = orders[j]
                    if o is None or o[1] != _LIMIT:
                        continue
                    o[4] += 1
                    if o[4] >= timeout:
                        if fallback_market:
                            if o[0] == _BUY:
                                reserved -= o[6]
                                if reserved < 1e-9:
                                    reserved = 0.0
                            orders[j] = [o[0], _MARKET, 0.0, o[3], 0, "fallback", 0.0]
                        else:
                            cancel(j)
        if t >= i1 - 1:
            break
        # 6. decision at the close of t
        row = Wl[t]
        if row[0] == row[0] or M > 1:
            E = cash
            for j in range(M):
                if units[j]:
                    E += units[j] * CFl[j][t]
            thresh = max(MIN_ORDER_EUR, CHURN_PCT * E)
            buys = []
            est_proceeds = 0.0
            for j in range(M):
                w = row[j]
                if w != w:
                    continue
                c = CFl[j][t]
                if c != c or C[j][t] != C[j][t]:  # no candle now: cannot price a fresh order
                    continue
                if blocked[j] is not None:
                    if w <= 1e-12 or w > blocked[j] + 1e-9:
                        blocked[j] = None
                last_w[j] = w
                cur = units[j] * c
                want = 0
                amount = 0.0
                if w <= 0.0:
                    if cur >= MIN_ORDER_EUR:
                        want, amount = _SELL, units[j]
                else:
                    delta = w * E - cur
                    if delta >= thresh:
                        if blocked[j] is None:
                            want, amount = _BUY, delta
                    elif -delta >= thresh:
                        want, amount = _SELL, min(units[j], -delta / c)
                o = orders[j]
                if o is not None:
                    if o[0] == want:
                        continue
                    cancel(j)
                if want == _SELL:
                    if amount * c < MIN_ORDER_EUR:
                        continue
                    if use_market:
                        orders[j] = [_SELL, _MARKET, 0.0, amount, 0, "signal", 0.0]
                        est_proceeds += amount * c * (1.0 - taker)
                    else:
                        orders[j] = [_SELL, _LIMIT, c * (1.0 + off), amount, 0, "signal", 0.0]
                elif want == _BUY:
                    buys.append((j, amount, c))
            for j, amount, c in buys:
                if use_market:
                    eur = min(amount, (cash - reserved + est_proceeds) / (1.0 + taker))
                    if eur >= MIN_ORDER_EUR:
                        orders[j] = [_BUY, _MARKET, 0.0, eur, 0, "signal", 0.0]
                        est_proceeds -= eur * (1.0 + taker)
                else:
                    eur = min(amount, (cash - reserved) / (1.0 + maker))
                    if eur >= MIN_ORDER_EUR:
                        res = eur * (1.0 + maker)
                        reserved += res
                        orders[j] = [_BUY, _LIMIT, c * (1.0 - off), eur, 0, "signal", res]
        # idle fast path
        nxt = t + 1
        if FAST_PATH and all(o is None for o in orders) and not (risk_on and any(u > 0 for u in units)):
            stable = True
            free = cash - reserved
            for j in range(M):
                w = row[j]
                u = units[j]
                if w != w or (w <= 0.0 and u == 0.0):
                    continue
                if blocked[j] is not None and u == 0.0:
                    continue
                if w >= 1.0 - 1e-12 and u > 0 and free < MIN_ORDER_EUR:
                    continue
                stable = False
                break
            if stable:
                nc = min(next_change(t), i1)
                if nc > t + 1:
                    a, b = max(t + 1, i0) - i0, nc - i0
                    if b > a:
                        cash_arr[a:b] = cash
                        for j in range(M):
                            units_arr[j, a:b] = units[j]
                    nxt = nc
        t = nxt

    sl_ = slice(i0, i1)
    coin = np.zeros(nw)
    for j in range(M):
        px = np.nan_to_num(CF[j][sl_], nan=0.0)
        coin += units_arr[j] * px
    equity = cash_arr + coin
    with np.errstate(invalid="ignore", divide="ignore"):
        expo = np.where(equity > 0, coin / equity, 0.0)
    return equity, cash_arr, expo, trades


def buy_and_hold(markets, candles: dict, start_eur: float = 1000.0, fees: dict | None = None, start=None, end=None,
                 interval: str | None = None, index: np.ndarray | None = None) -> BacktestResult:
    """Equal split over ``markets``, one market buy each (taker fee + 5 bps) at the first open in the window, then
    hold. A market that has no candle yet at the start buys at its first open inside the window."""
    if isinstance(markets, str):
        markets = [markets]
    markets = list(markets)
    fees = {**DEFAULT_FEES, **(fees or {})}
    taker = float(fees["taker"])
    if index is None:
        idx = None
        for m in markets:
            mi = np.asarray(candles[m].index, dtype=np.int64)
            idx = mi if idx is None else np.union1d(idx, mi)
        index = idx
    index = np.asarray(index, dtype=np.int64)
    i0, i1 = _window(index, start, end)
    if i1 <= i0:
        raise ValueError("empty buy-and-hold window")
    O, H, L, C, CF = _market_arrays(candles, markets, index)
    nw = i1 - i0
    alloc = float(start_eur) / len(markets)
    cash = np.full(nw, float(start_eur))
    coin = np.zeros(nw)
    trades = []
    for j, m in enumerate(markets):
        o = O[j][i0:i1]
        ok = np.flatnonzero(np.isfinite(o))
        if len(ok) == 0:
            continue
        k = int(ok[0])
        px = float(o[k]) * (1.0 + SLIPPAGE)
        q = alloc / (px * (1.0 + taker))
        fee = q * px * taker
        cash[k:] -= alloc
        coin[k:] += q * np.nan_to_num(CF[j][i0:i1][k:], nan=0.0)
        trades.append({"time": int(index[i0 + k]), "market": m, "side": "buy", "price": px, "amount": q,
                       "eur": q * px, "fee": fee, "liquidity": "taker", "reason": "buy_and_hold", "pnl": 0.0,
                       "closed": False})
    equity = cash + coin
    expo = np.where(equity > 0, coin / equity, 0.0)
    ts = index[i0:i1]
    met = _metrics.compute(equity, ts, trades, float(start_eur), interval, exposure=expo)
    spec = {"family": "buy_and_hold", "markets": markets, "interval": interval}
    return BacktestResult(spec=spec, markets=markets, ts=ts, equity=equity, cash=cash, exposure=expo,
                          trades=trades, metrics=met, start_eur=float(start_eur), interval=interval)
