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
and ``targets`` only fetches the newest closed bars, plus the last stored ones again (a bar stored seconds after its
close can still change). Families that read other candles from disk (e.g. 1h candles of a coin pool) get them the
same way: ``prepare`` runs the family once, so ``targets`` never has to download history. Until ``prepare`` has
really got everything, ``targets`` answers ``{"warming": [...]}`` straight away.

``targets`` answers ``{"hold": "<reason>", "t": <ms|null>}`` when it has no trustworthy decision, and the bot then
keeps its positions: no candles or no targets, an all-NaN row (the backtest's "no decision, keep", see
``backtest.clean_weights``) or candles it read that are too old. ``prepare`` answers ``{"ready": true}``,
``{"busy": true}`` (another prepare holds the lock, nothing was checked) or ``{"ready": false, "failed": {...}}``, and
the next prepare tries what failed again. Answers are one JSON object on stdout; failures are ``{"error": "..."}`` with
exit code 1.
"""
from __future__ import annotations

import ast
import contextlib
import hashlib
import importlib
import io
import json
import math
import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import data
from .families import FAMILIES, Family, discover, normalize_spec, register_family

_PARAM_TYPES = {"int": "int", "float": "number", "bool": "boolean", "choice": "choice"}
# A running prepare touches its lock every minute, however long it takes (python.ts allows it hours), so the lock only
# goes stale when that process died: a few missed beats are enough.
LOCK_BEAT_S = 60
LOCK_STALE_S = 15 * 60
REFETCH_BARS = 2          # newest stored bars fetched again on every update, see data.update_market
STALE_GRACE_MS = 5 * data.MINUTE
TARGETS_BUDGET_S = 60     # ``targets`` stops fetching after this: python.ts kills it at 120 s, and a hold beats a kill
CORE_MARKETS = ("BTC-EUR", "ETH-EUR")   # never excused as delisted, see _stale


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
                    "codeHash": code_hash(fam), "multiMarket": fam.multi_market, "anchored": fam.anchored,
                    "params": [param_info(k, d, defaults.get(k)) for k, d in space.items()],
                    # knobs outside the search space that hold a JSON object, e.g. the lead a wrapper runs
                    # ("inner" of mtf_guard_a24/step_wrap_a24/floor_wrap_a07); the lab checks them in describe
                    "objectParams": [{"name": k, "default": v} for k, v in defaults.items()
                                     if k not in space and isinstance(v, dict)]})
    return {"families": out, "errors": dict(DISCOVERY_ERRORS)}


# ------------------------------------------------------------------------------------------------- code hash
#
# A family's decisions can change without a VERSION bump when its code or a module it imports changes; ``codeHash`` in
# the catalog lets the bot notice. It hashes source text (line endings normalised), so every machine gets the same
# answer. Wrappers run a family named in their params through ``get_family``: that one is not part of the wrapper's
# hash, see codeHashOf in python.ts.

_LAB_ROOT = Path(__file__).resolve().parent
_ALWAYS_HASHED = ("data.py", "indicators.py", "families/_base.py", "families/_ta.py")
_module_imports: dict[Path, list[Path]] = {}


def _imports(path: Path) -> list[Path]:
    """The lab source files ``path`` imports directly."""
    hit = _module_imports.get(path)
    if hit is not None:
        return hit
    found: list[Path] = []
    for node in ast.walk(ast.parse(path.read_bytes())):
        if not isinstance(node, ast.ImportFrom) or node.level < 1:
            continue
        base = path.parents[node.level - 1]
        if node.module:
            found.append(base.joinpath(*node.module.split(".")).with_suffix(".py"))
        else:
            found += [base / f"{a.name}.py" for a in node.names]
    found = sorted({f for f in found if f.is_file() and f.is_relative_to(_LAB_ROOT)})
    _module_imports[path] = found
    return found


def code_hash(fam: Family) -> str:
    """sha256 over the family's file, all it imports from the lab (recursively) and the shared modules."""
    todo = [p for p in (_LAB_ROOT / n for n in _ALWAYS_HASHED) if p.is_file()]
    if getattr(fam.module, "__file__", None):
        todo.append(Path(fam.module.__file__).resolve())
    seen: set[Path] = set()
    while todo:
        f = todo.pop()
        if f not in seen:
            seen.add(f)
            if f.is_relative_to(_LAB_ROOT):
                todo += _imports(f)
    h = hashlib.sha256()
    for f in sorted(seen, key=lambda p: p.as_posix()):
        name = f.relative_to(_LAB_ROOT).as_posix() if f.is_relative_to(_LAB_ROOT) else f.name
        h.update(name.encode() + b"\0" + f.read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


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
    # v2: the first file also listed markets whose download had failed, so everything is checked once more
    return data.DATA_DIR / "live_ready_v2.json"


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


def _warm_key(fam: Family, spec: dict) -> str:
    """Ready key of "the family ran once and got all it reads": per spec and per code, as either can read more."""
    what = {k: spec.get(k) for k in ("markets", "interval", "params", "universe")}
    digest = hashlib.sha256(json.dumps(what, sort_keys=True, default=str).encode()).hexdigest()[:16]
    return f"reads {fam.name} {digest} {code_hash(fam)[:16]}"


_client: data.BitvavoClient | None = None
_deadline: float | None = None  # time.monotonic() after which no more candles are fetched (only during ``targets``)


@dataclass
class Read:
    """How updating one market+interval went: ``failed`` is the error, ``unlisted`` means Bitvavo has no such market."""
    failed: str | None = None
    unlisted: bool = False


class _OnDeadline:
    """The candle source of an update: stops mid-download at the deadline (partial saves stay on disk)."""

    def __init__(self, source: Any):
        self.source = source

    def get_candles(self, market: str, interval: str, start: int, end: int, limit: int) -> list[list[Any]]:
        if _deadline is not None and time.monotonic() > _deadline:
            raise TimeoutError("out of time for this decision")
        return self.source.get_candles(market, interval, start, end, limit)


def _patience(quick: bool) -> None:
    """``prepare`` may sit out an outage; ``targets`` has to answer within a minute or two, retries included."""
    global _client
    _client = _client or data.BitvavoClient()
    if isinstance(_client, data.BitvavoClient):
        _client.max_retries, _client.timeout, _client.max_sleep = (1, 15.0, 5.0) if quick else (8, 30.0, 120.0)


def _update(market: str, interval: str) -> Read:
    """Fetches what is missing of one market+interval. An unlisted market has no candles, as in the lab."""
    global _client
    _client = _client or data.BitvavoClient()
    now = data.now_ms()
    try:
        data.update_market(_OnDeadline(_client), market, interval, since=_since(interval, now), now=now,
                           progress=lambda *_: None, refetch=REFETCH_BARS)
    except data.NotListed:
        return Read(unlisted=True)
    except Exception as e:  # noqa: BLE001 - the caller decides what a failure means
        print(f"live data: {market} {interval}: {type(e).__name__}: {e}", file=sys.stderr)
        return Read(failed=f"{type(e).__name__}: {e}")
    return Read()


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
    finished = threading.Event()

    def beat() -> None:
        while not finished.wait(LOCK_BEAT_S):
            with contextlib.suppress(OSError):
                os.utime(p)

    threading.Thread(target=beat, daemon=True).start()
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield True
    finally:
        finished.set()
        p.unlink(missing_ok=True)


@contextlib.contextmanager
def use_live_data():
    """Inside it, candles read from disk are brought up to date once before they are read, whoever reads them.
    Yields ``{(market, interval): Read}`` of everything read so far."""
    original = data.candle_path
    reads: dict[tuple[str, str], Read] = {}
    busy = False

    def candle_path(market: str, interval: str):
        nonlocal busy
        if not busy and (market, interval) not in reads:
            busy = True
            try:
                reads[(market, interval)] = _update(market, interval)
            finally:
                busy = False
        return original(market, interval)

    data.candle_path = candle_path
    try:
        yield reads
    finally:
        data.candle_path = original


def _load(fam: Family, spec: dict, end: int) -> dict:
    candles = {}
    for key in _keys(fam, spec):
        m = key.split(" ")[0]
        try:
            candles[m] = data.load_candles(m, spec["interval"], end=end)
        except FileNotFoundError:
            candles[m] = data.empty_frame()
    return candles


def _no_candles(spec: dict, candles: dict) -> bool:
    return all(candles[m].empty for m in spec["markets"])


def _run(fam: Family, spec: dict, candles: dict, start: int | None):
    return fam.targets(candles, spec, start_time=int(start)) if start is not None else fam.targets(candles, spec)


def _warm(fam: Family, spec: dict) -> str | None:
    """Runs the family once so that everything it reads downloads here, with no time pressure. Returns its error."""
    step = data.INTERVAL_MS[spec["interval"]]
    origin = data.WEEK_ORIGIN_MS if spec["interval"] == "1W" else 0
    end = (data.now_ms() - origin) // step * step + origin
    candles = _load(fam, spec, end)
    if _no_candles(spec, candles):
        return None
    try:
        _run(fam, spec, candles, end - step if fam.anchored else None)
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"
    return None


def prepare(raw: dict) -> dict:
    fam, spec = _spec(raw["spec"])
    with _prepare_lock() as mine:
        if not mine:
            return {"busy": True}
        _patience(quick=False)
        done = _ready()
        failed: dict[str, str] = {}
        with use_live_data() as reads:
            for key in _keys(fam, spec):
                if key not in done:
                    m, iv = key.split(" ")
                    data.candle_path(m, iv)
                    if reads[(m, iv)].failed:
                        failed[key] = str(reads[(m, iv)].failed)
                    else:
                        _mark_ready({key})
            warm = _warm_key(fam, spec)
            if not failed and warm not in done:
                err = _warm(fam, spec)
                if err:
                    failed[fam.name] = err
                failed |= {f"{m} {iv}": str(r.failed) for (m, iv), r in reads.items() if r.failed}
                if not failed:
                    _mark_ready({warm})
    return {"ready": False, "failed": failed} if failed else {"ready": True}


def _stale(reads: dict, spec: dict, end: int) -> str | None:
    """Why the candles read are too old to decide at ``end``, if they are: the newest closed more than one bar + 5 min
    before it. One missing bar is allowed: Bitvavo omits bars without trades (the engine retries those itself).

    The markets the bot trades and BTC and ETH are held to that strictly, an exchange outage shows up there. Other
    coins only count when their update failed: after a good update the file is what the lab would have, and thin coins
    go quiet all the time (XTZ-EUR had 723 silences of 2+ hours in the last year, a hold in 1 of every 10 hours).
    A coin with no candles at all is no reason either: ``prepare`` got all it could, so it is not listed, and the family
    reads and tolerates that as in the lab. Nor is a delisted or halted coin of a pool, whose file simply ends, in the
    lab too: Bitvavo answers error 205 for a delisted market, and a failed one is looked up in /markets (it holds only
    if it still trades or that cannot be checked), so that it cannot hold the bot forever."""
    core = {*CORE_MARKETS, *spec["markets"]}
    suspects: dict[str, str] = {}
    for (market, interval), r in sorted(reads.items()):
        df = data.read_frame(data.candle_path(market, interval))
        if df is None or df.empty:
            continue
        step = data.INTERVAL_MS[interval]
        age = end - (int(df.index[-1]) + step)
        if age <= step + STALE_GRACE_MS:
            continue
        why = f"{market} {interval} candles are {age / data.HOUR:.1f} h old" + (f" ({r.failed})" if r.failed else "")
        if market in core:
            return why
        if r.failed:
            suspects.setdefault(market, why)
    if not suspects:
        return None
    try:
        status = {m["market"]: m.get("status") for m in _client.markets()}
    except Exception as e:  # noqa: BLE001
        return f"{next(iter(suspects.values()))}, and the market list is unavailable ({type(e).__name__}: {e})"
    return next((why for m, why in suspects.items() if status.get(m) == "trading"), None)


def targets(raw: dict) -> dict:
    global _deadline
    fam, spec = _spec(raw["spec"])
    err = fam.validate(spec)
    if err:
        raise ValueError(err)
    done = _ready()
    warm = _warm_key(fam, spec)
    warming = [k for k in _keys(fam, spec) if k not in done] or ([warm] if warm not in done else [])
    if warming:
        return {"warming": warming}
    # the bot's bar is the newest one decided on, even if another closed since
    end = int(raw["bar"]) + data.INTERVAL_MS[spec["interval"]]
    start = raw.get("startTime")
    _patience(quick=True)
    _deadline = time.monotonic() + TARGETS_BUDGET_S
    try:
        with use_live_data() as reads:
            candles = _load(fam, spec, end)
            if _no_candles(spec, candles):
                why = next((f" ({r.failed})" for r in reads.values() if r.failed), "")
                return {"hold": f"no candles for {', '.join(spec['markets'])}{why}", "t": None}
            t = _run(fam, spec, candles, start)
    finally:
        _deadline = None
    last = int(t.index[-1]) if t is not None and len(t) else None
    stale = _stale(reads, spec, end)
    if stale:
        return {"hold": stale, "t": last}
    if last is None:
        return {"hold": f"{fam.name} gave no targets", "t": None}
    row = t.iloc[-1]
    if row.isna().all():
        return {"hold": f"{fam.name} has no decision at this bar", "t": last}  # no decision = keep, see clean_weights
    w = {}
    for m in spec["markets"]:
        v = float(row[m]) if m in t.columns else 0.0
        w[m] = v if math.isfinite(v) and v > 0 else 0.0  # NaN beside real weights = out (SPEC §3)
    return {"t": last, "weights": w}


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
