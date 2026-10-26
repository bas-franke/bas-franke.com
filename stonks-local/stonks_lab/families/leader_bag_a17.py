"""leader_bag_a17 v1 (agent-17): hold the AVERAGE position of several different BTC/ETH-only leader strategies.

froth_bag (#460) bags copies of ONE family around its peak. This bags DIFFERENT families, each frozen at the
published BTC/ETH-only lead the fleet validated (no alt list, no hindsight in coin choice):

- ``duo``: duo_core d61ce6cfc7 (BTC slot core_dip pair panic + SMA58, ETH slot macd_days 12/182/35), #405;
- ``panic``: turnover_panic 041809012e (SMA132 core + buy volume flushes, hold 97 d), #339;
- ``beta``: beta_shift 9cbdcbe10d (BTC SMA130 core, all-in ETH while ETH > SMA100, keep 50 % below), #450;
- ``split``: BTC half = mean of core_dip 56686c4a38 and powerlaw_band f5dcc572d5, ETH half = wick_pressure
  b32ea0f175 (#457, #468).

Every member decides from candles up to bar t (each member family has its own no-look-ahead test), so the bag does
too. The members were picked BECAUSE they scored well on these same folds: the bag's score carries that selection.
The honest question it answers is whether averaging different leaders beats the average leader (diversification),
not whether the bag beats holding. Member params are in daily candles: use it on 1d with BTC-EUR + ETH-EUR.
"""
from __future__ import annotations

import numpy as np

from ._base import frame, max_weight, risk_steps, union_index
from . import beta_shift, core_dip, duo_core, powerlaw_band, turnover_panic, wick_pressure

NAME = "leader_bag_a17"
VERSION = 1
TITLE = "Bag of BTC/ETH leaders"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]

DUO = {"btcShare": 0.5, "coreSma": 58, "fastDays": 12, "maxHold": 86, "rsiBelow": 37.3, "rsiPeriod": 25,
       "sellAbove": 44.6, "signalDays": 35, "slowDays": 182}
PANIC = {"coreSma": 132, "dropLook": 7, "dropMin": 0.15, "extend": False, "holdBars": 97, "source": "own",
         "volLook": 90, "volMult": 3}
BETA = {"coreSma": 130, "ethShare": 1, "heat": "eth_sma", "heatLen": 100, "heatThr": 0, "offWeight": 0.5}
COREDIP = {"coreSma": 58, "maxHold": 86, "rsiBelow": 37.2934, "rsiPeriod": 25, "scope": "pair",
           "sellAbove": 44.5613}
POWERLAW = {"band": 0.5, "cheapZ": -0.6, "coreSma": 46, "minHist": 365, "richZ": 0, "slope": 6.4}
WICK = {"combine": "or", "coreLen": 0, "exitAbove": 0, "look": 63, "reenter": -0.0382, "scope": "own"}
MEMBERS = ["duo", "panic", "beta", "split"]


def default_params() -> dict:
    return {"duo": True, "panic": True, "beta": True, "split": True}


def param_space() -> dict:
    return {
        "duo": {"type": "bool", "description": "include duo_core (BTC dip core + ETH MACD)"},
        "panic": {"type": "bool", "description": "include turnover_panic (SMA core + volume-flush buys)"},
        "beta": {"type": "bool", "description": "include beta_shift (BTC core, ETH while ETH trends, 50 % floor)"},
        "split": {"type": "bool", "description": "include core_dip + powerlaw_band on BTC and wick_pressure on ETH"},
    }


def valid_params(p: dict) -> str | None:
    return None if any(bool(p.get(k)) for k in MEMBERS) else "enable at least one member"


def warmup(p: dict) -> int:
    w = [0]
    if p.get("duo"):
        w.append(duo_core.warmup(DUO))
    if p.get("panic"):
        w.append(turnover_panic.warmup(PANIC))
    if p.get("beta"):
        w.append(beta_shift.warmup(BETA))
    if p.get("split"):
        w += [core_dip.warmup(COREDIP), powerlaw_band.warmup(POWERLAW), wick_pressure.warmup(WICK)]
    return max(w)


def required_markets(spec: dict) -> list[str]:
    return list(PAIR)


def _member(mod, candles, interval, markets, params, idx) -> np.ndarray:
    s = {"family": mod.NAME, "interval": interval, "markets": list(markets), "params": dict(params),
         "risk": {"maxWeight": 1.0}}
    t = mod.targets(candles, s).reindex(idx)
    v = t[list(markets)].to_numpy(np.float64).copy()
    ok = np.isfinite(v).all(axis=1)
    if ok.any():                                  # carry the last decision over bars a member has no row for
        first = int(np.argmax(ok))
        tail = t.iloc[first:][list(markets)].ffill().to_numpy(np.float64)
        v[first:] = tail
    return v


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if markets != PAIR:
        raise ValueError("leader_bag_a17 trades exactly BTC-EUR + ETH-EUR")
    iv = spec.get("interval")
    idx = union_index(candles, markets)
    mats = []
    if p.get("duo"):
        mats.append(_member(duo_core, candles, iv, PAIR, DUO, idx))
    if p.get("panic"):
        mats.append(_member(turnover_panic, candles, iv, PAIR, PANIC, idx))
    if p.get("beta"):
        mats.append(_member(beta_shift, candles, iv, PAIR, BETA, idx))
    if p.get("split"):
        cd = _member(core_dip, candles, iv, ["BTC-EUR"], COREDIP, idx)[:, 0]
        pl = _member(powerlaw_band, candles, iv, ["BTC-EUR"], POWERLAW, idx)[:, 0]
        wk = _member(wick_pressure, candles, iv, ["ETH-EUR"], WICK, idx)[:, 0]
        mats.append(np.column_stack([0.25 * (cd + pl), 0.5 * wk]))
    if not mats:
        raise ValueError("leader_bag_a17 needs at least one member")
    stack = np.stack(mats)                        # members x bars x 2
    good = np.isfinite(stack).all(axis=(0, 2))
    w = np.where(good[:, None], stack.mean(axis=0), np.nan) * max_weight(spec)
    return frame(idx, {m: w[:, i] for i, m in enumerate(markets)})


def explain(spec) -> dict:
    p = spec["params"]
    names = {"duo": "a Bitcoin dip-buying trend core next to an Ether MACD trend",
             "panic": "a trend core that also buys high-volume sell-offs",
             "beta": "a Bitcoin trend core that moves into Ether while Ether trends, keeping half invested",
             "split": "Bitcoin trend/dip and deep-value rules next to an Ether wick-pressure exit"}
    on = [names[k] for k in MEMBERS if p.get(k)]
    return {
        "summary": f"Splits the money over {len(on)} different Bitcoin/Ether strategies and holds their average "
                   "position, so no single rule decides.",
        "howItWorks": ["After every daily candle each member strategy decides its own Bitcoin and Ether position; "
                       "the bag holds the average.", *[f"Member: {x}." for x in on], *risk_steps(spec)],
        "whenItWins": "When the members are wrong at different times: one member's bad exit is diluted by the others.",
        "whenItLoses": "Strong bull markets, where every member holds less than buy and hold; and the members were "
                       "chosen on the same history, so their past edge is partly selection.",
    }
