// PCM16 mono recorder worklet.
//
// Posts ~100 ms batches. Sending one message per render quantum (128 frames,
// 8 ms) does not work with Gemini Live: the API accepts the frames, reports no
// error and then never responds. Verified threshold — 20 ms chunks are ignored,
// 50 ms and 100 ms work.
const CHUNK_SAMPLES = Math.round(sampleRate * 0.1);

class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(CHUNK_SAMPLES);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === CHUNK_SAMPLES) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(CHUNK_SAMPLES);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorder);
