// PCM utilities: Float→Int16, RMS, Downsampling. CommonJS.

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return Buffer.from(out.buffer);
}

function rms(int16Buffer) {
  const i16 = new Int16Array(int16Buffer.buffer, int16Buffer.byteOffset, Math.floor(int16Buffer.length / 2));
  if (i16.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < i16.length; i++) {
    const v = i16[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / i16.length);
}

// Maximales RMS über kurze Frames (Default 100 ms). Erkennt zuverlässig, ob in
// einem (auch langen) Chunk ÜBERHAUPT Sprache vorkommt — eine kurze, leise Äußerung
// verschwindet nicht im Chunk-Durchschnitt. Genutzt fürs Stille-Gate vor der STT,
// damit auf reiner Stille nicht halluziniert wird, leise Stimmen aber erhalten bleiben.
function maxFrameRms(int16Buffer, { sampleRate = 16000, frameMs = 100 } = {}) {
  const i16 = new Int16Array(int16Buffer.buffer, int16Buffer.byteOffset, Math.floor(int16Buffer.length / 2));
  if (i16.length === 0) return 0;
  const frame = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  let max = 0;
  for (let off = 0; off < i16.length; off += frame) {
    const end = Math.min(off + frame, i16.length);
    let sum = 0;
    for (let i = off; i < end; i++) { const v = i16[i] / 32768; sum += v * v; }
    const r = Math.sqrt(sum / (end - off));
    if (r > max) max = r;
  }
  return max;
}

function downsample(float32, inRate, outRate) {
  if (outRate >= inRate) return float32;
  const ratio = inRate / outRate;
  const newLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) out[i] = float32[Math.floor(i * ratio)];
  return out;
}

module.exports = { floatTo16BitPCM, rms, downsample, maxFrameRms };
