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

function downsample(float32, inRate, outRate) {
  if (outRate >= inRate) return float32;
  const ratio = inRate / outRate;
  const newLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) out[i] = float32[Math.floor(i * ratio)];
  return out;
}

module.exports = { floatTo16BitPCM, rms, downsample };
