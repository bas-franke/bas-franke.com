"""Shared experiment memory for the research agents.

One SQLite file (``stonks-local/data/lab.sqlite``, override with ``STONKS_LAB_DB``) in WAL mode, safe for ~20
concurrent processes: every write runs in a ``BEGIN IMMEDIATE`` transaction with a long busy timeout.

Tables
------
experiments  one row per strategy spec ever tried (``spec_hash`` UNIQUE): status running/done/failed, score,
             metrics, holdout, downsampled equity, agent/round/parent/hypothesis, timings
findings     short human lessons ("RSI dip on 1m loses to fees at any threshold") with evidence hashes
claims       lane reservations (lane, agent, round, heartbeat) so two agents don't explore the same thing at once
rounds       one row per (round, agent): lane, start/finish, experiment and finding counts

The canonical identity of an experiment is :func:`spec_hash`: family, familyVersion, interval, sorted markets,
params, risk and execution (defaults filled in), ignoring ``id``/``name``.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

LAB_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB = LAB_DIR / "data" / "lab.sqlite"

INTERVALS = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "1W"]

DEFAULT_RISK = {"maxWeight": 1.0, "stopLossPct": None, "takeProfitPct": None, "trailingStopPct": None}
DEFAULT_EXECUTION = {"orderType": "limit", "limitOffsetBps": 5, "postOnly": True, "timeoutBars": 1, "fallback": "cancel"}

# A "running" claim older than this is considered abandoned (the process died) and may be re-claimed.
RUNNING_STALE_S = 6 * 3600
LANE_STALE_S = 3 * 3600

# Version of the evaluation method (fold boundaries + score formula, see stonks_lab/evaluate.py). Rows of older
# versions (NULL = 1) are not compared with current ones; `lab.py rescore` re-evaluates them in place.
EVAL_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS experiments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_hash     TEXT NOT NULL UNIQUE,
  spec          TEXT NOT NULL,
  family        TEXT NOT NULL,
  family_version INTEGER,
  interval      TEXT NOT NULL,
  markets       TEXT NOT NULL,          -- sorted, comma separated
  params        TEXT NOT NULL,          -- canonical json
  fingerprint   TEXT,                   -- data fingerprint from evaluate
  score         REAL,                   -- out-of-sample score (evaluate); NULL unless done
  metrics       TEXT,                   -- json: score breakdown, folds summary, vsBuyHold ...
  holdout       TEXT,                   -- json: holdout metrics (SPEC section 7 keys)
  curves        TEXT,                   -- json: {equity, buyHoldEquity, benchmarks} downsampled <= 400 pts
  bot_ready     INTEGER,
  agent         TEXT,
  round         INTEGER,
  parent        TEXT,
  hypothesis    TEXT,
  status        TEXT NOT NULL,          -- running | done | failed
  error         TEXT,
  created_at    REAL NOT NULL,
  started_at    REAL,
  finished_at   REAL,
  heartbeat_at  REAL,
  duration_s    REAL
);
CREATE INDEX IF NOT EXISTS ix_exp_cell ON experiments(family, interval, markets);
CREATE INDEX IF NOT EXISTS ix_exp_score ON experiments(status, score DESC);
CREATE INDEX IF NOT EXISTS ix_exp_agent ON experiments(agent, round);

CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT,
  round       INTEGER,
  lane        TEXT,
  text        TEXT NOT NULL,
  tags        TEXT,                     -- comma separated
  evidence    TEXT,                     -- json list of spec hashes
  created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_find_lane ON findings(lane, created_at DESC);

CREATE TABLE IF NOT EXISTS claims (
  lane         TEXT NOT NULL,
  agent        TEXT NOT NULL,
  round        INTEGER,
  note         TEXT,
  claimed_at   REAL NOT NULL,
  heartbeat_at REAL NOT NULL,
  PRIMARY KEY (lane, agent)
);

CREATE TABLE IF NOT EXISTS rounds (
  round        INTEGER NOT NULL,
  agent        TEXT NOT NULL,
  lane         TEXT,
  started_at   REAL NOT NULL,
  finished_at  REAL,
  experiments  INTEGER NOT NULL DEFAULT 0,
  findings     INTEGER NOT NULL DEFAULT 0,
  summary      TEXT,
  PRIMARY KEY (round, agent)
);
"""


# --------------------------------------------------------------------------------------------- spec identity

def _norm(v: Any) -> Any:
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return str(v)
        if v.is_integer() and abs(v) < 1e15:
            return int(v)
        return float(f"{v:.10g}")
    if isinstance(v, dict):
        return {str(k): _norm(x) for k, x in sorted(v.items())}
    if isinstance(v, (list, tuple)):
        return [_norm(x) for x in v]
    if hasattr(v, "item"):  # numpy scalar
        return _norm(v.item())
    return v


def canonical(spec: dict) -> dict:
    """The identity-relevant part of a spec, with defaults filled in and numbers normalized."""
    risk = dict(DEFAULT_RISK)
    risk.update(spec.get("risk") or {})
    execution = dict(DEFAULT_EXECUTION)
    execution.update(spec.get("execution") or {})
    return _norm({
        "family": spec["family"],
        "familyVersion": spec.get("familyVersion", 1),
        "interval": spec["interval"],
        "markets": sorted(spec.get("markets") or []),
        "params": spec.get("params") or {},
        "risk": risk,
        "execution": execution,
    })


def spec_hash(spec: dict) -> str:
    blob = json.dumps(canonical(spec), sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def markets_key(markets: Iterable[str]) -> str:
    return ",".join(sorted(markets))


def _flat_numeric(spec: dict) -> tuple[dict, dict]:
    """(numeric knobs, other knobs) of a canonical spec, used for near-duplicate distance."""
    c = canonical(spec)
    num, other = {}, {}
    for section in ("params", "risk", "execution"):
        for k, v in (c.get(section) or {}).items():
            key = f"{section}.{k}"
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                num[key] = float(v)
            else:
                other[key] = json.dumps(v, sort_keys=True)
    return num, other


def param_distance(a: dict, b: dict) -> float:
    """Largest relative difference between two specs' numeric knobs; inf if a non-numeric knob differs."""
    na, oa = _flat_numeric(a)
    nb, ob = _flat_numeric(b)
    if oa != ob or set(na) != set(nb):
        return math.inf
    worst = 0.0
    for k, x in na.items():
        y = nb[k]
        if x == y:
            continue
        denom = max(abs(x), abs(y), 1e-12)
        worst = max(worst, abs(x - y) / denom)
    return worst


# --------------------------------------------------------------------------------------------- helpers

def _j(v: Any) -> str | None:
    return None if v is None else json.dumps(_norm(v) if not isinstance(v, str) else v, default=_default)


def _default(o: Any) -> Any:
    if hasattr(o, "item"):
        return o.item()
    if hasattr(o, "tolist"):
        return o.tolist()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return str(o)


def _lj(s: str | None) -> Any:
    return None if s is None else json.loads(s)


def downsample(points: Any, n: int = 400) -> list:
    """Keep at most n points (first and last always kept). Accepts [[t, v], ...] or a pandas Series."""
    if points is None:
        return []
    if hasattr(points, "items") and hasattr(points, "index") and not isinstance(points, dict):  # pandas Series
        pts = [[_ts(t), float(v)] for t, v in points.items()]
    else:
        pts = [[_ts(p[0]), float(p[1])] for p in points]
    if len(pts) <= n:
        return pts
    step = (len(pts) - 1) / (n - 1)
    idx = sorted({round(i * step) for i in range(n)})
    return [pts[i] for i in idx]


def _ts(t: Any) -> Any:
    if hasattr(t, "value") and hasattr(t, "tz_localize"):  # pandas Timestamp -> ms
        return int(t.value // 1_000_000)
    if hasattr(t, "item"):
        return t.item()
    return t


# --------------------------------------------------------------------------------------------- registry

class Registry:
    def __init__(self, path: str | os.PathLike | None = None):
        self.path = Path(path or os.environ.get("STONKS_LAB_DB") or DEFAULT_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(SCHEMA)
            _migrate(c)

    @contextmanager
    def _conn(self):
        c = sqlite3.connect(self.path, timeout=60, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA busy_timeout=60000")
        c.execute("PRAGMA synchronous=NORMAL")
        try:
            yield c
        finally:
            c.close()

    @contextmanager
    def _tx(self):
        with self._conn() as c:
            for attempt in range(20):
                try:
                    c.execute("BEGIN IMMEDIATE")
                    break
                except sqlite3.OperationalError as e:  # pragma: no cover - only under heavy contention
                    if "locked" not in str(e) or attempt == 19:
                        raise
                    time.sleep(0.05 * (attempt + 1))
            try:
                yield c
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise

    # ----------------------------------------------------------------------------------------- experiments

    def claim(self, spec: dict, agent: str | None = None, round: int | None = None,
              hypothesis: str | None = None, parent: str | None = None, retry_failed: bool = False,
              stale_s: float = RUNNING_STALE_S) -> bool:
        """Atomically reserve a spec. False if it is already done, or running and fresh (or failed, unless
        ``retry_failed``). A stale running row (its process died) is taken over."""
        h = spec_hash(spec)
        now = time.time()
        c_spec = canonical(spec)
        with self._tx() as c:
            row = c.execute("SELECT status, heartbeat_at FROM experiments WHERE spec_hash=?", (h,)).fetchone()
            if row is None:
                c.execute(
                    """INSERT INTO experiments (spec_hash, spec, family, family_version, interval, markets, params,
                       agent, round, parent, hypothesis, status, created_at, started_at, heartbeat_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?)""",
                    (h, _j(spec), c_spec["family"], c_spec["familyVersion"], c_spec["interval"],
                     markets_key(c_spec["markets"]), _j(c_spec["params"]), agent, round, parent, hypothesis,
                     now, now, now))
                return True
            status, hb = row["status"], row["heartbeat_at"] or 0
            takeover = (status == "running" and now - hb > stale_s) or (status == "failed" and retry_failed)
            if not takeover:
                return False
            c.execute("""UPDATE experiments SET status='running', agent=?, round=?, parent=?, hypothesis=?, error=NULL,
                         spec=?, started_at=?, heartbeat_at=? WHERE spec_hash=?""",
                      (agent, round, parent, hypothesis, _j(spec), now, now, h))
            return True

    def heartbeat(self, spec_or_hash: dict | str) -> None:
        h = spec_or_hash if isinstance(spec_or_hash, str) else spec_hash(spec_or_hash)
        with self._tx() as c:
            c.execute("UPDATE experiments SET heartbeat_at=? WHERE spec_hash=? AND status='running'", (time.time(), h))

    def release(self, spec: dict) -> None:
        """Drop a running claim without a result (e.g. interrupted before evaluating)."""
        with self._tx() as c:
            c.execute("DELETE FROM experiments WHERE spec_hash=? AND status='running'", (spec_hash(spec),))

    def record(self, spec: dict, result: dict | None, agent: str | None = None, round: int | None = None,
               hypothesis: str | None = None, parent: str | None = None, error: str | None = None,
               bot_ready: bool | None = None) -> str:
        """Store the outcome of evaluating ``spec`` (``result`` from ``evaluate.evaluate``) or its failure."""
        h = spec_hash(spec)
        now = time.time()
        c_spec = canonical(spec)
        status = "failed" if (error or result is None) else "done"
        score = metrics = holdout = curves = fingerprint = eval_version = None
        if result is not None:
            eval_version = result.get("evalVersion")
            fingerprint = result.get("fingerprint")
            score, metrics, holdout, curves = _result_columns(result)
        with self._tx() as c:
            row = c.execute("SELECT started_at, agent, round, parent, hypothesis FROM experiments WHERE spec_hash=?",
                            (h,)).fetchone()
            if row is None:
                c.execute(
                    """INSERT INTO experiments (spec_hash, spec, family, family_version, interval, markets, params,
                       status, created_at, started_at) VALUES (?,?,?,?,?,?,?,'running',?,?)""",
                    (h, _j(spec), c_spec["family"], c_spec["familyVersion"], c_spec["interval"],
                     markets_key(c_spec["markets"]), _j(c_spec["params"]), now, now))
                started = now
                prev = {}
            else:
                started = row["started_at"] or now
                prev = dict(row)
            c.execute(
                """UPDATE experiments SET status=?, score=?, metrics=?, holdout=?, curves=?, fingerprint=?, error=?,
                   bot_ready=?, agent=?, round=?, parent=?, hypothesis=?, finished_at=?, heartbeat_at=?, duration_s=?,
                   eval_version=? WHERE spec_hash=?""",
                (status, score, _j(metrics), _j(holdout), _j(curves), fingerprint, error,
                 None if bot_ready is None else int(bool(bot_ready)),
                 agent or prev.get("agent"), round if round is not None else prev.get("round"),
                 parent or prev.get("parent"), hypothesis or prev.get("hypothesis"),
                 now, now, now - started, eval_version, h))
            a = agent or prev.get("agent")
            r = round if round is not None else prev.get("round")
            if a is not None and r is not None:
                _bump_round(c, r, a, "experiments")
        return h

    def stale_versions(self, limit: int | None = None, version: int = EVAL_VERSION) -> list[dict]:
        """Done experiments evaluated with an older method (eval_version NULL or < ``version``), cheapest
        intervals first: [{spec_hash, spec, interval, eval_version}]."""
        q = ("SELECT spec_hash, spec, interval, eval_version FROM experiments WHERE status='done' "
             "AND (eval_version IS NULL OR eval_version < ?) ORDER BY id")
        with self._conn() as c:
            rows = [dict(r) for r in c.execute(q, (version,)).fetchall()]
        order = {iv: i for i, iv in enumerate(reversed(INTERVALS))}
        rows.sort(key=lambda r: order.get(r["interval"], 99))
        for r in rows:
            r["spec"] = _lj(r["spec"])
        return rows[:limit] if limit else rows

    def rescore(self, h: str, result: dict) -> bool:
        """Replace a done experiment's evaluation with a newer-version ``result`` in place. The previous score,
        scoreParts and eval version are appended to ``metrics.history``. Agent, round, lineage and timings stay.
        Idempotent: a row that is already at the result's version (or no longer done) is left alone (False)."""
        new_v = int(result.get("evalVersion") or EVAL_VERSION)
        score, metrics, holdout, curves = _result_columns(result)
        with self._tx() as c:
            row = c.execute("SELECT status, score, metrics, eval_version FROM experiments WHERE spec_hash=?",
                            (h,)).fetchone()
            if row is None or row["status"] != "done" or (row["eval_version"] or 1) >= new_v:
                return False
            old = _lj(row["metrics"]) or {}
            history = list(old.get("history") or [])
            history.append({"evalVersion": row["eval_version"] or 1, "score": row["score"],
                            "scoreParts": old.get("scoreParts"), "rescoredAt": time.time()})
            metrics = dict(metrics or {})
            metrics["history"] = history
            c.execute("""UPDATE experiments SET score=?, metrics=?, holdout=?, curves=?, fingerprint=?, eval_version=?
                         WHERE spec_hash=?""",
                      (score, _j(metrics), _j(holdout), _j(curves), result.get("fingerprint"), new_v, h))
            return True

    def seen(self, spec: dict, include_failed: bool = True) -> bool:
        """True if this exact spec is done, running, or (by default) failed."""
        with self._conn() as c:
            row = c.execute("SELECT status FROM experiments WHERE spec_hash=?", (spec_hash(spec),)).fetchone()
        if row is None:
            return False
        return include_failed or row["status"] != "failed"

    def get(self, h: str) -> dict | None:
        with self._conn() as c:
            row = c.execute("SELECT * FROM experiments WHERE spec_hash=? OR spec_hash LIKE ?", (h, h + "%")).fetchone()
        return _exp(row) if row else None

    def near_duplicates(self, spec: dict, tolerance: float = 0.05, limit: int = 20) -> list[dict]:
        """Done/running experiments of the same family, interval and markets (and same non-numeric knobs) whose
        numeric params/risk/execution are all within ``tolerance`` relative distance. The exact spec counts too."""
        c_spec = canonical(spec)
        with self._conn() as c:
            rows = c.execute(
                """SELECT spec_hash, spec, score, status, agent FROM experiments
                   WHERE family=? AND interval=? AND markets=? AND status IN ('done','running')""",
                (c_spec["family"], c_spec["interval"], markets_key(c_spec["markets"]))).fetchall()
        out = []
        for r in rows:
            d = param_distance(spec, json.loads(r["spec"]))
            if d <= tolerance:
                out.append({"spec_hash": r["spec_hash"], "distance": d, "score": r["score"], "status": r["status"],
                            "agent": r["agent"]})
        out.sort(key=lambda x: x["distance"])
        return out[:limit]

    def experiments(self, status: str | None = "done", family: str | None = None, interval: str | None = None,
                    agent: str | None = None, limit: int | None = None, order: str = "score") -> list[dict]:
        q, args = "SELECT * FROM experiments WHERE 1=1", []
        for col, val in (("status", status), ("family", family), ("interval", interval), ("agent", agent)):
            if val is not None:
                q += f" AND {col}=?"
                args.append(val)
        q += " ORDER BY score IS NULL, score DESC" if order == "score" else " ORDER BY id DESC"
        if limit:
            q += " LIMIT ?"
            args.append(limit)
        with self._conn() as c:
            return [_exp(r) for r in c.execute(q, args).fetchall()]

    def top(self, n: int = 10, bot_ready_only: bool = False, family: str | None = None,
            version: int | None = EVAL_VERSION) -> list[dict]:
        """Best done experiments by score, only those evaluated with the current method (``version=None``: all)."""
        q = "SELECT * FROM experiments WHERE status='done' AND score IS NOT NULL"
        args: list = []
        if version is not None:
            q += " AND eval_version=?"
            args.append(version)
        if bot_ready_only:
            q += " AND bot_ready=1"
        if family:
            q += " AND family=?"
            args.append(family)
        q += " ORDER BY score DESC LIMIT ?"
        args.append(n)
        with self._conn() as c:
            return [_exp(r) for r in c.execute(q, args).fetchall()]

    # ----------------------------------------------------------------------------------------- findings

    def add_finding(self, text: str, lane: str | None = None, agent: str | None = None, round: int | None = None,
                    tags: Iterable[str] | str | None = None, evidence: Iterable[str] | None = None) -> int:
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        with self._tx() as c:
            cur = c.execute(
                "INSERT INTO findings (agent, round, lane, text, tags, evidence, created_at) VALUES (?,?,?,?,?,?,?)",
                (agent, round, lane, text.strip(), ",".join(tags or []), json.dumps(list(evidence or [])),
                 time.time()))
            if agent is not None and round is not None:
                _bump_round(c, round, agent, "findings")
            return int(cur.lastrowid)

    def findings(self, lane: str | None = None, limit: int | None = 50, agent: str | None = None,
                 tag: str | None = None) -> list[dict]:
        q, args = "SELECT * FROM findings WHERE 1=1", []
        if lane is not None:
            q += " AND lane=?"
            args.append(lane)
        if agent is not None:
            q += " AND agent=?"
            args.append(agent)
        if tag is not None:
            q += " AND (','||tags||',') LIKE ?"
            args.append(f"%,{tag},%")
        q += " ORDER BY created_at DESC, id DESC"
        if limit:
            q += " LIMIT ?"
            args.append(limit)
        with self._conn() as c:
            rows = c.execute(q, args).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["tags"] = [t for t in (d["tags"] or "").split(",") if t]
            d["evidence"] = _lj(d["evidence"]) or []
            out.append(d)
        return out

    # ----------------------------------------------------------------------------------------- lane claims

    def claim_lane(self, lane: str, agent: str, round: int | None = None, note: str | None = None,
                   max_agents: int = 2, stale_s: float = LANE_STALE_S) -> bool:
        """Reserve a lane. At most ``max_agents`` fresh holders per lane; refreshing your own claim always works."""
        now = time.time()
        with self._tx() as c:
            c.execute("DELETE FROM claims WHERE heartbeat_at < ?", (now - stale_s,))
            mine = c.execute("SELECT 1 FROM claims WHERE lane=? AND agent=?", (lane, agent)).fetchone()
            if mine:
                c.execute("UPDATE claims SET heartbeat_at=?, round=?, note=COALESCE(?, note) WHERE lane=? AND agent=?",
                          (now, round, note, lane, agent))
                return True
            n = c.execute("SELECT COUNT(*) FROM claims WHERE lane=?", (lane,)).fetchone()[0]
            if n >= max_agents:
                return False
            c.execute("INSERT INTO claims (lane, agent, round, note, claimed_at, heartbeat_at) VALUES (?,?,?,?,?,?)",
                      (lane, agent, round, note, now, now))
            if round is not None:
                c.execute("""INSERT INTO rounds (round, agent, lane, started_at) VALUES (?,?,?,?)
                             ON CONFLICT(round, agent) DO UPDATE SET lane=excluded.lane""", (round, agent, lane, now))
            return True

    def release_lane(self, lane: str, agent: str, summary: str | None = None) -> None:
        now = time.time()
        with self._tx() as c:
            row = c.execute("SELECT round FROM claims WHERE lane=? AND agent=?", (lane, agent)).fetchone()
            c.execute("DELETE FROM claims WHERE lane=? AND agent=?", (lane, agent))
            if row and row["round"] is not None:
                c.execute("UPDATE rounds SET finished_at=?, summary=COALESCE(?, summary) WHERE round=? AND agent=?",
                          (now, summary, row["round"], agent))

    def lanes(self, stale_s: float = LANE_STALE_S) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT * FROM claims WHERE heartbeat_at >= ? ORDER BY lane, claimed_at",
                             (time.time() - stale_s,)).fetchall()
        return [dict(r) for r in rows]

    # ----------------------------------------------------------------------------------------- overview

    def coverage(self, families: Iterable[str] | None = None, intervals: Iterable[str] | None = None,
                 market_sets: Iterable[str] | None = None) -> dict:
        """What has been tried: per (family, interval, markets) cell the count of done/failed/running experiments
        and the best score, plus the untried cells of families x intervals x market_sets when those are given."""
        with self._conn() as c:
            rows = c.execute(
                """SELECT family, interval, markets,
                          SUM(status='done') AS done, SUM(status='failed') AS failed, SUM(status='running') AS running,
                          MAX(CASE WHEN status='done' AND eval_version=? THEN score END) AS best
                   FROM experiments GROUP BY family, interval, markets""", (EVAL_VERSION,)).fetchall()
        cells = [dict(r) for r in rows]
        order = {iv: i for i, iv in enumerate(INTERVALS)}
        cells.sort(key=lambda r: (r["family"], order.get(r["interval"], 99), r["markets"]))
        untried = []
        if families:
            tried = {(r["family"], r["interval"]) for r in cells if r["done"]}
            tried_full = {(r["family"], r["interval"], r["markets"]) for r in cells if r["done"]}
            for f in families:
                for iv in intervals or INTERVALS:
                    if market_sets:
                        for m in market_sets:
                            if (f, iv, m) not in tried_full:
                                untried.append({"family": f, "interval": iv, "markets": m})
                    elif (f, iv) not in tried:
                        untried.append({"family": f, "interval": iv, "markets": None})
        return {"cells": cells, "untried": untried}

    def stats(self) -> dict:
        with self._conn() as c:
            e = c.execute("""SELECT COUNT(*) n, SUM(status='done') done, SUM(status='failed') failed,
                             SUM(status='running') running, COUNT(DISTINCT family) families,
                             MAX(CASE WHEN eval_version=? THEN score END) best,
                             SUM(status='done' AND (eval_version IS NULL OR eval_version<?)) stale,
                             SUM(duration_s) cpu_s FROM experiments""", (EVAL_VERSION, EVAL_VERSION)).fetchone()
            f = c.execute("SELECT COUNT(*) FROM findings").fetchone()[0]
            r = c.execute("""SELECT COUNT(DISTINCT round) FROM (SELECT round FROM experiments WHERE round IS NOT NULL
                             UNION SELECT round FROM findings WHERE round IS NOT NULL
                             UNION SELECT round FROM rounds)""").fetchone()[0]
            maxr = c.execute("""SELECT MAX(round) FROM (SELECT round FROM experiments UNION SELECT round FROM rounds
                                UNION SELECT round FROM findings)""").fetchone()[0]
            agents = c.execute("SELECT COUNT(DISTINCT agent) FROM experiments WHERE agent IS NOT NULL").fetchone()[0]
            last = c.execute("SELECT MAX(finished_at) FROM experiments").fetchone()[0]
        return {"experiments": e["n"] or 0, "done": e["done"] or 0, "failed": e["failed"] or 0,
                "running": e["running"] or 0, "staleEval": e["stale"] or 0, "families": e["families"] or 0, "bestScore": e["best"],
                "cpuHours": round((e["cpu_s"] or 0) / 3600, 2), "findings": f, "rounds": r, "maxRound": maxr,
                "agents": agents, "lastFinishedAt": last}


def _result_columns(result: dict) -> tuple:
    """(score, metrics, holdout, curves) of an ``evaluate.evaluate`` result as stored in the registry."""
    s = result.get("score")
    score = None if s is None else float(s)
    if score is not None and not math.isfinite(score):
        score = None
    holdout = result.get("holdout")
    curves = {
        "equity": downsample(result.get("equity")),
        "buyHoldEquity": downsample(result.get("buyHoldEquity")),
        "benchmarks": _bench_curves(result.get("benchmarks")),
    }
    metrics = {k: v for k, v in result.items()
               if k not in ("equity", "buyHoldEquity", "benchmarks", "holdout", "fingerprint", "spec")}
    if isinstance(holdout, dict):
        holdout = {k: v for k, v in holdout.items() if k not in ("equity", "buyHoldEquity")}
    return score, metrics, holdout, curves


def _migrate(c: sqlite3.Connection) -> None:
    """Additive, idempotent schema changes. Safe with concurrent openers: a lost race ("duplicate column") is fine."""
    cols = {r[1] for r in c.execute("PRAGMA table_info(experiments)").fetchall()}
    if "eval_version" not in cols:
        try:
            c.execute("ALTER TABLE experiments ADD COLUMN eval_version INTEGER")  # NULL = version 1
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
    c.execute("CREATE INDEX IF NOT EXISTS ix_exp_ver ON experiments(status, eval_version)")


def _bump_round(c: sqlite3.Connection, round: int, agent: str, col: str) -> None:
    c.execute(f"""INSERT INTO rounds (round, agent, started_at, {col}) VALUES (?,?,?,1)
                  ON CONFLICT(round, agent) DO UPDATE SET {col}={col}+1""", (round, agent, time.time()))


def _bench_curves(b: Any) -> Any:
    if b is None:
        return None
    if isinstance(b, dict):
        items = b.items()
        out: dict = {}
        for k, v in items:
            out[k] = _bench_one(v)
        return out
    if isinstance(b, list):
        return [_bench_one(v) for v in b]
    return None


def _bench_one(v: Any) -> Any:
    if isinstance(v, dict):
        d = {k: x for k, x in v.items() if k != "equity"}
        if "equity" in v:
            d["equity"] = downsample(v["equity"])
        return d
    return v


def _exp(row: sqlite3.Row) -> dict:
    d = dict(row)
    for k in ("spec", "params", "metrics", "holdout", "curves"):
        d[k] = _lj(d.get(k))
    d["markets"] = [m for m in (d.get("markets") or "").split(",") if m]
    return d


_default_registry: Registry | None = None


def default() -> Registry:
    global _default_registry
    if _default_registry is None:
        _default_registry = Registry()
    return _default_registry
