import { describe, expect, it } from 'vitest';

// Provider picker + mock-mode logic tests (pure, no DOM).
function pickProvider(v: string): 'gemini' | 'openai' {
  return v === 'openai' ? 'openai' : 'gemini';
}

describe('provider picker', () => {
  it('defaults to gemini', () => {
    expect(pickProvider('gemini')).toBe('gemini');
    expect(pickProvider('anything-else')).toBe('gemini');
  });
  it('routes openai explicitly', () => {
    expect(pickProvider('openai')).toBe('openai');
  });
});

describe('token response handling', () => {
  it('treats mock responses as non-connecting', () => {
    const mock = { provider: 'gemini', credential: null, ws_url: null, mock: true };
    const shouldConnect = !mock.mock && mock.ws_url !== null;
    expect(shouldConnect).toBe(false);
  });
  it('connects when a real ws_url is present', () => {
    const real = { provider: 'gemini', credential: 'tok', ws_url: 'wss://x', mock: false };
    const shouldConnect = !real.mock && real.ws_url !== null;
    expect(shouldConnect).toBe(true);
  });
});

describe('LiveMsg serverContent parsing', () => {
  function parse(raw: string): { tutorText?: string; userText?: string } {
    const msg = JSON.parse(raw);
    const out: { tutorText?: string; userText?: string } = {};
    const parts = msg.serverContent?.modelTurn?.parts ?? [];
    for (const p of parts) if (p.text) out.tutorText = p.text;
    if (msg.serverContent?.inputTranscription?.text) out.userText = msg.serverContent.inputTranscription.text;
    return out;
  }

  it('extracts tutor text from modelTurn parts', () => {
    const out = parse(JSON.stringify({
      serverContent: { modelTurn: { parts: [{ text: 'Hej! Hur mår du?' }] } },
    }));
    expect(out.tutorText).toBe('Hej! Hur mår du?');
  });

  it('extracts user transcription', () => {
    const out = parse(JSON.stringify({
      serverContent: { inputTranscription: { text: 'Jag heter Ann' } },
    }));
    expect(out.userText).toBe('Jag heter Ann');
  });

  it('handles frames with no text parts', () => {
    const out = parse(JSON.stringify({ serverContent: { modelTurn: { parts: [{}] } } }));
    expect(out.tutorText).toBeUndefined();
  });
});

describe('OpenAI event parsing', () => {
  function parseOpenAI(raw: string): { tutorText?: string; userText?: string } {
    const msg = JSON.parse(raw) as { type: string; delta?: string; transcript?: string };
    const out: { tutorText?: string; userText?: string } = {};
    if (msg.type === 'response.output_audio_transcript.delta' && msg.delta) out.tutorText = msg.delta;
    if (msg.type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) out.userText = msg.transcript;
    return out;
  }

  it('parses tutor transcript deltas', () => {
    expect(parseOpenAI(JSON.stringify({
      type: 'response.output_audio_transcript.delta', delta: 'Hej!',
    })).tutorText).toBe('Hej!');
  });

  it('parses user transcription completion', () => {
    expect(parseOpenAI(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed', transcript: 'Jag heter Ann',
    })).userText).toBe('Jag heter Ann');
  });

  it('ignores unrelated events', () => {
    const out = parseOpenAI(JSON.stringify({ type: 'ping' }));
    expect(out.tutorText).toBeUndefined();
    expect(out.userText).toBeUndefined();
  });
});
