"""t06: what Elder impulse should do on mixed (blue) bars on BTC 1d."""
from _harness import Theory, Variant, ret, run, sharpe, trades

BTC = {"markets": ["BTC-EUR"], "interval": "1d"}


def verdict(r):
    h, c = r["blue_hold"], r["blue_cash"]
    ok = ret(h) > ret(c) and trades(h) < trades(c)
    return ok, ", ".join(f"{k} {ret(v):+.0f} % / {trades(v)} trades / Sharpe {sharpe(v):.2f}" for k, v in r.items())


THEORY = Theory(
    name="t06_elder_blue",
    hypothesis="On BTC 1d, holding through Elder 'blue' bars beats selling on them (fewer trades, more return).",
    variants=[Variant(f"blue_{b}", {"family": "elder_impulse", **BTC, "params": {"emaN": 13, "blue": b}})
              for b in ("hold", "half", "cash")]
    + [Variant("blue_hold_ema34", {"family": "elder_impulse", **BTC, "params": {"emaN": 34, "blue": "hold"}})],
    verdict=verdict,
    tags=["trend"],
)

if __name__ == "__main__":
    run(THEORY)
