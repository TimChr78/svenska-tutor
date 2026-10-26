import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import source from '../src/main.ts?raw';

// Structural regression guard.
//
// The P1-6 "brace repair" commit left `onPhotoFile` unclosed, so every statement
// after it — photo buttons, service-worker registration, timers, beforeunload —
// was silently nested inside a function that never ran. `tsc` was happy, and the
// tests passed because they re-implemented the logic instead of importing it.
// These assertions walk the real AST so that cannot happen again.

const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true);

const topLevelFunctions = new Set(
  file.statements
    .filter(ts.isFunctionDeclaration)
    .map((s) => s.name?.text)
    .filter((name): name is string => Boolean(name)),
);

const topLevelCalls = new Set(
  file.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      return [];
    }
    const callee = statement.expression.expression;
    return ts.isIdentifier(callee) ? [callee.text] : [];
  }),
);

const EXPECTED_TOP_LEVEL = [
  'startSession',
  'stopSession',
  'handleFrame',
  'handleEvents',
  'sendMicChunk',
  'endMicStream',
  'enqueueAudio',
  'flushAudio',
  'ensurePlayer',
  'downscaleToJpeg',
  'onPhotoFile',
  'addTranscript',
  'setLevel',
  'pcmLevel',
  'wire',
];

describe('main.ts structure', () => {
  it.each(EXPECTED_TOP_LEVEL)('%s is declared at top level', (name) => {
    expect(topLevelFunctions).toContain(name);
  });

  it('actually runs its wiring on load', () => {
    expect(topLevelCalls).toContain('wire');
  });

  it('serves the recorder worklet from public/, not from a /src/ URL', () => {
    // The bundled app has no /src/ directory: addModule('/src/...') 404s in prod,
    // which killed microphone capture in the deployed build.
    expect(source).toContain('/worklets/recorder-worklet.js');
    expect(source).not.toContain('/src/worklets');
  });

  it('does not send audio through the silently-ignored mediaChunks field', () => {
    // Verified against the live API: realtimeInput.mediaChunks is ignored,
    // realtimeInput.audio works.
    expect(source).not.toContain('mediaChunks');
    expect(source).toContain('realtimeInput: { audio:');
  });
});

describe('recorder worklet', () => {
  it('batches mic audio instead of posting every 8 ms render quantum', async () => {
    // Gemini Live accepts 20 ms chunks without error and then never answers;
    // 50-100 ms batches work. Keep the worklet at ~100 ms.
    const worklet = (await import('../public/worklets/recorder-worklet.js?raw')).default;
    expect(worklet).toContain('Math.round(sampleRate * 0.1)');
    expect(worklet).toContain('this.port.postMessage');
  });
});
