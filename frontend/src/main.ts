// svenska-tutor frontend session logic.
// Mock-mode aware: if /api/token returns mock:true, no real WS is opened.

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

type Provider = "gemini" | "openai";
interface TokenResp {
  provider: Provider;
  credential: string | null;
  ws_url: string | null;
  mock: boolean;
  model?: string | null;
  detail?: string;
}

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

interface LiveMsg {
  setupComplete?: boolean;
  serverContent?: {
    modelTurn?: { parts?: Array<{ text?: string }> };
    inputTranscription?: { text?: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}



// --- provider message parsers ---
function parseGeminiMsg(msg: Record<string, unknown>): void {
  const live = msg as unknown as LiveMsg;
  if (live.setupComplete) setStatus("live — tutor listening");
  const sc = live.serverContent;
  if (!sc) return;
  const parts = sc.modelTurn?.parts ?? [];
  for (const p of parts) {
    if (p.text) $("#tt-tutor")!.textContent = p.text;
  }
  if (sc.inputTranscription?.text) $("#tt-user")!.textContent = sc.inputTranscription.text;
  if (sc.interrupted) setStatus("barge-in");
}

interface OpenAIMsg {
  type: string;
  delta?: string;
  transcript?: string;
}

function parseOpenAIMsg(msg: Record<string, unknown>): void {
  const m = msg as unknown as OpenAIMsg;
  if (m.type === "session.created") setStatus("live — tutor listening");
  if (m.type === "response.output_audio_transcript.delta" && m.delta) {
    $("#tt-tutor")!.textContent = m.delta;
  }
  if (m.type === "conversation.item.input_audio_transcription.completed" && m.transcript) {
    $("#tt-user")!.textContent = m.transcript;
  }
}

import { initAvatar, setAvatarMouth, avatarActive } from './avatar';

let analyser: AnalyserNode | null = null;
let tutorAudioReady = false;

function audioRms(): number {
  if (!analyser) return 0;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
  return Math.sqrt(sum / buf.length);
}

function authHeaders(): HeadersInit {
  const pass = localStorage.getItem("app_password") ?? "";
  return { Authorization: `Bearer ${pass}` };
}

function setStatus(s: string): void {
  const el = document.querySelector<HTMLElement>("#status");
  if (el) el.textContent = s;
}

function banner(msg: string): void {
  const b = $("#banner")!;
  b.textContent = msg;
  b.hidden = false;
}

async function startSession(): Promise<void> {
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
  }

  // Mic + AudioWorklet (user-gesture initiated: satisfies iOS Safari)
  state.mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  state.audioCtx = new AudioContext({ sampleRate: 16000 });
  await state.audioCtx.audioWorklet.addModule("/src/worklets/recorder-worklet.js");
  state.worklet = new AudioWorkletNode(state.audioCtx, "pcm-recorder");
  state.worklet.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
    // Barge-in: keep sending while the tutor speaks; the model's VAD handles
    // turn-taking. Gemini shape: realtimeInput.mediaChunks, base64 PCM16.
    if (!(ev.data instanceof ArrayBuffer)) return;
    if (state.running && state.ws && state.ws.readyState === WebSocket.OPEN) {
      const b64 = arrayBufferToBase64(ev.data);
      if (state.provider === "gemini") {
        state.ws.send(JSON.stringify({
          realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: b64 }] },
        }));
      } else {
        state.ws.send(JSON.stringify({
          type: "input_audio_buffer.append", audio: b64,
        }));
      }
    }
  };
  const source = state.audioCtx.createMediaStreamSource(state.mediaStream);
  source.connect(state.worklet);
  state.worklet.connect(state.audioCtx.destination); // keep worklet pulled on iOS

  if (!token.mock) {
    // Connect IMMEDIATELY after minting — the ephemeral token's
    // new_session_expire_time is 1 minute; mint->connect must be fast.
    state.ws = new WebSocket(token.ws_url!);
    state.ws.binaryType = "arraybuffer";
    state.ws.onopen = () => {
      setStatus("sending setup…");
      if (provider === "gemini") {
        state.ws!.send(JSON.stringify({
          setup: {
            model: "models/gemini-3.8-live",
            generation_config: {
              response_modalities: ["AUDIO"],
              speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Aoede" } } },
            },
            system_instruction: { parts: [{ text: TUTOR_PROMPT }] },
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
    state.ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return void playAudio(ev.data);
      const msg = JSON.parse(ev.data) as Record<string, unknown>;
      if (provider === "gemini") return parseGeminiMsg(msg);
      return parseOpenAIMsg(msg);
    };
    state.ws.onclose = (ev) => setStatus(`disconnected (${ev.code})`);
  }

  // Wake Lock: keep screen on while practicing (iOS 16.4+)
  try {
    state.wakeLock = (await navigator.wakeLock.request("screen")) as WakeLockSentinel;
  } catch {
    /* wake lock optional */
  }

  state.running = true;
  state.startedAt = Date.now();
  if (!avatarActive()) {
    const canvas = document.querySelector<HTMLCanvasElement>('#avatar-canvas');
    if (canvas) void initAvatar(canvas);
  }
  document.querySelector<HTMLButtonElement>("#mic")!.hidden = true;
  document.querySelector<HTMLButtonElement>("#stop")!.hidden = false;
  document.querySelector<HTMLButtonElement>("#mic")!.disabled = true;
  setStatus(token.mock ? "mock session" : "live");
}

async function stopSession(): Promise<void> {
  state.running = false;
  state.ws?.close();
  state.worklet?.disconnect();
  state.mediaStream?.getTracks().forEach((t) => t.stop());
  await state.audioCtx?.close();
  state.audioCtx = null;
  await state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  document.querySelector<HTMLButtonElement>("#mic")!.hidden = false;
  document.querySelector<HTMLButtonElement>("#stop")!.hidden = true;
  setStatus("idle");
}

let playbackCtx: AudioContext | null = null;

function playAudio(pcm: ArrayBuffer | Blob): void {
  // Tutor playback: PCM16 24kHz mono from the provider. Schedule + analyse.
  if (!playbackCtx) playbackCtx = new AudioContext({ sampleRate: 24000 });
  const ctx = playbackCtx;
  void ctx.resume();
  const buf = pcm instanceof ArrayBuffer ? pcm : null;
  if (!buf) return;
  const i16 = new Int16Array(buf);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = (i16[i] ?? 0) / 0x8000;
  const buffer = ctx.createBuffer(1, f32.length, 24000);
  buffer.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  if (!analyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
  }
  src.connect(analyser);
  analyser.connect(ctx.destination);
  src.start();
  tutorAudioReady = true;
}

// mouth animation loop: RMS from the analyser -> VRM mouth
setInterval(() => {
  if (avatarActive() && tutorAudioReady) setAvatarMouth(audioRms());
}, 80);


document.querySelector<HTMLButtonElement>("#mic")!.addEventListener("click", () => void startSession());
document.querySelector<HTMLButtonElement>("#stop")!.addEventListener("click", () => void stopSession());
document.addEventListener("visibilitychange", () => {
  // iOS suspends WebAudio on background; resume on return
  if (document.visibilityState === "visible" && state.audioCtx?.state === "suspended") {
    void state.audioCtx.resume();
  }
});


// --- photo homework mode ---
document.querySelector<HTMLInputElement>("#photo-input")!.addEventListener("change", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  setStatus("reading homework…");
  const b64 = await downscaleToJpeg(file, 1568);
  const provider = document.querySelector<HTMLSelectElement>("#provider")!.value;
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
  const panel = document.querySelector<HTMLElement>("#explanation")!;
  panel.hidden = false;
  document.querySelector<HTMLElement>("#explanation-text")!.textContent = data.explanation;
  // Gemini: also inject the photo into the live session so she can talk about it
  if (provider === "gemini" && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      realtimeInput: { mediaChunks: [{ mimeType: "image/jpeg", data: b64 }] },
    }));
  }
  setStatus("homework explained");
});

async function downscaleToJpeg(file: File, maxEdge: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!;
}

document.querySelector<HTMLButtonElement>("#photo")!.addEventListener("click", () => {
  document.querySelector<HTMLInputElement>("#photo-input")!.click();
});

// --- iOS polish (P1-6) ---
// Wake Locks expire on backgrounding: re-acquire on visibility return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.running) {
    if (!state.wakeLock) {
      void navigator.wakeLock?.request("screen").then((lock) => { state.wakeLock = lock; }).catch(() => {});
    }
    void state.audioCtx?.resume();
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
  document.querySelector<HTMLElement>("#session-minutes")!.textContent = `${mins} min`;
}, 15000);

// Service worker registration (PWA install)
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
