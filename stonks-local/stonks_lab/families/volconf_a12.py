"""volconf_a12 v1 (agent-12): volume-confirmed moves (Campbell-Grossman-Wang): high-volume moves continue,
low-volume moves revert.

Unrecorded pre-holdout study (finding by agent-12, round 7): in a within-year regression of the forward 10-day ETH
return on the day's vol-scaled return z, its EUR-turnover surprise v and z*v, the interaction is positive in 6 of
7 years (big moves on unusual volume continue, quiet moves fade); on BTC it is mixed. This family trades that
interaction. Per market, on its own candles (decision at bar t uses candles up to and including t):

- z_t = log return / std of the previous ``volLen`` log returns (clipped to +-4);
- v_t = ln(EUR turnover_t) - median ln(EUR turnover) of the previous ``volLen`` bars (clipped to +-3);
- weighting "surprise": x_t = z_t * v_t (an up move on low volume counts as bearish); "none": x_t = z_t (plain
  vol-scaled momentum, the ablation twin);
- S_t = mean of x over the last ``sumLen`` bars; signal on when S_t > ``enter``, off when S_t < ``enter`` -
  ``band`` (hysteresis);
- optional SMA core (``coreSma`` > 0): combine "alone" ignores it, "or" holds while the core OR the signal is on,
  "and" while both are on.

Multi-market: maxWeight / len(markets) each.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "volconf_a12"
VERSION = 1
TITLE = "Volume-confirmed moves"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"volLen": 30, "sumLen": 10, "enter": 0.0, "band": 0.1, "weighting": "surprise", "coreSma": 0,
            "combine": "alone"}


def param_space() -> dict:
    return {
        "volLen": {"type": "int", "min": 10, "max": 200, "log": True,
                   "description": "candles behind the normal volatility and the normal (median) euro turnover"},
        "sumLen": {"type": "int", "min": 1, "max": 90, "log": True,
                   "description": "candles over which the volume-weighted moves are averaged"},
        "enter": {"type": "float", "min": -0.5, "max": 0.5,
                  "description": "the averaged signal must rise above this to buy"},
        "band": {"type": "float", "min": 0.02, "max": 0.8, "log": True, "zero": True,
                 "description": "sell only once the signal is this far under the buy level (hysteresis)"},
        "weighting": {"type": "choice", "values": ["surprise", "none"],
                      "description": "surprise = weight each move by its unusual turnover; none = plain momentum "
                                     "(the comparison twin)"},
        "coreSma": {"type": "int", "min": 20, "max": 300, "log": True, "zero": True,
                    "description": "optional trend core: close above this SMA (0 = none)"},
        "combine": {"type": "choice", "values": ["alone", "or", "and"],
                    "description": "how the signal combines with the trend core"},
    }


def valid_params(p: dict) -> str | None:
    if int(p.get("coreSma") or 0) == 0 and p.get("combine", "alone") != "alone":
        return "combine needs coreSma > 0"
    if int(p.get("coreSma") or 0) > 0 and p.get("combine", "alone") == "alone":
        return "coreSma is unused with combine alone"
    return None


def warmup(p: dict) -> int:
    return max(int(p["volLen"]) + int(p["sumLen"]) + 1, int(p.get("coreSma") or 0))


def _trailing_median(x: np.ndarray, n: int) -> np.ndarray:
    """Median of the n values BEFORE each bar (x[t-n..t-1])."""
    out = np.full(len(x), np.nan)
    if len(x) <= n:
        return out
    w = np.lib.stride_tricks.sliding_window_view(x, n)[:-1]   # windows ending at t-1 for t = n..len-1
    out[n:] = np.median(w, axis=1)
    return out


def _trailing_std(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if len(x) <= n:
        return out
    w = np.lib.stride_tricks.sliding_window_view(x, n)[:-1]
    out[n:] = w.std(axis=1, ddof=1)
    return out


def signal(c: np.ndarray, vol: np.ndarray, p: dict) -> np.ndarray:
    n = len(c)
    vl, sl = int(p["volLen"]), int(p["sumLen"])
    r = np.full(n, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        if n > 1:
            r[1:] = np.log(c[1:] / c[:-1])
        lt = np.log(np.maximum(vol * c, 1.0))
    rr = np.where(np.isfinite(r), r, 0.0)
    sd = _trailing_std(rr, vl)
    sd[:vl + 1] = np.nan                                   # r[0] is not a return
    with np.errstate(divide="ignore", invalid="ignore"):
        z = np.clip(r / sd, -4.0, 4.0)
    if p.get("weighting", "surprise") == "surprise":
        v = np.clip(lt - _trailing_median(lt, vl), -3.0, 3.0)
        x = z * v
    else:
        x = z
    s = ind.sma(np.where(np.isfinite(x), x, np.nan), sl) if np.isfinite(x).any() else np.full(n, np.nan)
    return s


def weights(c: np.ndarray, vol: np.ndarray, p: dict) -> np.ndarray:
    n = len(c)
    s = signal(c, vol, p)
    enter = float(p["enter"])
    lo = enter - float(p.get("band") or 0.0)
    sig = np.full(n, np.nan)
    on = False
    for t in range(n):
        if not np.isfinite(s[t]):
            continue
        if on and s[t] < lo - 1e-12:
            on = False
        elif not on and s[t] > enter + 1e-12:
            on = True
        sig[t] = 1.0 if on else 0.0
    cs = int(p.get("coreSma") or 0)
    mode = p.get("combine", "alone")
    if cs <= 0 or mode == "alone":
        return sig
    sm = ind.sma(c, cs)
    core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    ok = np.isfinite(core) & np.isfinite(sig)
    out = np.full(n, np.nan)
    out[ok] = np.maximum(core[ok], sig[ok]) if mode == "or" else np.minimum(core[ok], sig[ok])
    return out


def _asof(src_index: np.ndarray, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    pos = np.searchsorted(src_index, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = values[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("volconf_a12 needs at least one market")
    idx = union_index(candles, markets)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        mi = np.asarray(df.index, dtype=np.int64)
        w = weights(df["close"].to_numpy(np.float64), df["volume"].to_numpy(np.float64), p)
        cols[m] = _asof(mi, w, idx) * each
    out = frame(idx, cols)
    if len(markets) > 1:
        any_ok = out.notna().any(axis=1).to_numpy()
        out = out.fillna(0.0)
        out[~any_ok] = np.nan
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    if p.get("weighting", "surprise") == "surprise":
        what = ("every candle's move (scaled by the normal volatility) times how unusual its euro turnover was "
                f"compared with the last {bars_text(p['volLen'], iv)}: a rise on heavy trading counts as bullish, a "
                "rise on thin trading as bearish, and the other way round for falls")
    else:
        what = f"every candle's move scaled by the normal volatility of the last {bars_text(p['volLen'], iv)}"
    steps = [
        f"It averages {what}, over the last {bars_text(p['sumLen'], iv)}.",
        f"It buys {mk} when that average rises above {float(p['enter']):+.2f} and sells once it drops "
        f"{float(p.get('band') or 0.0):.2f} below that.",
    ]
    cs = int(p.get("coreSma") or 0)
    if cs > 0 and p.get("combine") == "or":
        steps.append(f"It also holds whenever the close is above its {bars_text(cs, iv)} average.")
    elif cs > 0 and p.get("combine") == "and":
        steps.append(f"It only holds while the close is also above its {bars_text(cs, iv)} average.")
    else:
        steps.append("Otherwise it waits in euros.")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"Each of {mk} is handled on its own with an equal share of the money.")
    steps += risk_steps(spec)
    return {
        "summary": f"Holds {mk} while recent moves are confirmed by heavy trading (big-volume rises, quiet dips).",
        "howItWorks": steps,
        "whenItWins": "Trends that run on heavy volume and quiet pullbacks inside them.",
        "whenItLoses": "Volume spikes at turning points (capitulation or blow-off days) and quiet grinding trends.",
    }
