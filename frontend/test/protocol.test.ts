import { describe, expect, it } from 'vitest';
import {
  arrayBufferToBase64,
  base64ToPcm16,
  bytesToPcm16,
  decodeFrame,
  parseGeminiMessage,
  parseMessageText,
  parseOpenAIMessage,
  rateFromMime,
  resamplePcm16,
} from '../src/protocol';

// Encode int16 samples the way the providers do (base64 little-endian PCM16).
function pcmB64(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((s, i) => {
    const v = s & 0xffff;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  });
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const json = (v: unknown) => JSON.stringify(v);

describe('pcm helpers', () => {
  it('decodes little-endian PCM16 including negatives', () => {
    expect(Array.from(base64ToPcm16(pcmB64([0, 1, -1, 32767, -32768])))).toEqual([
      0, 1, -1, 32767, -32768,
    ]);
  });

  it('drops a trailing odd byte instead of blowing up', () => {
    expect(Array.from(bytesToPcm16(new Uint8Array([1, 0, 7])))).toEqual([1]);
  });

  it('round-trips through base64', () => {
    const samples = [123, -456, 7890];
    expect(arrayBufferToBase64(base64ToPcm16(pcmB64(samples)).buffer as ArrayBuffer)).toBe(
      pcmB64(samples),
    );
  });

  it('resamples 48 kHz to 16 kHz, keeping the signal shape', () => {
    const input = new Int16Array(48);
    for (let i = 0; i < input.length; i++) input[i] = i * 100;
    const out = resamplePcm16(input, 48000, 16000);
    expect(out.length).toBe(16);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeGreaterThan(250);
  });

  it('leaves the buffer untouched when rates match', () => {
    const input = new Int16Array([1, 2, 3]);
    expect(resamplePcm16(input, 16000, 16000)).toBe(input);
  });

  it('reads the rate out of a mime type', () => {
    expect(rateFromMime('audio/pcm;rate=24000')).toBe(24000);
    expect(rateFromMime(undefined, 16000)).toBe(16000);
    expect(rateFromMime('audio/pcm')).toBe(24000);
  });
});

describe('gemini frame decoding', () => {
  // Regression: Gemini Live sends JSON in BINARY websocket frames. The shipped
  // build treated every non-string frame as PCM and never parsed anything.
  it('parses a binary JSON frame', async () => {
    const frame = new TextEncoder().encode(json({ setupComplete: {} })).buffer as ArrayBuffer;
    expect(await decodeFrame(frame, 'gemini')).toEqual([{ kind: 'ready' }]);
  });

  it('parses a Blob frame', async () => {
    const events = await decodeFrame(new Blob([json({ setupComplete: {} })]), 'gemini');
    expect(events).toEqual([{ kind: 'ready' }]);
  });

  it('extracts base64 audio and its sample rate', () => {
    const events = parseGeminiMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmB64([5, -5, 6]) } }],
        },
      },
    });
    expect(events).toHaveLength(1);
    const audio = events[0]!;
    expect(audio.kind).toBe('audio');
    if (audio.kind !== 'audio') throw new Error('expected audio');
    expect(audio.sampleRate).toBe(24000);
    expect(Array.from(audio.pcm)).toEqual([5, -5, 6]);
  });

  it('streams tutor and user transcription as appendable text', () => {
    const events = parseGeminiMessage({
      serverContent: {
        outputTranscription: { text: 'Hej ' },
        inputTranscription: { text: 'Jag ' },
        turnComplete: true,
      },
    });
    expect(events).toEqual([
      { kind: 'tutorText', text: 'Hej ', append: true },
      { kind: 'userText', text: 'Jag ', append: true },
      { kind: 'turnComplete' },
    ]);
  });

  it('reports barge-in', () => {
    expect(parseGeminiMessage({ serverContent: { interrupted: true } })).toEqual([
      { kind: 'interrupted' },
    ]);
  });

  it('surfaces provider errors instead of dropping them', () => {
    const events = parseGeminiMessage({
      error: { code: 1007, message: 'Requested response modality is not supported.' },
    });
    expect(events[0]?.kind).toBe('error');
    if (events[0]?.kind === 'error') {
      expect(events[0].message).toContain('not supported');
      expect(events[0].message).toContain('1007');
    }
  });

  it('ignores empty and unknown frames', () => {
    expect(parseGeminiMessage({})).toEqual([]);
    expect(parseGeminiMessage({ voiceActivity: {} })).toEqual([]);
    expect(parseGeminiMessage(null)).toEqual([]);
  });
});

describe('openai frame decoding', () => {
  it('maps the session handshake to ready', () => {
    expect(parseOpenAIMessage({ type: 'session.created' })).toEqual([{ kind: 'ready' }]);
  });

  it('decodes output audio deltas', () => {
    const events = parseOpenAIMessage({
      type: 'response.output_audio.delta',
      delta: pcmB64([1, 2]),
    });
    expect(events[0]?.kind).toBe('audio');
  });

  it('appends transcript deltas and replaces with finals', () => {
    expect(
      parseOpenAIMessage({ type: 'response.output_audio_transcript.delta', delta: 'Hej' }),
    ).toEqual([{ kind: 'tutorText', text: 'Hej', append: true }]);
    expect(
      parseOpenAIMessage({ type: 'response.output_audio_transcript.done', transcript: 'Hej du' }),
    ).toEqual([{ kind: 'tutorText', text: 'Hej du', append: false }]);
    expect(
      parseOpenAIMessage({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Hej',
      }),
    ).toEqual([{ kind: 'userText', text: 'Hej', append: false }]);
  });

  it('maps errors and barge-in', () => {
    expect(parseOpenAIMessage({ type: 'error', error: { message: 'bad key' } })).toEqual([
      { kind: 'error', message: 'bad key' },
    ]);
    expect(parseOpenAIMessage({ type: 'input_audio_buffer.speech_started' })).toEqual([
      { kind: 'interrupted' },
    ]);
  });
});

describe('message text parsing', () => {
  it('returns nothing for malformed JSON', () => {
    expect(parseMessageText('not json', 'gemini')).toEqual([]);
    expect(parseMessageText('{}', 'openai')).toEqual([]);
  });
});
