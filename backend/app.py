"""svenska-tutor backend — FastAPI entrypoint.

Auth gate, ephemeral token minting (real or mock), SQLite session log,
static frontend serving. No secrets in this repo: everything from env.
"""
from __future__ import annotations

import json
import os
import secrets
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
    if not expected or not secrets.compare_digest(authorization, f"Bearer {expected}"):
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
    # Every session is logged; the frontend needs the id to write turns back.
    session_id: int | None = None


@app.post("/api/token/{provider}")
def mint_token(provider: str, body: TokenRequest,
               authorization: str = Depends(require_password)) -> TokenResponse:
    """Mint a short-lived credential for the browser's direct provider
    connection. Returns a mock credential when the provider key is absent
    (development/CI mode)."""
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
            return TokenResponse(provider=provider, mock=True, session_id=session_id)
        # The raw REST endpoint 404s — ephemeral token minting goes through the
        # official google-genai SDK (verified 2026-09-20).
        import datetime

        from google import genai

        client = genai.Client(api_key=key)
        now = datetime.datetime.now(tz=datetime.UTC)
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
        return TokenResponse(provider=provider, credential=tok, ws_url=ws,
                             model="models/gemini-3.8-live", session_id=session_id)

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return TokenResponse(provider=provider, mock=True, session_id=session_id)
    model = os.environ.get("OPENAI_MODEL", "gpt-realtime-2.1")
    resp = httpx.post(
        "https://api.openai.com/v1/realtime/client_secrets",
        headers={"Authorization": f"Bearer {key}"},
        json={"session": {"type": "realtime", "model": model}},
        timeout=15,
    )
    if resp.status_code >= 400:
        # Surface a bad key as a usable message instead of a 500 stack trace.
        raise HTTPException(
            status_code=502,
            detail=f"OpenAI rejected the credential (HTTP {resp.status_code})",
        )
    secret = resp.json()["value"]
    return TokenResponse(provider=provider, credential=secret,
                         ws_url=f"wss://api.openai.com/v1/realtime?model={model}",
                         model=model, session_id=session_id)


class TurnLog(BaseModel):
    session_id: int
    speaker: str
    sv_text: str | None = None
    th_text: str | None = None


def _session_row(conn: sqlite3.Connection, session_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="unknown session")
    return row


@app.post("/api/log/turn")
def log_turn(turn: TurnLog, authorization: str = Depends(require_password)) -> dict:
    if turn.speaker not in ("user", "tutor"):
        raise HTTPException(status_code=400, detail="speaker must be user or tutor")
    if not (turn.sv_text or turn.th_text):
        raise HTTPException(status_code=400, detail="empty turn")
    with db() as conn:
        _session_row(conn, turn.session_id)
        conn.execute(
            "INSERT INTO turns (session_id, ts, speaker, sv_text, th_text) VALUES (?,?,?,?,?)",
            (turn.session_id, time.time(), turn.speaker, turn.sv_text, turn.th_text),
        )
    return {"ok": True}


@app.post("/api/session/{session_id}/end")
def end_session(session_id: int, authorization: str = Depends(require_password)) -> dict:
    """Close a session. Idempotent: a second call keeps the first timestamp."""
    with db() as conn:
        row = _session_row(conn, session_id)
        ended_at = row["ended_at"] or time.time()
        if row["ended_at"] is None:
            conn.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (ended_at, session_id))
        turns = conn.execute(
            "SELECT COUNT(*) FROM turns WHERE session_id = ?", (session_id,)
        ).fetchone()[0]
    return {
        "id": session_id,
        "ended_at": ended_at,
        "seconds": round(ended_at - row["started_at"], 1),
        "turns": turns,
    }


@app.get("/api/session/{session_id}")
def get_session(session_id: int, authorization: str = Depends(require_password)) -> dict:
    with db() as conn:
        row = _session_row(conn, session_id)
        turns = conn.execute(
            "SELECT id, ts, speaker, sv_text, th_text FROM turns "
            "WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
        corrections = conn.execute(
            "SELECT id, said, better, rule_th FROM corrections "
            "WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    return {
        "session": dict(row),
        "turns": [dict(t) for t in turns],
        "corrections": [dict(c) for c in corrections],
    }


@app.get("/api/sessions")
def list_sessions(limit: int = 20, authorization: str = Depends(require_password)) -> dict:
    limit = max(1, min(limit, 100))
    with db() as conn:
        rows = conn.execute(
            "SELECT s.id, s.provider, s.started_at, s.ended_at, s.scenario, "
            "  (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turns, "
            "  (SELECT COUNT(*) FROM corrections c WHERE c.session_id = s.id) AS corrections "
            "FROM sessions s ORDER BY s.id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {"sessions": [dict(r) for r in rows]}


class Correction(BaseModel):
    said: str
    better: str
    rule_th: str | None = None


# The review runs while the learner is waiting for their recap, so it has to be
# quick. gemini-3.8-flash blew past a 60s timeout on a short transcript (it
# spends the time thinking even with thinkingBudget=0); 2.5-flash answers in
# under two seconds.
REVIEW_MODEL = os.environ.get("REVIEW_MODEL", "gemini-2.5-flash")

REVIEW_PROMPT = """You are a Swedish teacher reviewing the transcript of a spoken
lesson with a native Thai speaker. Pick at most 5 mistakes the learner actually
made and that are worth practising.

For each one:
- said: what the learner said, verbatim, in Swedish
- better: the corrected Swedish (natural, SFI level)
- rule_th: one short sentence in Thai naming the rule

Only report real errors from the learner's lines. If the learner made no
significant mistakes, return an empty corrections list."""

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "said": {"type": "string"},
                    "better": {"type": "string"},
                    "rule_th": {"type": "string"},
                },
                "required": ["said", "better", "rule_th"],
            },
        }
    },
    "required": ["corrections"],
}


@app.post("/api/session/{session_id}/review")
def review_session(session_id: int, authorization: str = Depends(require_password)) -> dict:
    """Extract corrections from a finished session and store them.

    Runs one cheap flash call over the transcript. Existing corrections for the
    session are replaced, so this is safe to re-run.
    """
    import httpx

    with db() as conn:
        _session_row(conn, session_id)
        turns = conn.execute(
            "SELECT speaker, sv_text FROM turns WHERE session_id = ? "
            "AND sv_text IS NOT NULL AND sv_text != '' ORDER BY id",
            (session_id,),
        ).fetchall()

    if not turns:
        return {"corrections": [], "reason": "no turns logged"}

    transcript = "\n".join(f"{t['speaker']}: {t['sv_text']}" for t in turns)
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise HTTPException(status_code=400, detail="GEMINI_API_KEY not configured")

    try:
        resp = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{REVIEW_MODEL}:generateContent",
            headers={"x-goog-api-key": key},
            json={
                "systemInstruction": {"parts": [{"text": REVIEW_PROMPT}]},
                "contents": [{"parts": [{"text": transcript}]}],
                "generationConfig": {
                    "temperature": 0.2,
                    "responseMimeType": "application/json",
                    "responseSchema": REVIEW_SCHEMA,
                },
            },
            timeout=30,
        )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="review model timed out")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"review model unreachable ({type(exc).__name__})")
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"review model failed (HTTP {resp.status_code})")

    parts = resp.json()["candidates"][0]["content"]["parts"]
    text = "".join(p.get("text", "") for p in parts).strip()
    try:
        payload = json.loads(text) if text else {"corrections": []}
        items = payload.get("corrections", []) if isinstance(payload, dict) else payload
        found = [Correction(**c) for c in items]
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=502, detail="review model returned malformed JSON")

    with db() as conn:
        conn.execute("DELETE FROM corrections WHERE session_id = ?", (session_id,))
        for c in found[:5]:
            conn.execute(
                "INSERT INTO corrections (session_id, ts, said, better, rule_th) "
                "VALUES (?,?,?,?,?)",
                (session_id, time.time(), c.said, c.better, c.rule_th),
            )
        rows = conn.execute(
            "SELECT id, said, better, rule_th FROM corrections "
            "WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    return {"corrections": [dict(r) for r in rows]}


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


class VisionRequest(BaseModel):
    image_b64: str
    mime: str = "image/jpeg"
    question: str = (
        "This is a Swedish homework page. Describe each exercise briefly in "
        "simple Thai, then explain how to approach it. Do not give the final "
        "answers — guide step by step."
    )


@app.post("/api/vision/{provider}")
def vision(provider: str, body: VisionRequest,
           authorization: str = Depends(require_password)) -> dict:
    """One-shot vision explanation of a homework photo (both providers).
    Gemini also supports in-session images, but this endpoint gives a
    provider-independent 'explain this page' flow for both."""
    import httpx

    image_url = f"data:{body.mime};base64,{body.image_b64}"
    if provider == "gemini":
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise HTTPException(status_code=400, detail="GEMINI_API_KEY not configured")
        resp = httpx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
            headers={"x-goog-api-key": key},
            json={"contents": [{"parts": [
                {"text": body.question},
                {"inline_data": {"mime_type": body.mime, "data": body.image_b64}},
            ]}]},
            timeout=60,
        )
        resp.raise_for_status()
        parts = resp.json()["candidates"][0]["content"]["parts"]
        text = " ".join(p.get("text", "") for p in parts).strip()
        return {"explanation": text}

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise HTTPException(status_code=400, detail="OPENAI_API_KEY not configured")
    model = os.environ.get("OPENAI_VISION_MODEL", "gpt-4.1-mini")
    resp = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": model, "messages": [{"role": "user", "content": [
            {"type": "text", "text": body.question},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]}]},
        timeout=60,
    )
    resp.raise_for_status()
    text = resp.json()["choices"][0]["message"]["content"].strip()
    return {"explanation": text}
