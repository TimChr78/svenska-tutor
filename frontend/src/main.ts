// svenska-tutor frontend session logic.
// Mock-mode aware: if /api/token returns mock:true, no real WS is opened.

import { initAvatar, setAvatarMouth, avatarActive } from "./avatar";
import {
  arrayBufferToBase64,
  frameToText,
  parseMessageText,
  resamplePcm16,
  type LiveEvent,
  type Provider,
} from "./protocol";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

interface TokenResp {
  provider: Provider;
  credential: string | null;
  ws_url: string | null;
  mock: boolean;
  model?: string | null;
  detail?: string;
}

/** What the Gemini Live API expects from us, and what OpenAI Realtime expects. */
const MIC_RATE = 16000;
const MAX_TRANSCRIPT_CHARS = 2000;

const state = {
  running: false,
  provider: "gemini" as Provider,
  ws: null as WebSocket | null,
  audioCtx: null as AudioContext | null,
  mediaStream: null as MediaStream | null,
  worklet: null as AudioWorkletNode | null,
  wakeLock: null as WakeLockSentinel | null,
  sessionId: null as number | null,
  startedAt: 0,
};

// Shared tutor prompt (both providers) — see docs/plan.md.
const TUTOR_PROMPT = `You are an encouraging Swedish language tutor for a native Thai speaker.
- Primary spoken language: clear, natural Swedish adjusted for SFI learners.
- Auxiliary language: Thai. If the user struggles, answers in Thai, or asks for
  clarification, explain the grammar or vocabulary in simple Thai, then return
  to Swedish.
- Keep responses short (2-4 sentences) so the user speaks more than you do.
- Correct major errors gently: repeat the sentence correctly, name the rule in
  Thai, move on. Never interrupt the user's flow for minor slips.`;

function authHeaders(): HeadersInit {
  const pass = localStorage.getItem("app_password") ?? "";
  return { Authorization: `Bearer ${pass}` };
}

function setStatus(s: string): void {
  const el = document.querySelector<HTMLElement>("#status");
  if (el) el.textContent = s;
}

function banner(msg: string): void {
  const b = document.querySelector<HTMLElement>("#banner");
  if (!b) return;
  if (!msg) {
    b.hidden = true;
    b.textContent = "";
    return;
  }
  b.textContent = msg;
  b.hidden = false;
}

// --- transcript ------------------------------------------------------------

const transcript = { user: "", tutor: "" };

function renderTranscript(which: "user" | "tutor"): void {
  const el = document.querySelector<HTMLElement>(which === "user" ? "#tt-user" : "#tt-tutor");
  if (!el) return;
  const text = transcript[which].trim();
  el.textContent = text || "—";
}

/** Providers stream partial text: Gemini/OpenAI deltas append, finals replace. */
function addTranscript(which: "user" | "tutor", text: string, append: boolean): void {
  transcript[which] = (append ? transcript[which] + text : text).slice(-MAX_TRANSCRIPT_CHARS);
  renderTranscript(which);
}

function resetTranscript(): void {
  transcript.user = "";
  transcript.tutor = "";
  renderTranscript("user");
  renderTranscript("tutor");
}

// --- tutor audio playback --------------------------------------------------

const player = {
  ctx: null as AudioContext | null,
  analyser: null as AnalyserNode | null,
  playhead: 0,
  sources: new Set<AudioBufferSourceNode>(),
};

let tutorAudioReady = false;

function ensurePlayer(): { ctx: AudioContext; analyser: AnalyserNode } {
  if (!player.ctx || !player.analyser) {
    const ctx = new AudioContext({ sampleRate: 24000 });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    analyser.connect(gain);
    gain.connect(ctx.destination);
    player.ctx = ctx;
    player.analyser = analyser;
    player.playhead = 0;
  }
  if (player.ctx.state === "suspended") void player.ctx.resume();
  return { ctx: player.ctx, analyser: player.analyser };
}

/**
 * Queue PCM16 from the tutor. Chunks are scheduled end-to-end instead of
 * starting immediately, otherwise every 40 ms chunk plays on top of the
 * previous one and the speech turns into noise.
 */
function enqueueAudio(pcm: Int16Array, sampleRate: number): void {
  if (pcm.length === 0) return;
  const { ctx, analyser } = ensurePlayer();
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 0x8000;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(analyser);
  const startAt = Math.max(ctx.currentTime + 0.03, player.playhead);
  src.start(startAt);
  player.playhead = startAt + buffer.duration;
  player.sources.add(src);
  src.onended = () => player.sources.delete(src);
  tutorAudioReady = true;
}

function flushAudio(): void {
  for (const src of player.sources) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  player.sources.clear();
  if (player.ctx) player.playhead = player.ctx.currentTime;
}

function audioRms(): number {
  if (!player.analyser) return 0;
  const buf = new Uint8Array(player.analyser.frequencyBinCount);
  player.analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.sqrt(sum / buf.length);
}

// mouth animation loop: RMS from the analyser -> VRM mouth
setInterval(() => {
  if (avatarActive() && tutorAudioReady) setAvatarMouth(audioRms());
}, 80);

// --- level meter -----------------------------------------------------------

function setLevel(level: number): void {
  const bar = document.querySelector<HTMLElement>("#level-bar");
  if (bar) bar.style.width = `${Math.round(Math.min(1, level) * 100)}%`;
}

function pcmLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(pcm.length / 512));
  let n = 0;
  for (let i = 0; i < pcm.length; i += step) {
    const x = (pcm[i] ?? 0) / 0x8000;
    sum += x * x;
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n)) * 3;
}

// --- provider events -------------------------------------------------------

function handleEvents(events: LiveEvent[]): void {
  for (const ev of events) {
    switch (ev.kind) {
      case "ready":
        setStatus("live — prata svenska!");
        break;
      case "audio":
        enqueueAudio(ev.pcm, ev.sampleRate);
        break;
      case "tutorText":
        addTranscript("tutor", ev.text, ev.append);
        break;
      case "userText":
        addTranscript("user", ev.text, ev.append);
        break;
      case "interrupted":
        flushAudio();
        setStatus("barge-in");
        break;
      case "turnComplete":
        setStatus("live — prata svenska!");
        break;
      case "error":
        banner(`Provider error: ${ev.message}`);
        setStatus("error");
        break;
    }
  }
}

function handleFrame(data: unknown): void {
  // Gemini sends JSON inside binary frames; keep the synchronous path ordered.
  if (data instanceof ArrayBuffer) {
    handleEvents(parseMessageText(new TextDecoder().decode(data), state.provider));
    return;
  }
  if (typeof data === "string") {
    handleEvents(parseMessageText(data, state.provider));
    return;
  }
  void frameToText(data).then((text) => {
    if (text !== null) handleEvents(parseMessageText(text, state.provider));
  });
}

// --- session ---------------------------------------------------------------

function sendMicChunk(data: unknown): void {
  if (!(data instanceof ArrayBuffer)) return;
  let pcm: Int16Array<ArrayBufferLike> = new Int16Array(data);
  setLevel(pcmLevel(pcm));
  if (!state.running || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const ctxRate = state.audioCtx?.sampleRate ?? MIC_RATE;
  if (ctxRate !== MIC_RATE) pcm = resamplePcm16(pcm, ctxRate, MIC_RATE);
  const b64 = arrayBufferToBase64(pcm.buffer);
  if (state.provider === "gemini") {
    state.ws.send(JSON.stringify({
      realtimeInput: { audio: { mimeType: `audio/pcm;rate=${MIC_RATE}`, data: b64 } },
    }));
  } else {
    state.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
  }
}

function endMicStream(): void {
  // Lets the server's VAD close the current turn instead of waiting for silence.
  if (state.ws?.readyState === WebSocket.OPEN && state.provider === "gemini") {
    state.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }
}

async function startSession(): Promise<void> {
  if (state.running) return;
  try {
    // Microphone requires a secure context (HTTPS or localhost) on iOS Safari.
    if (!window.isSecureContext) {
      banner(
        "Microphone needs HTTPS. Open the app via the Tailscale HTTPS URL " +
          "(tailscale serve maps port 3100 → https on the tower).",
      );
      return;
    }
    const providerSel = document.querySelector<HTMLSelectElement>("#provider");
    const provider = (providerSel?.value ?? "gemini") as Provider;
    state.provider = provider;
    setStatus("minting token…");

    const resp = await fetch(`/api/token/${provider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ provider, scenario: null }),
    });
    if (resp.status === 401) {
      const pass = prompt("App password:");
      if (pass) {
        localStorage.setItem("app_password", pass);
        return startSession();
      }
      return;
    }
    if (!resp.ok) {
      banner(`Token mint failed: ${resp.status}`);
      return;
    }
    const token = (await resp.json()) as TokenResp;
    state.sessionId = (token as unknown as { session_id?: number }).session_id ?? null;

    if (token.mock) {
      banner("Mock provider (no API key configured) — audio loop simulated, nothing sent.");
      setStatus("mock session");
    } else {
      banner("");
    }

    // Mic + AudioWorklet (user-gesture initiated: satisfies iOS Safari)
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    state.audioCtx = new AudioContext({ sampleRate: MIC_RATE });
    // Served from public/, not bundled — a /src/ URL 404s in the production build.
    await state.audioCtx.audioWorklet.addModule("/worklets/recorder-worklet.js");
    state.worklet = new AudioWorkletNode(state.audioCtx, "pcm-recorder");
    state.worklet.port.onmessage = (ev: MessageEvent) => sendMicChunk(ev.data);
    const source = state.audioCtx.createMediaStreamSource(state.mediaStream);
    source.connect(state.worklet);
    // A worklet only runs when connected to a destination; a muted gain keeps it
    // pulled without routing the microphone back into the speakers (feedback).
    const silent = state.audioCtx.createGain();
    silent.gain.value = 0;
    state.worklet.connect(silent);
    silent.connect(state.audioCtx.destination);

    if (!token.mock && token.ws_url) {
      // Connect IMMEDIATELY after minting — the ephemeral token's
      // new_session_expire_time is 1 minute; mint->connect must be fast.
      state.ws = new WebSocket(token.ws_url);
      state.ws.binaryType = "arraybuffer";
      state.ws.onopen = () => {
        setStatus("sending setup…");
        if (provider === "gemini") {
          state.ws!.send(JSON.stringify({
            setup: {
              model: token.model || "models/gemini-3.8-live",
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
              },
              systemInstruction: { parts: [{ text: TUTOR_PROMPT }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          }));
        } else {
          // OpenAI Realtime GA: session.update with pcm16 in/out + tutor instructions
          state.ws!.send(JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              model: token.model ?? "gpt-realtime-2.1",
              instructions: TUTOR_PROMPT,
              voice: "alloy",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: { model: "whisper-1" },
              turn_detection: { type: "server_vad" },
            },
          }));
        }
      };
      state.ws.onmessage = (ev: MessageEvent) => handleFrame(ev.data);
      state.ws.onerror = () => {
        banner("Connection error — check the server logs and provider API key.");
        setStatus("connection error");
      };
      state.ws.onclose = (ev) => {
        if (!state.running) return;
        state.running = false;
        setStatus(`disconnected (${ev.code})`);
      };
    }

    // Wake Lock: keep screen on while practicing (iOS 16.4+)
    try {
      state.wakeLock = (await navigator.wakeLock.request("screen")) as WakeLockSentinel;
    } catch {
      /* wake lock optional */
    }

    state.running = true;
    state.startedAt = Date.now();
    resetTranscript();
    const canvas = document.querySelector<HTMLCanvasElement>("#avatar-canvas");
    if (canvas) {
      void initAvatar(canvas).then((ok) => {
        canvas.hidden = !ok;
        const ring = document.querySelector<HTMLElement>("#avatar-ring");
        if (ring) ring.hidden = ok;
      });
    }
    const micBtn = document.querySelector<HTMLButtonElement>("#mic");
    if (micBtn) micBtn.hidden = true;
    const stopBtn = document.querySelector<HTMLButtonElement>("#stop");
    if (stopBtn) stopBtn.hidden = false;
    setStatus(token.mock ? "mock session (no API key)" : "live");
  } catch (err) {
    banner(`Could not start: ${err instanceof Error ? err.message : String(err)}`);
    setStatus("failed");
  }
}

async function stopSession(): Promise<void> {
  endMicStream();
  state.running = false;
  state.ws?.close();
  state.ws = null;
  state.worklet?.disconnect();
  state.worklet = null;
  state.mediaStream?.getTracks().forEach((t) => t.stop());
  state.mediaStream = null;
  await state.audioCtx?.close().catch(() => {});
  state.audioCtx = null;
  flushAudio();
  setLevel(0);
  await state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  const micBtn = document.querySelector<HTMLButtonElement>("#mic");
  if (micBtn) micBtn.hidden = false;
  const stopBtn = document.querySelector<HTMLButtonElement>("#stop");
  if (stopBtn) stopBtn.hidden = true;
  setStatus("idle");
}

// --- photo homework mode ---------------------------------------------------

async function downscaleToJpeg(file: File, maxEdge: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!;
}

async function onPhotoFile(this: HTMLInputElement): Promise<void> {
  const file = this.files?.[0];
  if (!file) return;
  this.value = ""; // allow picking the same file again
  setStatus("reading homework…");
  const b64 = await downscaleToJpeg(file, 1568);
  const provider = document.querySelector<HTMLSelectElement>("#provider")?.value ?? "gemini";
  const resp = await fetch(`/api/vision/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ image_b64: b64, mime: "image/jpeg" }),
  });
  const data = (await resp.json()) as { explanation?: string; detail?: string };
  if (!resp.ok || !data.explanation) {
    banner(`Homework explain failed: ${data.detail ?? resp.status}`);
    return;
  }
  const panel = document.querySelector<HTMLElement>("#explanation");
  if (panel) panel.hidden = false;
  const text = document.querySelector<HTMLElement>("#explanation-text");
  if (text) text.textContent = data.explanation;
  // Gemini: also inject the photo into the live session so she can talk about it
  if (provider === "gemini" && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: b64 } }] }],
        turnComplete: false,
      },
    }));
  }
  setStatus("homework explained");
}

// --- wiring ----------------------------------------------------------------

function wire(): void {
  document.querySelector<HTMLButtonElement>("#mic")?.addEventListener("click", () => void startSession());
  document.querySelector<HTMLButtonElement>("#stop")?.addEventListener("click", () => void stopSession());

  document.querySelector<HTMLButtonElement>("#photo-cam")?.addEventListener("click", () => {
    document.querySelector<HTMLInputElement>("#photo-input-cam")?.click();
  });
  document.querySelector<HTMLButtonElement>("#photo-gal")?.addEventListener("click", () => {
    document.querySelector<HTMLInputElement>("#photo-input-gal")?.click();
  });
  document.querySelector<HTMLInputElement>("#photo-input-cam")?.addEventListener("change", onPhotoFile);
  document.querySelector<HTMLInputElement>("#photo-input-gal")?.addEventListener("change", onPhotoFile);

  // iOS suspends WebAudio on background and drops wake locks: recover on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void state.audioCtx?.resume();
    void player.ctx?.resume();
    if (state.running && !state.wakeLock) {
      void navigator.wakeLock
        ?.request("screen")
        .then((lock) => { state.wakeLock = lock; })
        .catch(() => {});
    }
  });

  // Warn before leaving mid-session
  window.addEventListener("beforeunload", (ev) => {
    if (state.running) ev.preventDefault();
  });

  // Session minutes ticker
  setInterval(() => {
    if (!state.running) return;
    const mins = Math.floor((Date.now() - state.startedAt) / 60000);
    const el = document.querySelector<HTMLElement>("#session-minutes");
    if (el) el.textContent = `${mins} min`;
  }, 15000);

  // Service worker registration (PWA install)
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
  }

  renderTranscript("user");
  renderTranscript("tutor");
}

wire();
