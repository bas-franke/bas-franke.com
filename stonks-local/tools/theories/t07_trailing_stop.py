"""t07: does a trailing stop help a slow trend follower (aroon_trend, BTC 1d)?"""
from _harness import Theory, Variant, dd, ret, run

BTC = {"markets": ["BTC-EUR"], "interval": "1d"}
P = {"n": 25}


def verdict(r):
    base = r["no_stop"]
    ok = [k for k in ("trail_10", "trail_15") if dd(r[k]) <= dd(base) - 5 and ret(r[k]) >= 0.8 * ret(base)]
    return bool(ok), f"passing: {', '.join(ok) or 'none'}; " + ", ".join(
        f"{k} {ret(v):+.0f} %/DD {dd(v):.0f} %" for k, v in r.items())


THEORY = Theory(
    name="t07_trailing_stop",
    hypothesis="A 10-15 % trailing stop on aroon_trend (BTC 1d) lowers max drawdown by 5+ points while keeping 80 % "
               "of the return.",
    variants=[Variant("no_stop", {"family": "aroon_trend", **BTC, "params": P})]
    + [Variant(f"trail_{round(t * 100)}", {"family": "aroon_trend", **BTC, "params": P,
                                           "risk": {"trailingStopPct": t}}) for t in (0.08, 0.10, 0.15, 0.20)],
    verdict=verdict,
    tags=["risk", "trend"],
)

if __name__ == "__main__":
    run(THEORY)
