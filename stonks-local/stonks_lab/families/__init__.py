"""Strategy family registry.

``FAMILIES`` maps family name -> :class:`Family`. The seven v1 families (SPEC §3) are bot-ready: the TypeScript bot
implements them and parity fixtures prove both sides agree.

Adding a family (research agents): create ``stonks_lab/families/<name>.py`` defining

    NAME = "my_family"            # unique, snake_case
    VERSION = 1                   # bump when the logic changes
    TITLE = "Plain title"
    MULTI_MARKET = False          # True when it can hold several markets at once
    ANCHORED = False              # True when targets depend on where trading starts (gets start_time)
    def default_params() -> dict
    def param_space() -> dict     # see _base.py for the descriptor format
    def valid_params(p) -> str | None   # optional: cross-param constraints, None = ok
    def warmup(p) -> int          # optional: bars before the first decision
    def targets(candles, spec, start_time=None) -> DataFrame   # index ts (int64 ms), one column per spec market,
                                  # weight 0..maxWeight decided at that bar's close, NaN = no decision yet
    def explain(spec) -> dict     # summary, howItWorks[], whenItWins, whenItLoses
    INVALID_BELOW_VERSION = 2     # optional: older versions had a confirmed bug (look-ahead); their rows are ignored

It is picked up automatically, and the bot can trade it once it is pushed: the deploy ships the families to the server,
where ``stonks_lab/live.py`` runs them for live signals (stonks/SPEC.md §6b). A family module must therefore only
import numpy, pandas and ``_base``/``indicators``/``data``/``universe``/sibling families, never the backtester or the
registry. BOT_READY (default False) only marks the families with a TypeScript port and a parity fixture. ``register_family(module_or_family)`` registers one
explicitly (e.g. from a notebook). Never use data after bar t when deciding at bar t: tests/test_families.py has a
generic no-look-ahead check that runs on every registered family.
"""
from __future__ import annotations

import importlib
import pkgutil
import types
import warnings
from typing import Any

from ._base import (DEFAULT_EXECUTION, DEFAULT_RISK, INTERVALS, Family, check_space, normalize_spec,
                    sample_params)

__all__ = ["FAMILIES", "V1_FAMILIES", "Family", "register_family", "get_family", "normalize_spec",
           "DEFAULT_RISK", "DEFAULT_EXECUTION", "INTERVALS", "sample_params", "check_space", "discover"]

V1_FAMILIES = ["ema_cross", "macd_trend", "donchian_breakout", "rsi_dip", "bollinger_reversion", "dca_dip",
               "rotation_momentum"]

FAMILIES: dict[str, Family] = {}
DISCOVERY_ERRORS: dict[str, str] = {}


def register_family(obj: Any, *, bot_ready: bool | None = None, replace: bool = True) -> Family:
    """Register a family module (see module docstring) or a ready :class:`Family`. Returns the Family."""
    if isinstance(obj, Family):
        fam = obj
    elif isinstance(obj, types.ModuleType) or hasattr(obj, "NAME"):
        m = obj
        fam = Family(
            name=m.NAME,
            version=int(getattr(m, "VERSION", 1)),
            title=getattr(m, "TITLE", m.NAME),
            targets=m.targets,
            param_space=m.param_space,
            default_params=m.default_params,
            explain=m.explain,
            valid_params=getattr(m, "valid_params", lambda p: None),
            warmup=getattr(m, "warmup", lambda p: 0),
            required_markets=getattr(m, "required_markets", None),
            bot_ready=bool(getattr(m, "BOT_READY", False)),
            multi_market=bool(getattr(m, "MULTI_MARKET", False)),
            anchored=bool(getattr(m, "ANCHORED", False)),
            invalid_below=int(getattr(m, "INVALID_BELOW_VERSION", 1)),
            module=m,
        )
    else:
        raise TypeError("register_family expects a family module or a Family")
    if bot_ready is not None:
        fam.bot_ready = bool(bot_ready)
    if fam.name in FAMILIES and not replace:
        raise ValueError(f"family {fam.name} already registered")
    FAMILIES[fam.name] = fam
    return fam


def get_family(name: str) -> Family:
    try:
        return FAMILIES[name]
    except KeyError:
        discover()
        if name in FAMILIES:
            return FAMILIES[name]
        raise KeyError(f"unknown family {name!r}; known: {sorted(FAMILIES)}") from None


def discover() -> list[str]:
    """Import every module in this package that defines NAME and register it. Returns the names found."""
    found = []
    for info in pkgutil.iter_modules(__path__):
        if info.name.startswith("_"):
            continue
        try:
            mod = importlib.import_module(f"{__name__}.{info.name}")
        except Exception as e:  # noqa: BLE001 - one broken research module must not take the lab down
            DISCOVERY_ERRORS[info.name] = f"{type(e).__name__}: {e}"
            warnings.warn(f"family module {info.name} failed to import: {e}")
            continue
        DISCOVERY_ERRORS.pop(info.name, None)
        if hasattr(mod, "NAME") and hasattr(mod, "targets"):
            if mod.NAME not in FAMILIES or FAMILIES[mod.NAME].module is not mod:
                register_family(mod)
            found.append(mod.NAME)
    return found


discover()
