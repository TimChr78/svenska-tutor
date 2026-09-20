# Implementation Plan

Voice-first Swedish tutor for a native Thai speaker. Single user (family),
self-hosted on Unraid via Docker, AI via provider APIs. Public repo, private
data: no keys, transcripts, photos, or personal info ever enter this repo.

## Providers

| | Gemini 3.8 Live (default) | OpenAI GPT-Realtime-2.1 |
|---|---|---|
| Cost/min blended | ~$0.011 | ~$0.25–0.30 |
| Live image input | Yes (photo joins the session) | No (photo → separate vision call + TTS) |
| Thai↔Swedish code-switch | Native | Strong |
| Auth from browser | Ephemeral token | Ephemeral client secret |

Provider is a per-session choice in the UI. The backend exposes
`POST /token/{provider}` minting short-lived credentials; the browser connects
directly to the provider's realtime endpoint. Missing API key → provider hidden
in the UI.

## Tutor prompt (shared by both providers)

```
You are an encouraging Swedish language tutor for a native Thai speaker.
- Primary spoken language: clear, natural Swedish adjusted for SFI learners.
- Auxiliary language: Thai. If the user struggles, answers in Thai, or asks
  for clarification, explain the grammar or vocabulary in simple Thai, then
  return to Swedish.
- Keep responses short (2-4 sentences) so the user speaks more than you.
- Correct major errors gently: repeat the sentence correctly, name the rule
  in Thai, move on. Never interrupt the user's flow for minor slips.
- When the user shares a homework photo, walk through it exercise by
  exercise: ask what she thinks first, then guide — never just give answers.
```

## Phases

### Phase 1 — core (voice + avatar + photo)
1. Backend skeleton: FastAPI, password gate, `POST /token/{provider}`,
   SQLite session log (schema: sessions, turns, corrections)
2. Frontend PWA skeleton: mic button, AudioWorklet PCM16 capture @16 kHz,
   playback queue @24 kHz, barge-in, live transcript panels
3. Gemini provider adapter (WebSocket + ephemeral token) — primary
4. OpenAI provider adapter (Realtime WS + client secret) — parity
5. Photo mode: camera capture → Gemini inline image / OpenAI vision call
6. VRM avatar: three-vrm, mouth open/viseme from playback audio energy,
   idle blink + head sway; avatar picker (2-3 VRoid models bundled or linked)
7. Polish: Wake Lock during session, audio-resume on visibilitychange,
   PWA manifest + service worker, iOS Safari quirks

### Phase 2 — learning loop
- Corrections table UI: said → better → rule (Thai)
- End-of-session recap screen (top 5 corrections + practiced vocabulary)
- Streak counter; simple spaced-repetition deck from corrections
- Scenario presets: Vardag, Handla mat, Väder, Jobbintervju, SFI-övning,
  Fri konversation

### Phase 3 — only if used
- Daily nudge (ntfy) with a scenario suggestion
- Voice speed control; Thai-only "explain mode" toggle
- Progress charts (minutes practiced, corrections avoided week-over-week)

## CI (GitHub Actions)

- lint (ruff) + typecheck (mypy) + vitest + python tests on every PR
- PR-Agent review (BYOK) on every PR
- Docker build check (no push) on every PR; images built locally on Unraid

## Secrets policy

No secrets, transcripts, photos, or personal data in this repo. Keys live in
`.env` (gitignored, template in `.env.example`); user data lives in container
volumes only.
