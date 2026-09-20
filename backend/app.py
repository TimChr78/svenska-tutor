"""svenska-tutor backend — FastAPI entrypoint.

Auth gate, ephemeral token minting (real or mock), SQLite session log,
static frontend serving. No secrets in this repo: everything from env.
"""
from __future__ import annotations

import os
import sqlite3
import time
from contextlib import asynccontextmanager as _asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "sessions.db"
FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

PROVIDERS: dict[str, bool] = {}
PROVIDERS["gemini"] = bool(os.environ.get("GEMINI_API_KEY"))
PROVIDERS["openai"] = bool(os.environ.get("OPENAI_API_KEY"))


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL,
                started_at REAL NOT NULL,
                ended_at REAL,
                scenario TEXT
            );
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL REFERENCES sessions(id),
                ts REAL NOT NULL,
                speaker TEXT NOT NULL,          -- 'user' | 'tutor'
                sv_text TEXT,
                th_text TEXT
            );
            CREATE TABLE IF NOT EXISTS corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL REFERENCES sessions(id),
                ts REAL NOT NULL,
                said TEXT NOT NULL,
                better TEXT NOT NULL,
                rule_th TEXT
            );
            """
        )


@_asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="svenska-tutor", lifespan=lifespan)


def require_password(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("APP_PASSWORD", "")
    if not expected or authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="unauthorized")


class TokenRequest(BaseModel):
    provider: str
    scenario: str | None = None


class TokenResponse(BaseModel):
    provider: str
    credential: str | None = None
    ws_url: str | None = None
    mock: bool = False
    model: str | None = None


@app.post("/api/token/{provider}")
def mint_token(provider: str, body: TokenRequest,
               authorization: str = Depends(require_password)) -> TokenResponse:
    """Mint a short-lived credential for the browser's direct provider
    connection. Returns a mock credential when the provider key is absent
    (development/CI mode)."""
    init_db()

    import httpx

    if provider not in ("gemini", "openai"):
        raise HTTPException(status_code=400, detail="unknown provider")

    with db() as conn:
        cur = conn.execute(
            "INSERT INTO sessions (provider, started_at, scenario) VALUES (?,?,?)",
            (provider, time.time(), body.scenario),
        )
        session_id = cur.lastrowid

    if provider == "gemini":
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            return TokenResponse(provider=provider, mock=True)  # type: ignore[call-arg]
        # The raw REST endpoint 404s — ephemeral token minting goes through the
        # official google-genai SDK (verified 2026-09-20).
        import datetime

        from google import genai

        client = genai.Client(api_key=key)
        now = datetime.datetime.now(tz=datetime.timezone.utc)
        token = client.auth_tokens.create(
            config={
                "uses": 1,
                "expire_time": now + datetime.timedelta(minutes=30),
                # Browser must connect within 1 minute of minting.
                "new_session_expire_time": now + datetime.timedelta(minutes=1),
            }
        )
        tok = token.name.split("/")[-1]
        # Ephemeral tokens REQUIRE the Constrained endpoint with access_token.
        ws = (f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage"
              f".v1beta.GenerativeService.BidiGenerateContentConstrained?access_token={tok}")
        return TokenResponse(provider=provider, credential=tok, ws_url=ws)

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return TokenResponse(provider=provider, mock=True, session_id_hint=session_id)  # type: ignore[call-arg]
    model = os.environ.get("OPENAI_MODEL", "gpt-realtime-2.1")
    resp = httpx.post(
        "https://api.openai.com/v1/realtime/client_secrets",
        headers={"Authorization": f"Bearer {key}"},
        json={"session": {"type": "realtime", "model": model}},
        timeout=15,
    )
    resp.raise_for_status()
    secret = resp.json()["value"]
    return TokenResponse(provider=provider, credential=secret,
                         ws_url=f"wss://api.openai.com/v1/realtime?model={model}",
                         model=model)


def _in_minutes(n: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(minutes=n)).isoformat()


class TurnLog(BaseModel):
    session_id: int
    speaker: str
    sv_text: str | None = None
    th_text: str | None = None


@app.post("/api/log/turn")
def log_turn(turn: TurnLog, authorization: str = Depends(require_password)) -> dict:
    init_db()
    with db() as conn:
        conn.execute(
            "INSERT INTO turns (session_id, ts, speaker, sv_text, th_text) VALUES (?,?,?,?,?)",
            (turn.session_id, time.time(), turn.speaker, turn.sv_text, turn.th_text),
        )
    return {"ok": True}


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "providers": [p for p, ok in PROVIDERS.items() if ok] or ["mock"]}


# --- static frontend (last: API routes take precedence) ---
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str) -> FileResponse:
        candidate = FRONTEND_DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
