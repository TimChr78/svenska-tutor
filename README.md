# svenska-tutor

Voice-first Swedish tutor for Thai speakers. A private, self-hosted web app:
talk to an AI tutor in Swedish, get gentle corrections, fall back to Thai when
stuck, photograph your homework and work through it together.

Built as a family app for one user, shared as open source because the code
might help others build the same for their families.

## Features

- **Live voice conversation** — speech-to-speech with barge-in (interrupt the
  tutor mid-sentence), ~300–500 ms latency
- **Dual provider** — Gemini Live API (default) or OpenAI Realtime, selected
  per session; one shared tutor prompt works with both
- **Photo homework mode** — photograph a worksheet; on Gemini the image joins
  the live conversation, on OpenAI it routes through a vision-call explain flow
- **Animated VRM avatar** — the tutor is a browser-rendered 3D character
  (three-vrm) with audio-driven mouth movement and idle motion
- **Thai fallback** — grammar explanations in Thai when she struggles, then
  back to Swedish
- **Correction log** — every correction saved (said → better → rule) with an
  end-of-session recap
- **PWA** — installable on iPhone/iPad/Android; Wake Lock keeps the screen on
  during practice

## Status

Work in progress. Phase 1 (voice tutor + avatar + photo mode) in active
development. See [docs/plan.md](docs/plan.md) for the full plan.

## Self-hosting (Unraid / Docker)

```bash
cp .env.example .env    # add your API keys
docker compose up -d    # http://<host>:3000
```

Requires at least one of: `GEMINI_API_KEY` (aistudio.google.com) or
`OPENAI_API_KEY` (platform.openai.com). Keys never leave the server — the
browser gets short-lived ephemeral credentials minted by the backend.

## Stack

- **Backend**: Python FastAPI (auth, ephemeral-token minting, session log)
- **Frontend**: vanilla TypeScript PWA, WebAudio AudioWorklet capture,
  three-vrm avatar
- **AI**: Gemini Live API / OpenAI Realtime (speech-to-speech)

## License

MIT
