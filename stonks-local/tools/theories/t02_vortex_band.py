"""t02: a hysteresis band on the Vortex crossover cuts whipsaw trades without costing return (BTC 4h)."""
from _harness import Theory, Variant, ret, run, trades

BTC = {"markets": ["BTC-EUR"], "interval": "4h"}


def verdict(r):
    a, b = r["band_0.00"], r["band_0.05"]
    ok = trades(b) <= 0.6 * trades(a) and ret(b) >= ret(a)
    return ok, f"trades {trades(a)} -> {trades(b)}, return {ret(a):+.0f} % -> {ret(b):+.0f} %"


THEORY = Theory(
    name="t02_vortex_band",
    hypothesis="On BTC 4h a Vortex band of 0.05 cuts the number of trades by at least 40 % versus no band, and the "
               "return does not drop.",
    variants=[Variant(f"band_{b:.2f}", {"family": "vortex_trend", **BTC, "params": {"n": 28, "band": b}})
              for b in (0.0, 0.02, 0.05, 0.10)],
    verdict=verdict,
    tags=["trend", "fees"],
)

if __name__ == "__main__":
    run(THEORY)
