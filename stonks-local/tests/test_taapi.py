"""Tests for stonks_lab.taapi with a mocked HTTP session (no network, no secret needed)."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stonks_lab import taapi  # noqa: E402


class FakeResponse:
    def __init__(self, status: int, payload: object, headers: dict[str, str] | None = None):
        self.status_code, self._payload, self.headers = status, payload, headers or {}
        self.text = str(payload)

    def json(self) -> object:
        return self._payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse]):
        self.responses = responses
        self.calls: list[dict] = []

    def request(self, method, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append({"method": method, "url": url, "params": params, "json": json, "headers": headers})
        return self.responses.pop(0)


def frame(n: int = 3) -> pd.DataFrame:
    df = pd.DataFrame({"open": [1.0] * n, "high": [2.0] * n, "low": [0.5] * n, "close": [1.5] * n,
                       "volume": [10.0] * n})
    df.index = pd.Index([1_700_000_000_000 + i * 3_600_000 for i in range(n)], name="ts")
    return df


def test_indicator_builds_request():
    s = FakeSession([FakeResponse(200, {"value": [55.0], "timestamp": [1700000000]})])
    c = taapi.TaapiClient(secret="k", session=s)
    out = c.indicator("rsi", "BTC/USDT", "1h", results=1, period=14)
    assert out["value"] == [55.0]
    call = s.calls[0]
    assert call["url"] == "https://v2.taapi.io/indicator/rsi"
    assert call["params"] == {"exchange": "binance", "symbol": "BTC/USDT", "timeframe": "1h", "results": 1,
                              "period": 14}
    assert call["headers"]["Authorization"] == "Bearer k"


def test_bulk_candles_payload_and_result():
    s = FakeSession([FakeResponse(200, {"c": {"rsi": {"value": [1, 2], "timestamp": [1, 2]}}})])
    c = taapi.TaapiClient(secret="k", session=s)
    out = c.bulk_candles(frame(), [{"id": "rsi", "indicator": "rsi", "period": 14}])
    assert out == {"rsi": {"value": [1, 2], "timestamp": [1, 2]}}
    body = s.calls[0]["json"]
    cand = body["constructs"][0]["candles"]
    assert cand[0] == {"t": 1_700_000_000, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0}
    assert len(cand) == 3


def test_bulk_candles_limits():
    c = taapi.TaapiClient(secret="k", session=FakeSession([]))
    with pytest.raises(taapi.TaapiError):
        c.bulk_candles(frame(taapi.MAX_CANDLES + 1), [])
    with pytest.raises(taapi.TaapiError):
        c.bulk_candles({str(i): frame() for i in range(taapi.MAX_CONSTRUCTS + 1)}, [])


def test_retries_on_429_and_raises_on_400(monkeypatch):
    monkeypatch.setattr(taapi.time, "sleep", lambda s: None)
    s = FakeSession([FakeResponse(429, {"error": "slow down"}), FakeResponse(200, {"ok": True})])
    assert taapi.TaapiClient(secret="k", session=s).me() == {"ok": True}
    s = FakeSession([FakeResponse(400, {"error": "bad"})])
    with pytest.raises(taapi.TaapiError):
        taapi.TaapiClient(secret="k", session=s).me()


def test_throttle_caps_requests_per_window(monkeypatch):
    clock = [0.0]
    sleeps: list[float] = []
    monkeypatch.setattr(taapi.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(taapi.time, "sleep", lambda s: (sleeps.append(s), clock.__setitem__(0, clock[0] + s)))
    c = taapi.TaapiClient(secret="k", max_per_window=3, session=FakeSession([]))
    for _ in range(4):
        c._throttle()
    assert len(sleeps) == 1 and sleeps[0] == pytest.approx(taapi.WINDOW_S + 0.05)


def test_to_frame_multi_output():
    df = taapi.to_frame({"valueMACD": [1.0, 2.0], "valueMACDSignal": [0.5, 1.0], "timestamp": [10, 20]})
    assert list(df.index) == [10_000, 20_000] and list(df.columns) == ["valueMACD", "valueMACDSignal"]
