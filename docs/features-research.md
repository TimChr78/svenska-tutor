# Feature Research — AI language learning apps (Sep 2026)

Sources: AICodeKing's Bambooed demo, LangChain's Jev harness guide, Praktika's
2026 app ranking (criteria: speaking output, in-the-moment feedback, real-life
scenarios, session flex, honest price), Stimuler's Duolingo-alternatives roundup
(Stimuler, ELSA Speak, Babbel, Busuu, Speak, Preply), plus Speak/ELSA feature
sets. Scope reminder: ONE user (Thai native learning Swedish), self-hosted,
Tailscale-only. Anything that doesn't serve that is out.

## What the commercial apps compete on (2026 consensus)

1. **Speaking output per session** — minutes of the user talking, not tapping
   (Praktika's #1 criterion; ours is already voice-first, so we win this by
   design)
2. **In-the-moment correction** — pronunciation + grammar caught WHILE
   speaking, not a post-lesson report (ELSA's core, Praktika's live feedback)
3. **Scenario library** — real-life situations (client calls, ordering,
   small talk) rather than abstract lessons
4. **Session flexibility** — 5-minute sessions must be worth doing
5. **Peer/human feedback** — Busuu's natives, Preply's tutors (out of scope
   for a single-user family app)
6. **Gamified habit layer** — streaks, XP, mascots (Duolingo's lane; keeps
   you opening the app, doesn't teach speaking)

## Features worth adopting (mapped to our phases)

### Already shipped in our Phase 1
- Live speech-to-speech with barge-in (matches Praktika's core interaction)
- Scenario presets (SFI, shopping, weather, interview, free talk)
- Thai fallback explanations (unique to us — most apps are English-bridge)
- Correction cards (said → better → rule)
- Photo homework mode (rare even commercially — Speak has it partially)

### Phase 2 candidates (prioritized for a single Thai→Swedish user)

- **P2-a. End-of-session recap** (already planned): top corrections +
  vocabulary list. Every serious app has a variant of this.
- **P2-b. Pronunciation scoring**: ELSA's moat. Gemini's transcription gives
  us what she SAID; comparing it to what she MEANT gives a proxy for
  pronunciation errors. A simple "listen again: X vs Y" card. (True
  phoneme scoring is ELSA-grade ML — skip; the proxy is 80% of the value.)
- **P2-c. Spaced repetition from corrections**: corrections become a deck;
  resurface the oldest un-practiced item after N sessions. (Speak does this
  with "conversation memory".) Small, high-value.
- **P2-d. Session minutes + streak**: Duolingo's retention layer. One number
  on the home screen; zero gamification beyond that (adult user).
- **P2-e. Difficulty dial**: "slower please" / "simpler words" toggle that
  adjusts the prompt mid-session. Cheap: one line in the session config.
- **P2-f. Daily scenario suggestion**: on session open, suggest today's
  scenario based on the least-recently-practiced one (n8n/ntfy optional
  push later).

### Explicitly OUT of scope (per single-user Swedish-only scope)
- Multi-language support, leaderboards/social, peer corrections, human
  tutor marketplace, exam prep (IELTS etc.), offline mode, iOS/Android
  native apps, subscription billing.

## Notes
- The 2026 market leader pattern (Praktika ~$8/mo) validates the interaction
  model we built: pick scenario → talk → in-the-moment corrections → recap.
- Our differentiators vs the commercial apps: self-hosted privacy (nothing
  leaves home except the model API), Thai-first explanations (rare), photo
  homework mode, zero subscription.
