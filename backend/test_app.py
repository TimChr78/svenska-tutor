"""Tests for the backend API (mock mode — no API keys needed)."""
from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APP_PASSWORD", "testpass")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import app
    importlib.reload(app)
    return TestClient(app.app)


def _auth(client: TestClient) -> dict:
    return {"Authorization": "Bearer testpass"}


def test_health_reports_mock(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "providers": ["mock"]}


def test_token_requires_password(client: TestClient) -> None:
    r = client.post("/api/token/gemini", json={"provider": "gemini"})
    assert r.status_code == 401


def test_token_mock_gemini(client: TestClient) -> None:
    r = client.post("/api/token/gemini", json={"provider": "gemini", "scenario": "vardag"},
                    headers=_auth(client))
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "gemini"
    assert body["mock"] is True


def test_token_unknown_provider(client: TestClient) -> None:
    r = client.post("/api/token/nope", json={"provider": "nope"}, headers=_auth(client))
    assert r.status_code == 400


def test_log_turn(client: TestClient) -> None:
    client.post("/api/token/gemini", json={"provider": "gemini"}, headers=_auth(client))
    r = client.post("/api/log/turn", json={
        "session_id": 1, "speaker": "user", "sv_text": "Jag heter Ann",
    }, headers=_auth(client))
    assert r.status_code == 200
    assert r.json() == {"ok": True}
