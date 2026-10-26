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
    # Entering the context runs the lifespan hook, which creates the schema.
    with TestClient(app.app) as client:
        return client


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


def test_token_returns_session_id(client: TestClient) -> None:
    body = client.post("/api/token/gemini", json={"provider": "gemini"},
                       headers=_auth(client)).json()
    assert isinstance(body["session_id"], int)


def test_log_turn_rejects_unknown_session(client: TestClient) -> None:
    r = client.post("/api/log/turn", json={
        "session_id": 999, "speaker": "user", "sv_text": "hej",
    }, headers=_auth(client))
    assert r.status_code == 404


def test_log_turn_rejects_empty_text(client: TestClient) -> None:
    client.post("/api/token/gemini", json={"provider": "gemini"}, headers=_auth(client))
    r = client.post("/api/log/turn", json={"session_id": 1, "speaker": "tutor"},
                    headers=_auth(client))
    assert r.status_code == 400


def test_log_turn_rejects_unknown_speaker(client: TestClient) -> None:
    client.post("/api/token/gemini", json={"provider": "gemini"}, headers=_auth(client))
    r = client.post("/api/log/turn", json={
        "session_id": 1, "speaker": "system", "sv_text": "hej",
    }, headers=_auth(client))
    assert r.status_code == 400


def test_session_lifecycle(client: TestClient) -> None:
    sid = client.post("/api/token/gemini", json={"provider": "gemini"},
                      headers=_auth(client)).json()["session_id"]
    for speaker, text in (("user", "Jag heter Tim"), ("tutor", "Hej Tim!")):
        client.post("/api/log/turn", json={
            "session_id": sid, "speaker": speaker, "sv_text": text,
        }, headers=_auth(client))

    ended = client.post(f"/api/session/{sid}/end", headers=_auth(client)).json()
    assert ended["turns"] == 2
    assert ended["seconds"] >= 0

    # Idempotent: ending twice must not move the timestamp.
    again = client.post(f"/api/session/{sid}/end", headers=_auth(client)).json()
    assert again["ended_at"] == ended["ended_at"]

    detail = client.get(f"/api/session/{sid}", headers=_auth(client)).json()
    assert [t["sv_text"] for t in detail["turns"]] == ["Jag heter Tim", "Hej Tim!"]
    assert detail["corrections"] == []
    assert detail["session"]["ended_at"] is not None


def test_list_sessions(client: TestClient) -> None:
    client.post("/api/token/gemini", json={"provider": "gemini"}, headers=_auth(client))
    body = client.get("/api/sessions", headers=_auth(client)).json()
    assert len(body["sessions"]) == 1
    assert body["sessions"][0]["turns"] == 0


def test_review_without_turns(client: TestClient) -> None:
    sid = client.post("/api/token/gemini", json={"provider": "gemini"},
                      headers=_auth(client)).json()["session_id"]
    body = client.post(f"/api/session/{sid}/review", headers=_auth(client)).json()
    assert body["corrections"] == []
    assert body["reason"] == "no turns logged"


def test_review_stores_corrections(client: TestClient, monkeypatch) -> None:
    import httpx

    sid = client.post("/api/token/gemini", json={"provider": "gemini"},
                      headers=_auth(client)).json()["session_id"]
    client.post("/api/log/turn", json={
        "session_id": sid, "speaker": "user", "sv_text": "Jag är tjugo år gammal.",
    }, headers=_auth(client))

    class FakeResponse:
        status_code = 200

        def json(self) -> dict:
            return {"candidates": [{"content": {"parts": [{"text": (
                '[{"said": "Jag är tjugo år", "better": "Jag är tjugo år.", '
                '"rule_th": "ใช้ är när man beskriver ålder"}]'
            )}]}}]}

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResponse())

    body = client.post(f"/api/session/{sid}/review", headers=_auth(client)).json()
    assert body["corrections"] == [{
        "id": 1,
        "said": "Jag är tjugo år",
        "better": "Jag är tjugo år.",
        "rule_th": "ใช้ är när man beskriver ålder",
    }]

    # Re-running replaces instead of duplicating.
    body = client.post(f"/api/session/{sid}/review", headers=_auth(client)).json()
    assert len(body["corrections"]) == 1
