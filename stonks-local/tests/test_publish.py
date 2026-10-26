"""publish.py against a local mock of the stonks backend (login cookie + POST /api/research)."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))

from stonks_lab import publish  # noqa: E402
from stonks_lab import registry as reg  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_registry import _fill  # noqa: E402

PASSWORD = "test-password"


class Backend(BaseHTTPRequestHandler):
    received: list = []
    research_status = 200

    def log_message(self, *a):
        pass

    def _json(self, code, obj, headers=()):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/api/auth/login":
            if json.loads(body).get("password") != PASSWORD:
                return self._json(401, {"error": "wrong password"})
            return self._json(200, {"ok": True}, [("Set-Cookie", "stonks_session=abc; Path=/; HttpOnly")])
        if self.path == "/api/research":
            if "stonks_session=abc" not in (self.headers.get("Cookie") or ""):
                return self._json(401, {"error": "login"})
            if Backend.research_status != 200:
                return self._json(Backend.research_status, {"error": "x"})
            Backend.received.append(json.loads(body))
            return self._json(200, {"ok": True, "id": len(Backend.received)})
        self._json(404, {"error": "not found"})


@pytest.fixture
def server():
    Backend.received = []
    Backend.research_status = 200
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture
def r(tmp_path):
    rr = reg.Registry(tmp_path / "lab.sqlite")
    _fill(rr)
    return rr


def test_publish_posts_payload(server, r, tmp_path):
    res = publish.publish(r, url=server, password=PASSWORD, out=tmp_path / "out" / "research.json")
    assert res["ok"], res
    assert res["response"] == {"ok": True, "id": 1}
    p = Backend.received[0]
    assert len(p["top"]) == 5 and p["top"][0]["rank"] == 1
    assert json.loads((tmp_path / "out" / "research.json").read_text())["top"][0]["spec"] == p["top"][0]["spec"]


def test_publish_dry_run_writes_file_only(server, r, tmp_path):
    res = publish.publish(r, dry_run=True, url=server, password=PASSWORD, out=tmp_path / "research.json")
    assert res["ok"] and res["dryRun"] and Backend.received == []
    assert (tmp_path / "research.json").exists()


def test_wrong_password_is_clear(server, r, tmp_path):
    res = publish.publish(r, url=server, password="nope", out=tmp_path / "x.json", retries=1)
    assert not res["ok"] and "401" in res["error"]


def test_missing_endpoint_and_unreachable_do_not_raise(server, r, tmp_path):
    Backend.research_status = 404
    res = publish.publish(r, url=server, password=PASSWORD, out=tmp_path / "x.json", retries=1)
    assert not res["ok"] and "research endpoint" in res["error"]
    res = publish.publish(r, url="http://127.0.0.1:9", password=PASSWORD, out=tmp_path / "x.json", retries=1)
    assert not res["ok"] and "deployed" in res["error"]


def test_server_errors_are_retried(server, r, tmp_path, monkeypatch):
    monkeypatch.setattr(publish.time, "sleep", lambda s: None)
    Backend.research_status = 502
    res = publish.publish(r, url=server, password=PASSWORD, out=tmp_path / "x.json", retries=2)
    assert not res["ok"] and "not running" in res["error"]
