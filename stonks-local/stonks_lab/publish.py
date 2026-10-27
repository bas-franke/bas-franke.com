"""Uploads the research payload to the dashboard (POST /api/research, stonks/SPEC.md section 7).

Reads ``STONKS_URL`` and ``STONKS_ADMIN_PASSWORD`` from the environment or ``stonks-local/.env``. Logs in at
``/api/auth/login`` (the ``stonks_session`` cookie stays in the requests Session), then posts the payload.
Never raises for network/server problems: returns ``{"ok": False, "error": "..."}`` so an agent loop keeps going.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import requests

from . import leaderboard
from . import registry as reg

ENV_FILE = reg.LAB_DIR / ".env"
OUT_FILE = reg.LAB_DIR / "out" / "research.json"


def load_env(path: Path = ENV_FILE) -> dict:
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("STONKS_URL", "STONKS_ADMIN_PASSWORD"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


class PublishError(Exception):
    pass


def _request(session: requests.Session, method: str, url: str, retries: int, **kw) -> requests.Response:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            r = session.request(method, url, timeout=30, **kw)
            if r.status_code >= 500 or r.status_code == 429:
                last = PublishError(f"{method} {url} -> HTTP {r.status_code}: {r.text[:200]}")
                if r.status_code in (502, 503, 504) and attempt == retries - 1:
                    raise PublishError(f"{method} {url} -> HTTP {r.status_code}: the stonks backend is not running "
                                       "or not deployed yet (Nginx answered, the app did not)")
            else:
                return r
        except requests.ConnectionError as e:
            last = PublishError(f"cannot reach {url}: {e.__class__.__name__}. Is the dashboard deployed yet?")
        except requests.Timeout:
            last = PublishError(f"{method} {url} timed out")
        if attempt < retries - 1:
            time.sleep(min(2 ** attempt, 10))
    raise last or PublishError("request failed")


def post_payload(payload: dict, url: str, password: str, retries: int = 3) -> dict:
    base = url.rstrip("/")
    s = requests.Session()
    s.headers["User-Agent"] = "stonks-lab"
    r = _request(s, "POST", f"{base}/api/auth/login", retries, json={"password": password})
    if r.status_code == 404:
        raise PublishError(f"{base}/api/auth/login is 404: the stonks dashboard is not deployed yet")
    if r.status_code == 401:
        raise PublishError("login refused (401): STONKS_ADMIN_PASSWORD in stonks-local/.env does not match the server")
    if r.status_code != 200:
        raise PublishError(f"login failed: HTTP {r.status_code} {r.text[:200]}")
    if "stonks_session" not in s.cookies:
        raise PublishError("login answered 200 but set no stonks_session cookie (check HTTPS / cookie flags)")
    body = json.dumps(payload, default=reg._default)
    r = _request(s, "POST", f"{base}/api/research", retries, data=body,
                 headers={"Content-Type": "application/json"})
    if r.status_code == 404:
        raise PublishError(f"{base}/api/research is 404: the backend does not have the research endpoint yet")
    if r.status_code == 413:
        raise PublishError(f"payload too large ({len(body)} bytes)")
    if r.status_code != 200:
        raise PublishError(f"POST /api/research failed: HTTP {r.status_code} {r.text[:300]}")
    try:
        return r.json()
    except ValueError:
        raise PublishError(f"POST /api/research answered non-JSON: {r.text[:200]}") from None


def publish(registry: reg.Registry | None = None, dry_run: bool = False, url: str | None = None,
            password: str | None = None, out: Path = OUT_FILE, retries: int = 3) -> dict[str, Any]:
    payload = leaderboard.build_payload(registry)
    problems = leaderboard.validate_payload(payload)
    leaderboard.write_json(payload, out)
    ranked = sum(len(b["top"]) for b in (payload.get("buckets") or {}).values()) or len(payload["top"])
    result: dict[str, Any] = {"ok": True, "file": str(out), "top": ranked, "problems": problems,
                              "bytes": out.stat().st_size}
    if problems:
        result.update(ok=False, error="payload does not match SPEC section 7: " + "; ".join(problems[:5]))
        return result
    if dry_run:
        result["dryRun"] = True
        return result
    if not ranked:
        result.update(ok=False, error="nothing to publish yet: no finished experiments")
        return result
    env = load_env()
    url = url or env.get("STONKS_URL")
    password = password or env.get("STONKS_ADMIN_PASSWORD")
    if not url or not password:
        result.update(ok=False, error="STONKS_URL / STONKS_ADMIN_PASSWORD missing (stonks-local/.env)")
        return result
    try:
        resp = post_payload(payload, url, password, retries=retries)
        result.update(response=resp, ok=bool(resp.get("ok", True)))
    except PublishError as e:
        result.update(ok=False, error=str(e))
    return result
