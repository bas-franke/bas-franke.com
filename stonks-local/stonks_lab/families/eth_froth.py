"""eth_froth v1 (agent-11): hold BTC/ETH, step aside while ETH spikes far ahead of BTC (an ETH/BTC-ratio blow-off).

Signal ("lead"): ETH-EUR's log return over `lookback` candles minus BTC-EUR's (= the change of ln(ETH/BTC)). Unlike
ratio_gate (holds a coin while the ratio TRENDS up), a sharp ETH/BTC spike is read as euphoria: speculative money
rotating out of BTC into the next-riskiest coin, which tends to happen near local tops.

Exit rule (`mode`):
  - eth: out once lead > threshold; back in once lead < threshold - band (BTC/ETH data only, no altcoin pool).
  - and: out once lead > threshold AND alt_froth's old-alt lead over `altLookback` > altThreshold; back in when that
         joint condition (with the band on the ETH lead) clears.
  - or:  out on either signal; back in when neither holds.
After an exit it stays out at least `minOut` candles. Otherwise every traded market holds maxWeight / markets.

Signal study (agent-11, 1d 2019-03..2025-10, gross, overlapping 30-day forward log returns): ETH 30-day lead in the
top quintile -> BTC -5.6 %, ETH -5.5 % next 30 d vs +4..+7 % in the other quintiles. Lead > 0.2: BTC -8.6 % (n=244,
19 episodes). It is mostly the alt_froth signal in disguise: lead > 0.2 without old-alt froth (lb120 > 0.1) was
+4 % (n=116); with it strongly negative. Volume surges, up-day streaks and volatility compression were NOT bearish
(momentum: top quintile +8..+22 %), so they are not in this family. Decisions at bar t use candles up to t only.
"""
from __future__ import annotations

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .alt_froth import OLD_ALTS, _asof, _logret, froth

NAME = "eth_froth"
VERSION = 1
TITLE = "ETH/BTC spike exit"
BOT_READY = False
MULTI_MARKET = True
BTC, ETH = "BTC-EUR", "ETH-EUR"
MODES = ["eth", "and", "or"]


def default_params() -> dict:
    return {"lookback": 30, "threshold": 0.2, "band": 0.1, "mode": "eth", "altLookback": 120, "altThreshold": 0.1,
            "minOut": 0}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 5, "max": 200, "log": True,
                     "description": "candles over which ETH's return is compared with BTC's"},
        "threshold": {"type": "float", "min": 0.02, "max": 0.6,
                      "description": "sell when ETH beats BTC by more than this log return"},
        "band": {"type": "float", "min": 0.0, "max": 0.4,
                 "description": "buy back once ETH's lead is under threshold minus this"},
        "mode": {"type": "choice", "values": MODES,
                 "description": "eth: ETH/BTC spike alone; and: also old altcoins ahead of BTC; or: either"},
        "altLookback": {"type": "int", "min": 10, "max": 400, "log": True,
                        "description": "candles for the old-altcoin lead over BTC (and/or modes)"},
        "altThreshold": {"type": "float", "min": 0.0, "max": 0.6,
                         "description": "old altcoins beat BTC by more than this log return (and/or modes)"},
        "minOut": {"type": "int", "min": 1, "max": 200, "zero": True, "log": True,
                   "description": "stay out at least this many candles after an exit (0 = no minimum)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["band"]) > float(p["threshold"]) + 0.2:
        return "band far above threshold: the exit would hardly ever end"
    return None


def warmup(p: dict) -> int:
    w = int(p["lookback"])
    if p.get("mode", "eth") != "eth":
        w = max(w, int(p["altLookback"]))
    return w


def required_markets(spec: dict) -> list[str]:
    if spec.get("params", {}).get("mode", "eth") == "eth":
        return [BTC, ETH]
    return [BTC, ETH, *OLD_ALTS]


def eth_lead(candles: dict, lookback: int, idx: np.ndarray) -> np.ndarray:
    """ETH's lookback log return minus BTC's, aligned as of each idx time (NaN until both have history)."""
    if any(m not in candles or len(candles[m]) == 0 for m in (BTC, ETH)):
        return np.full(len(idx), np.nan)
    e = _asof(candles[ETH], _logret(candles[ETH], lookback), idx)
    b = _asof(candles[BTC], _logret(candles[BTC], lookback), idx)
    return e - b


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    mode = p["mode"]
    lead = eth_lead(candles, int(p["lookback"]), idx)
    thr, band, min_out = float(p["threshold"]), float(p["band"]), int(p.get("minOut") or 0)
    if mode == "eth":
        alt = np.zeros(n)
        valid = np.isfinite(lead)
    else:
        alt = froth(candles, int(p["altLookback"]), idx)
        valid = np.isfinite(lead) & np.isfinite(alt)
    lead0 = np.nan_to_num(lead, nan=-np.inf)
    alt_hot = np.nan_to_num(alt, nan=-np.inf) > float(p["altThreshold"])
    enter_eth, stay_eth = lead0 > thr, lead0 > thr - band
    if mode == "eth":
        enter, stay = enter_eth, stay_eth
    elif mode == "and":
        enter, stay = enter_eth & alt_hot, stay_eth & alt_hot
    else:
        enter, stay = enter_eth | alt_hot, stay_eth | alt_hot
    each = max_weight(spec) / len(markets)
    state = np.full(n, np.nan)
    out_, since = False, 0
    for i in range(n):
        if not valid[i]:
            continue
        if out_:
            since += 1
            if not stay[i] and since >= min_out:
                out_ = False
        elif enter[i]:
            out_, since = True, 0
        state[i] = 0.0 if out_ else 1.0
    cols = {}
    for m in markets:
        listed = _asof(candles[m], np.ones(len(candles[m])), idx)
        cols[m] = state * listed * each
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    mode = p["mode"]
    thr, band = float(p["threshold"]), float(p["band"])
    eth_txt = (f"Ethereum has beaten Bitcoin by more than {pct(np.expm1(thr))} over the last "
               f"{bars_text(p['lookback'], iv)}")
    alt_txt = (f"nine altcoins already traded in 2019 (XRP, ADA, LINK, TRX, LTC, BCH, XLM, XTZ, IOTA) are ahead of "
               f"Bitcoin by more than {pct(np.expm1(float(p['altThreshold'])))} over {bars_text(p['altLookback'], iv)}")
    rule = {"eth": f"When {eth_txt}, ",
            "and": f"When {eth_txt} and at the same time {alt_txt}, ",
            "or": f"When {eth_txt}, or when {alt_txt}, "}[mode]
    steps = [
        f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
        rule + "speculative money is rushing out of Bitcoin into riskier coins, which tends to happen near a top: "
               "it sells everything and waits in euros.",
        f"It buys back once Ethereum's lead has shrunk below {pct(np.expm1(thr - band))}"
        + (" (and the altcoin signal has cooled)" if mode != "eth" else "")
        + (f" and at least {bars_text(p['minOut'], iv)} have passed." if int(p.get('minOut') or 0) else "."),
    ]
    return {
        "summary": f"Holds {mk}, but sells while Ethereum spikes far ahead of Bitcoin (a sign of a frothy top).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Speculative blow-offs where money chases Ethereum and altcoins just before a crash.",
        "whenItLoses": "Lasting Ethereum-led bull runs (it waits in euros while prices keep rising) and slow bear "
                       "markets without a spike (it never sells).",
    }
