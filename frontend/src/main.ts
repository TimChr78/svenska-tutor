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

function playAudio(_pcm: ArrayBuffer): void {
  // playback queue lands in P1-2 (Gemini adapter) — 24kHz PCM scheduling
}

document.querySelector<HTMLButtonElement>("#mic")!.addEventListener("click", () => void startSession());
document.querySelector<HTMLButtonElement>("#stop")!.addEventListener("click", () => void stopSession());
document.addEventListener("visibilitychange", () => {
  // iOS suspends WebAudio on background; resume on return
  if (document.visibilityState === "visible" && state.audioCtx?.state === "suspended") {
    void state.audioCtx.resume();
  }
});
