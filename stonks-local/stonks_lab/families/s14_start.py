"""s14_start: the Session 14 template, the live book unchanged. Copy it and change what your idea needs."""
from __future__ import annotations

from ._base import frame, market_names, max_weight, single_market
from ._s14_core import book

NAME = "s14_start"
VERSION = 1
TITLE = "Live book"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {}


def param_space() -> dict:
    return {}


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return 0


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    return frame(df.index, {m: book(df) * max_weight(spec)})


def explain(spec) -> dict:
    mk = market_names(spec)
    return {
        "summary": f"Bitcoin bull, cycle check on {mk} with the crash buy time stop, as the bot runs it.",
        "howItWorks": ["The main strategy decides.", "Crash buys that do not bounce within six hours are sold."],
        "whenItWins": "Trends and panic bounces.",
        "whenItLoses": "Sideways markets.",
        "vsBuyHold": "Beats holding by staying out of most falls.",
    }
