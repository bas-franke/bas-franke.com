"""Live signals for the bot (stonks/SPEC.md §6b): the one part of the lab that is deployed to the server.

The TypeScript bot calls this for every family it has no TypeScript port of, so any family the lab can backtest can
also trade, with the exact same code on the same kind of data. It only ever decides target weights for the bar that
just closed: no backtests, scoring, searches or registry. The deploy ships this file with ``families/``,
``indicators.py``, ``data.py`` and ``universe.py`` (and nothing else of the lab).

    python -m stonks_lab.live catalog          # every family with its params, as JSON (written at deploy)
    python -m stonks_lab.live describe < in    # {"spec"} -> markets it reads, param error, explanation
    python -m stonks_lab.live prepare < in     # {"spec"} -> downloads the full candle history it needs (slow, once)
    python -m stonks_lab.live targets < in     # {"spec", "bar", "startTime"?} -> weights decided at ``bar``

Backtests see every candle since the listing, and some families depend on all of it (expanding fits, placebo
draws, state machines), so live decisions use the same history: ``data.py`` keeps it in ``STONKS_DATA_DIR`` on the
server, ``prepare`` backfills it once per market and interval (1m: the last ``DEFAULT_1M_DAYS`` days, like the lab)
and ``targets`` only fetches the newest closed bars. Until ``prepare`` has finished, ``targets`` answers
``{"warming": [...]}`` straight away. Families that read other candles from disk (e.g. daily candles of a coin pool)
get them the same way on first use. Answers are one JSON object on stdout; failures are ``{"error": "..."}`` with
exit code 1.
"""
from __future__ import annotations

import contextlib
import importlib
import io
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import data
from .families import FAMILIES, Family, discover, normalize_spec, register_family

_PARAM_TYPES = {"int": "int", "float": "number", "bool": "boolean", "choice": "choice"}
LOCK_STALE_S = 3 * 3600


def _family(name: str) -> Family:
    if name in FAMILIES:
        return FAMILIES[name]
    if not name.replace("_", "").isalnum():
        raise KeyError(f"unknown family {name!r}")
    try:
        mod = importlib.import_module(f"{__package__}.families.{name}")
    except ModuleNotFoundError:
        raise KeyError(f"unknown family {name!r}") from None
    if getattr(mod, "NAME", None) != name:
        raise KeyError(f"unknown family {name!r}")
    return register_family(mod)


def _jsonable(v: Any) -> Any:
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.floating):
        return float(v)
    return v


def param_info(name: str, d: dict, default: Any) -> dict:
    """One param in the bot's ParamInfo shape; ``zero`` means 0 is allowed outside min..max (switches it off)."""
    out: dict[str, Any] = {"name": name, "type": _PARAM_TYPES[d["type"]], "default": _jsonable(default),
                           "description": d.get("description", "")}
    if d["type"] in ("int", "float"):
        out["min"], out["max"] = _jsonable(d["min"]), _jsonable(d["max"])
        if d.get("zero"):
            out["zero"] = True
    if d["type"] == "choice":
        out["options"] = [_jsonable(v) for v in d["values"]]
    return out


def catalog() -> dict:
    discover()
    from .families import DISCOVERY_ERRORS
    out = []
    for fam in sorted(FAMILIES.values(), key=lambda f: f.name):
        defaults = fam.default_params()
        try:
            summary = str(fam.explain({"family": fam.name, "markets": ["BTC-EUR"], "interval": "1d",
                                       "params": defaults}).get("summary", ""))
        except Exception:  # noqa: BLE001 - an explanation is optional
            summary = ""
        space = fam.param_space()
        out.append({"family": fam.name, "title": fam.title, "summary": summary, "version": fam.version,
                    "multiMarket": fam.multi_market, "anchored": fam.anchored,
                    "params": [param_info(k, d, defaults.get(k)) for k, d in space.items()],
                    # knobs outside the search space that hold a JSON object, e.g. the lead a wrapper runs
                    # ("inner" of mtf_guard_a24/step_wrap_a24/floor_wrap_a07); the lab checks them in describe
                    "objectParams": [{"name": k, "default": v} for k, v in defaults.items()
                                     if k not in space and isinstance(v, dict)]})
    return {"families": out, "errors": dict(DISCOVERY_ERRORS)}


def _spec(raw: dict) -> tuple[Family, dict]:
    fam = _family(str(raw.get("family")))
    if int(raw.get("familyVersion", fam.version)) != fam.version:
        raise ValueError(f"{fam.name} version {raw.get('familyVersion')} is not supported, the server runs "
                         f"version {fam.version}")
    return fam, normalize_spec(raw, fam)


def explanation(fam: Family, spec: dict) -> str:
    try:
        e = fam.explain(spec) or {}
    except Exception:  # noqa: BLE001
        return ""
    parts = [str(e.get("summary") or "")] + [str(x) for x in (e.get("howItWorks") or [])]
    return " ".join(p.strip() for p in parts if p and p.strip())


def describe(raw: dict) -> dict:
    fam, spec = _spec(raw)
    return {"family": fam.name, "version": fam.version, "error": fam.validate(spec),
            "markets": fam.markets_needed(spec), "anchored": fam.anchored, "explanation": explanation(fam, spec)}


# --------------------------------------------------------------------------------------------- candle history

def _since(interval: str, now: int) -> int | None:
    return now - data.DEFAULT_1M_DAYS * data.DAY if interval == "1m" else None


def _ready_path() -> Path:
    return data.DATA_DIR / "live_ready.json"


def _ready() -> set[str]:
    try:
        return set(json.loads(_ready_path().read_text(encoding="utf8")))
    except (OSError, ValueError):
        return set()


def _mark_ready(keys: set[str]) -> None:
    p = _ready_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(sorted(_ready() | keys)), encoding="utf8")
    os.replace(tmp, p)


def _keys(fam: Family, spec: dict) -> list[str]:
    return [f"{m} {spec['interval']}" for m in fam.markets_needed(spec)]


_client: data.BitvavoClient | None = None


def _update(market: str, interval: str) -> None:
    """Fetches what is missing of one market+interval; an unlisted market just has no candles (as in the lab)."""
    global _client
    _client = _client or data.BitvavoClient()
    now = data.now_ms()
    try:
        data.update_market(_client, market, interval, since=_since(interval, now), now=now, progress=lambda *_: None)
    except Exception as e:  # noqa: BLE001
        print(f"live data: {market} {interval}: {type(e).__name__}: {e}", file=sys.stderr)


@contextlib.contextmanager
def _prepare_lock():
    p = data.DATA_DIR / "live_prepare.lock"
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists() and time.time() - p.stat().st_mtime > LOCK_STALE_S:
        p.unlink(missing_ok=True)
    try:
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        yield False
        return
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield True
    finally:
        p.unlink(missing_ok=True)


def prepare(raw: dict) -> dict:
    fam, spec = _spec(raw["spec"])
    with _prepare_lock() as mine:
        if not mine:
            return {"busy": True}
        done = _ready()
        for key in _keys(fam, spec):
            if key not in done:
                m, iv = key.split(" ")
                _update(m, iv)
                _mark_ready({key})
    return {"ready": True}


def use_live_data() -> None:
    """Candles a family reads from disk itself are brought up to date once per process before they are read."""
    original = data.candle_path
    fresh: set[tuple[str, str]] = set()
    busy = False

    def candle_path(market: str, interval: str):
        nonlocal busy
        if not busy and (market, interval) not in fresh:
            fresh.add((market, interval))
            busy = True
            try:
                _update(market, interval)
            finally:
                busy = False
        return original(market, interval)

    data.candle_path = candle_path


def targets(raw: dict) -> dict:
    fam, spec = _spec(raw["spec"])
    err = fam.validate(spec)
    if err:
        raise ValueError(err)
    keys = _keys(fam, spec)
    done = _ready()
    warming = [k for k in keys if k not in done]
    if warming:
        return {"warming": warming}
    interval = spec["interval"]
    bar = int(raw["bar"])
    end = bar + data.INTERVAL_MS[interval]  # the bot's bar is the newest one decided on, even if another closed since
    candles = {}
    for key in keys:
        m = key.split(" ")[0]
        _update(m, interval)
        try:
            candles[m] = data.load_candles(m, interval, end=end)
        except FileNotFoundError:
            candles[m] = data.empty_frame()
    use_live_data()
    start = raw.get("startTime")
    t = fam.targets(candles, spec, start_time=int(start)) if start is not None else fam.targets(candles, spec)
    if t is None or len(t) == 0:
        return {"t": None, "weights": {m: 0.0 for m in spec["markets"]}}
    row = t.iloc[-1]
    w = {}
    for m in spec["markets"]:
        v = float(row[m]) if m in t.columns else 0.0
        w[m] = v if math.isfinite(v) and v > 0 else 0.0  # NaN = no decision yet = out (SPEC §3)
    return {"t": int(t.index[-1]), "weights": w}


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else ""
    try:
        if cmd == "catalog":
            out = catalog()
        elif cmd in ("describe", "prepare", "targets"):
            raw = json.load(sys.stdin)
            # family code may print; stdout carries only the answer
            with contextlib.redirect_stdout(io.StringIO()):
                out = {"describe": lambda: describe(raw["spec"]), "prepare": lambda: prepare(raw),
                       "targets": lambda: targets(raw)}[cmd]()
        else:
            raise ValueError("usage: python -m stonks_lab.live catalog|describe|prepare|targets")
    except Exception as e:  # noqa: BLE001
        json.dump({"error": f"{type(e).__name__}: {e}"}, sys.stdout)
        return 1
    json.dump(out, sys.stdout, separators=(",", ":"), allow_nan=False)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
