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
    from backend import app

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
                '{"corrections": [{"said": "Jag är tjugo år", '
                '"better": "Jag är tjugo år.", '
                '"rule_th": "ใช้ är när man beskriver ålder"}]}'
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


def test_review_reports_a_slow_model_as_504(client: TestClient, monkeypatch) -> None:
    import httpx

    sid = client.post("/api/token/gemini", json={"provider": "gemini"},
                      headers=_auth(client)).json()["session_id"]
    client.post("/api/log/turn", json={
        "session_id": sid, "speaker": "user", "sv_text": "Jag heter Tim.",
    }, headers=_auth(client))

    def boom(*args, **kwargs):
        raise httpx.ReadTimeout("too slow")

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(httpx, "post", boom)

    resp = client.post(f"/api/session/{sid}/review", headers=_auth(client))
    assert resp.status_code == 504
    assert "timed out" in resp.json()["detail"]


def test_vision_reports_a_slow_model_as_504(client: TestClient, monkeypatch) -> None:
    import httpx

    def boom(*args, **kwargs):
        raise httpx.ReadTimeout("too slow")

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(httpx, "post", boom)

    resp = client.post("/api/vision/gemini", json={"image_b64": "AAAA"}, headers=_auth(client))
    assert resp.status_code == 504
    assert "timed out" in resp.json()["detail"]


def test_vision_reports_an_explanation(client: TestClient, monkeypatch) -> None:
    import httpx

    class FakeResponse:
        status_code = 200

        def json(self) -> dict:
            return {"candidates": [{"content": {"parts": [{"text": "Övning 1: fyll i rätt verb."}]}}]}

    seen: dict = {}

    def fake_post(url, **kwargs):
        seen["url"] = url
        seen["parts"] = kwargs["json"]["contents"][0]["parts"]
        return FakeResponse()

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(httpx, "post", fake_post)

    body = client.post("/api/vision/gemini", json={"image_b64": "AAAA"}, headers=_auth(client)).json()
    assert body["explanation"].startswith("Övning 1")
    assert "inlineData" in seen["parts"][1]


# --------------------------------------------------------------------------
# Settings / key storage
# ----------------------------------------------------------------


def _fake_validator(ok: bool = True):
    def validate(provider: str, value: str) -> tuple[bool, str]:
        return ok, "ok" if ok else "the provider rejected this key"

    return validate


def test_settings_start_empty(client: TestClient) -> None:
    body = client.get("/api/settings", headers=_auth(client)).json()
    assert body["encrypted_at_rest"] is True
    for provider in body["providers"]:
        assert provider["configured"] is False
        assert provider["source"] == "none"


def test_saved_key_is_never_returned(client: TestClient, monkeypatch, tmp_path) -> None:
    from backend import app as app_module

    secret = "AIzaSECRETVALUE0123456789abcdef"
    monkeypatch.setattr(app_module, "validate_key", _fake_validator(True))

    body = client.put("/api/settings/keys/gemini", json={"key": secret},
                      headers=_auth(client)).json()
    assert body["configured"] is True
    assert body["source"] == "ui"
    assert body["hint"] == "…cdef"
    assert secret not in str(body)

    listing = client.get("/api/settings", headers=_auth(client)).text
    assert secret not in listing

    # At rest: the database holds ciphertext, not the key.
    raw = (tmp_path / "sessions.db").read_bytes()
    assert secret.encode() not in raw
    assert (tmp_path / "master.key").stat().st_mode & 0o777 == 0o600


def test_rejected_key_is_not_stored(client: TestClient, monkeypatch) -> None:
    from backend import app as app_module

    monkeypatch.setattr(app_module, "validate_key", _fake_validator(False))
    resp = client.put("/api/settings/keys/openai", json={"key": "sk-typo"},
                      headers=_auth(client))
    assert resp.status_code == 422
    assert "rejected" in resp.json()["detail"]
    body = client.get("/api/settings", headers=_auth(client)).json()
    assert body["providers"][1]["source"] == "none"


def test_saved_key_overrides_env_and_delete_restores_it(
    client: TestClient, monkeypatch
) -> None:
    from backend import app as app_module

    monkeypatch.setattr(app_module, "validate_key", _fake_validator(True))
    monkeypatch.setenv("GEMINI_API_KEY", "env-key-1234")

    client.put("/api/settings/keys/gemini", json={"key": "ui-key-5678"},
               headers=_auth(client))
    assert app_module.get_key("gemini") == "ui-key-5678"

    body = client.delete("/api/settings/keys/gemini", headers=_auth(client)).json()
    assert body["source"] == "env"
    assert body["configured"] is True
    assert app_module.get_key("gemini") == "env-key-1234"


def test_health_uses_the_effective_key(client: TestClient, monkeypatch) -> None:
    from backend import app as app_module

    monkeypatch.setattr(app_module, "validate_key", _fake_validator(True))
    assert client.get("/api/health").json()["providers"] == ["mock"]

    client.put("/api/settings/keys/openai", json={"key": "sk-live-abcdefgh"},
               headers=_auth(client))
    assert client.get("/api/health").json()["providers"] == ["openai"]


def test_lost_master_key_falls_back_to_env(client: TestClient, monkeypatch, tmp_path) -> None:
    from backend import app as app_module

    monkeypatch.setattr(app_module, "validate_key", _fake_validator(True))
    client.put("/api/settings/keys/gemini", json={"key": "ui-key-5678"},
               headers=_auth(client))

    # Simulate a restored database without its master key.
    (tmp_path / "master.key").write_bytes(b"x" * 32)
    monkeypatch.setenv("GEMINI_API_KEY", "env-key-1234")

    assert app_module.get_key("gemini") == "env-key-1234"
    status = client.get("/api/settings", headers=_auth(client)).json()["providers"][0]
    assert status["unreadable"] is True
    assert status["source"] == "env"


def test_unknown_provider_is_404(client: TestClient) -> None:
    resp = client.put("/api/settings/keys/anthropic", json={"key": "sk-x"},
                      headers=_auth(client))
    assert resp.status_code == 404
