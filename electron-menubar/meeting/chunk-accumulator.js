// ChunkAccumulator — sammelt PCM-Buffer zu festen Zeitfenstern. CommonJS.

class ChunkAccumulator {
  constructor({ sampleRate, windowSeconds, onChunk }) {
    this.bytesPerWindow = sampleRate * windowSeconds * 2; // 16-bit = 2 bytes per sample
    this.windowSeconds = windowSeconds;
    this.onChunk = onChunk;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
  }

  push(int16Buffer) {
    this.buf = Buffer.concat([this.buf, int16Buffer]);
    while (this.buf.length >= this.bytesPerWindow) {
      const pcm = this.buf.subarray(0, this.bytesPerWindow);
      this.buf = this.buf.subarray(this.bytesPerWindow);
      this.onChunk({ pcm, seq: this.seq, tOffset: this.seq * this.windowSeconds });
      this.seq++;
    }
  }

  flush() {
    if (this.buf.length > 0) {
      this.onChunk({ pcm: this.buf, seq: this.seq, tOffset: this.seq * this.windowSeconds });
      this.buf = Buffer.alloc(0);
      this.seq++;
    }
  }
}

module.exports = { ChunkAccumulator };
