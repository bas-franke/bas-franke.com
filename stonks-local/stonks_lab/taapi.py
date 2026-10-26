"""Small TAAPI.IO v2 client (https://v2.taapi.io, ``Authorization: Bearer <TAAPI_SECRET>``).

Used by the lab to cross-check indicator math and for indicators on exchanges Bitvavo does not cover.

Endpoints (v2):
- ``GET  /indicator/<name>?exchange=&symbol=&timeframe=&results=N&...`` -> ``{"value": [...], "timestamp": [...]}``
  (multi-output indicators use ``valueMACD``/``valueUpperBand``/...; timestamps are unix seconds)
- ``POST /indicator/<name>`` with ``{"candles": [...], ...params}``: one indicator on candles you send
- ``POST /bulk`` (exchange data) and ``POST /bulk-candles`` (``{"constructs": [{id, candles, indicators}]}``,
  your own candles ``{t (s), o, h, l, c, v}``; result ``{constructId: {indicatorId: {...}}}``)
- ``GET  /candles``, ``GET /exchanges``, ``GET /exchanges/<id>/symbols``, ``GET /user/me`` (plan limits)

Plan "expert" (``/user/me``): 75 requests per 15 s, up to 2000 results per request, 10 bulk constructs;
/bulk-candles takes at most 500 candles per construct.
The client stays at ``max_per_window`` (default 50) per 15 s and also obeys ``x-ratelimit-remaining``.
"""

from __future__ import annotations

import os
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
import requests

LAB_DIR = Path(__file__).resolve().parents[1]
WINDOW_S = 15.0
MAX_CONSTRUCTS = 10
MAX_CANDLES = 500  # per construct on /bulk-candles


class TaapiError(RuntimeError):
    pass


def load_env(path: Path = LAB_DIR / ".env") -> dict[str, str]:
    """Read ``KEY=value`` lines from the git-ignored .env (environment variables win)."""
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if k.startswith("TAAPI_")})
    return env


def candles_payload(df: pd.DataFrame) -> list[dict[str, float]]:
    """Lab candle frame (index ts in ms) -> TAAPI candle objects (``t`` in seconds)."""
    return [
        {"t": int(t) // 1000, "o": float(o), "h": float(h), "l": float(lo), "c": float(c), "v": float(v)}
        for t, o, h, lo, c, v in zip(df.index, df["open"], df["high"], df["low"], df["close"], df["volume"])
    ]


def to_frame(result: dict[str, Any]) -> pd.DataFrame:
    """One indicator result ``{"value"/"valueX": [...], "timestamp": [...]}`` -> DataFrame indexed by ms ts."""
    ts = result.get("timestamp")
    cols = {k: v for k, v in result.items() if k != "timestamp" and isinstance(v, list)}
    if ts is None:  # results=1 without arrays
        cols = {k: [v] for k, v in result.items() if k != "timestamp"}
        ts = [None]
    df = pd.DataFrame(cols)
    df.index = pd.Index([None if t is None else int(t) * 1000 for t in ts], name="ts")
    return df


@dataclass
class TaapiClient:
    secret: str = ""
    base_url: str = "https://v2.taapi.io"
    max_per_window: int = 50
    timeout: float = 120.0
    max_retries: int = 5
    session: requests.Session = field(default_factory=requests.Session)
    _sent: deque[float] = field(default_factory=deque)

    @classmethod
    def from_env(cls, **kw: Any) -> "TaapiClient":
        env = load_env()
        if not env.get("TAAPI_SECRET"):
            raise TaapiError("TAAPI_SECRET missing (stonks-local/.env)")
        return cls(secret=env["TAAPI_SECRET"], base_url=env.get("TAAPI_BASE_URL", cls.base_url), **kw)

    # -- rate limiting -------------------------------------------------------------------------------

    def _throttle(self) -> None:
        now = time.monotonic()
        while self._sent and now - self._sent[0] > WINDOW_S:
            self._sent.popleft()
        if len(self._sent) >= self.max_per_window:
            time.sleep(WINDOW_S - (now - self._sent[0]) + 0.05)
        self._sent.append(time.monotonic())

    def request(self, method: str, path: str, *, params: dict[str, Any] | None = None,
                json: Any = None) -> Any:
        delay = 2.0
        for attempt in range(self.max_retries + 1):
            self._throttle()
            try:
                resp = self.session.request(method, f"{self.base_url}{path}", params=params, json=json,
                                            headers={"Authorization": f"Bearer {self.secret}"},
                                            timeout=self.timeout)
            except (requests.ConnectionError, requests.Timeout) as exc:
                err: Exception = exc
            else:
                remaining = resp.headers.get("x-ratelimit-remaining")
                if remaining is not None and int(remaining) <= 2:
                    time.sleep(float(resp.headers.get("x-ratelimit-reset", WINDOW_S)))
                if resp.status_code == 200:
                    return resp.json()
                err = TaapiError(f"HTTP {resp.status_code} {method} {path}: {resp.text[:400]}")
                if resp.status_code != 429 and resp.status_code < 500:
                    raise err
                if resp.status_code == 429:
                    delay = max(delay, WINDOW_S)
            if attempt == self.max_retries:
                raise TaapiError(f"giving up: {err}") from err
            time.sleep(delay)
            delay = min(delay * 2, 60.0)
        raise AssertionError("unreachable")

    # -- endpoints -----------------------------------------------------------------------------------

    def me(self) -> dict[str, Any]:
        """Plan limits (requestsAllowed per requestsAllowedType, maxResultsPerRequest, ...)."""
        return self.request("GET", "/user/me")

    def exchanges(self) -> Any:
        return self.request("GET", "/exchanges")

    def symbols(self, exchange: str) -> Any:
        return self.request("GET", f"/exchanges/{exchange}/symbols")

    def indicator(self, name: str, symbol: str, timeframe: str, exchange: str = "binance", results: int = 1,
                  **params: Any) -> dict[str, Any]:
        """``GET /indicator/<name>`` on exchange data, e.g. ``indicator("rsi", "BTC/USDT", "1h", period=14)``."""
        q = {"exchange": exchange, "symbol": symbol, "timeframe": timeframe, "results": results, **params}
        return self.request("GET", f"/indicator/{name}", params=q)

    def bulk_candles(self, candles: pd.DataFrame | dict[str, pd.DataFrame],
                     indicators: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """``POST /bulk-candles``: run ``indicators`` (``[{"id": "rsi_14", "indicator": "rsi", "period": 14,
        "results": N}, ...]``) on your own candles. One frame -> ``{indicatorId: result}``; a dict of frames
        (at most 10) -> ``{constructId: {indicatorId: result}}``."""
        frames = candles if isinstance(candles, dict) else {"c": candles}
        if len(frames) > MAX_CONSTRUCTS:
            raise TaapiError(f"at most {MAX_CONSTRUCTS} constructs per request on this plan")
        for cid, df in frames.items():
            if len(df) > MAX_CANDLES:
                raise TaapiError(f"construct {cid}: at most {MAX_CANDLES} candles per construct (got {len(df)})")
        body = {"constructs": [{"id": cid, "candles": candles_payload(df), "indicators": indicators}
                               for cid, df in frames.items()]}
        out = self.request("POST", "/bulk-candles", json=body)
        return out if isinstance(candles, dict) else out["c"]


_default: TaapiClient | None = None


def client() -> TaapiClient:
    global _default
    if _default is None:
        _default = TaapiClient.from_env()
    return _default


def indicator(name: str, symbol: str, timeframe: str, exchange: str = "binance", results: int = 1,
              **params: Any) -> dict[str, Any]:
    """Module-level shortcut using the .env credentials."""
    return client().indicator(name, symbol, timeframe, exchange, results, **params)


def bulk_candles(candles_df: pd.DataFrame, indicators: list[dict[str, Any]]) -> dict[str, Any]:
    """Module-level shortcut for one candle frame."""
    return client().bulk_candles(candles_df, indicators)
