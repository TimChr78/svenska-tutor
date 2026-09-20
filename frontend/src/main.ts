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
  detail?: string;
}

const state = {
  running: false,
  ws: null as WebSocket | null,
  audioCtx: null as AudioContext | null,
  mediaStream: null as MediaStream | null,
  worklet: null as AudioWorkletNode | null,
  wakeLock: null as WakeLockSentinel | null,
  sessionId: null as number | null,
  startedAt: 0,
};

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
    if (state.running && state.ws && state.ws.readyState === WebSocket.OPEN) {
      // barge-in: keep sending while tutor speaks; server-side VAD handles it
      state.ws.send(ev.data);
    }
  };
  const source = state.audioCtx.createMediaStreamSource(state.mediaStream);
  source.connect(state.worklet);
  state.worklet.connect(state.audioCtx.destination); // keep worklet pulled on iOS

  if (!token.mock) {
    state.ws = new WebSocket(token.ws_url!);
    state.ws.binaryType = "arraybuffer";
    state.ws.onopen = () => setStatus("connected");
    state.ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return void playAudio(ev.data);
      const msg = JSON.parse(ev.data) as { type?: string; text?: string };
      if (msg.type === "transcript.user" && msg.text) $("#tt-user")!.textContent = msg.text;
      if (msg.type === "transcript.tutor" && msg.text) $("#tt-tutor")!.textContent = msg.text;
    };
    state.ws.onclose = () => setStatus("disconnected");
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
