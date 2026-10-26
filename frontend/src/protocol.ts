// Wire-protocol layer for the live providers.
//
// Everything here is pure (no DOM, no network) so it can be unit-tested — the
// previous tests re-implemented this logic instead of importing it, which let a
// brace bug and a dead audio path ship unnoticed.
//
// Verified against the live APIs (2026-10):
//   Gemini Live  -> JSON frames arrive as BINARY websocket frames, audio is
//                   base64 PCM16 inside serverContent.modelTurn.parts[].inlineData,
//                   mic input must use realtimeInput.audio (mediaChunks is ignored).
//   OpenAI RT    -> JSON text frames, audio in response.output_audio.delta.

export type Provider = "gemini" | "openai";

export type LiveEvent =
  | { kind: "ready" }
  | { kind: "audio"; pcm: Int16Array; sampleRate: number }
  | { kind: "tutorText"; text: string; append: boolean }
  | { kind: "userText"; text: string; append: boolean }
  | { kind: "interrupted" }
  | { kind: "turnComplete" }
  | { kind: "error"; message: string };

const GEMINI_OUTPUT_RATE = 24000;
const OPENAI_OUTPUT_RATE = 24000;

/** Decode standard base64 (no data: prefix) into bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Little-endian PCM16 bytes -> samples. Drops a trailing odd byte. */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bytes[i * 2] ?? 0;
    const hi = bytes[i * 2 + 1] ?? 0;
    out[i] = (lo | (hi << 8)) << 16 >> 16;
  }
  return out;
}

export function base64ToPcm16(b64: string): Int16Array {
  return bytesToPcm16(base64ToBytes(b64));
}

export function arrayBufferToBase64(buf: ArrayBufferLike): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Linear-interpolation resampler — iOS ignores AudioContext({sampleRate:16000}). */
export function resamplePcm16(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || pcm.length === 0) return pcm;
  const n = Math.max(1, Math.floor((pcm.length * to) / from));
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = pcm[i0] ?? 0;
    const b = pcm[i0 + 1] ?? a;
    const v = a + (b - a) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}

/** Rate from a mime type like "audio/pcm;rate=24000". */
export function rateFromMime(mime: string | undefined, fallback = 24000): number {
  const m = mime ? /rate=(\d+)/.exec(mime) : null;
  return m?.[1] ? Number(m[1]) : fallback;
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; status?: unknown; code?: unknown };
    if (typeof e.message === "string" && e.message) {
      return typeof e.code === "number" || typeof e.status === "string"
        ? `${e.message} (${String(e.status ?? e.code)})`
        : e.message;
    }
    return JSON.stringify(err).slice(0, 300);
  }
  return "unknown provider error";
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

export function parseGeminiMessage(raw: unknown): LiveEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const msg = raw as Record<string, unknown>;
  const events: LiveEvent[] = [];

  if ("error" in msg) return [{ kind: "error", message: errorMessage(msg["error"]) }];
  if ("setupComplete" in msg) events.push({ kind: "ready" });

  const sc = msg["serverContent"] as
    | {
        modelTurn?: { parts?: GeminiPart[] };
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        interrupted?: boolean;
        turnComplete?: boolean;
      }
    | undefined;
  if (!sc) return events;

  for (const part of sc.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) {
      events.push({
        kind: "audio",
        pcm: base64ToPcm16(part.inlineData.data),
        sampleRate: rateFromMime(part.inlineData.mimeType, GEMINI_OUTPUT_RATE),
      });
    }
    // Native-audio models rarely emit text parts, but handle them if they do.
    if (part.text) events.push({ kind: "tutorText", text: part.text, append: true });
  }
  if (sc.outputTranscription?.text) {
    events.push({ kind: "tutorText", text: sc.outputTranscription.text, append: true });
  }
  if (sc.inputTranscription?.text) {
    events.push({ kind: "userText", text: sc.inputTranscription.text, append: true });
  }
  if (sc.interrupted) events.push({ kind: "interrupted" });
  if (sc.turnComplete) events.push({ kind: "turnComplete" });
  return events;
}

export function parseOpenAIMessage(raw: unknown): LiveEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const msg = raw as Record<string, unknown>;
  const type = typeof msg["type"] === "string" ? msg["type"] : "";
  const delta = typeof msg["delta"] === "string" ? msg["delta"] : "";
  const transcript = typeof msg["transcript"] === "string" ? msg["transcript"] : "";

  switch (type) {
    case "session.created":
    case "session.updated":
      return [{ kind: "ready" }];
    case "response.output_audio.delta":
      return delta
        ? [{ kind: "audio", pcm: base64ToPcm16(delta), sampleRate: OPENAI_OUTPUT_RATE }]
        : [];
    case "response.output_audio_transcript.delta":
      return delta ? [{ kind: "tutorText", text: delta, append: true }] : [];
    case "response.output_audio_transcript.done":
      return transcript ? [{ kind: "tutorText", text: transcript, append: false }] : [];
    case "conversation.item.input_audio_transcription.completed":
      return transcript ? [{ kind: "userText", text: transcript, append: false }] : [];
    case "input_audio_buffer.speech_started":
      return [{ kind: "interrupted" }];
    case "response.done":
      return [{ kind: "turnComplete" }];
    case "error":
      return [{ kind: "error", message: errorMessage(msg["error"]) }];
    default:
      return [];
  }
}

/** Normalise one websocket frame (string, ArrayBuffer or Blob) into text. */
export async function frameToText(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as unknown as ArrayBufferView);
  }
  return null;
}

/** Parse one already-decoded JSON frame from the provider. */
export function parseMessageText(text: string, provider: Provider): LiveEvent[] {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return [];
  }
  return provider === "gemini" ? parseGeminiMessage(msg) : parseOpenAIMessage(msg);
}

/** Decode a single frame (string, ArrayBuffer or Blob) into provider events. */
export async function decodeFrame(data: unknown, provider: Provider): Promise<LiveEvent[]> {
  const text = await frameToText(data);
  if (text === null) return [];
  return parseMessageText(text, provider);
}
