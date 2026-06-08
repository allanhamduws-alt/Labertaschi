import { describe, it, expect } from 'vitest';
import { encodeWav } from './wav-encoder.js';

describe('encodeWav', () => {
  it('schreibt einen 44-Byte-RIFF/WAVE-Header + PCM-Daten', () => {
    const pcm = Buffer.from(new Int16Array([0, 1000, -1000, 32767]).buffer);
    const wav = encodeWav(pcm, { sampleRate: 16000, channels: 1 });
    expect(wav.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.slice(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);     // sampleRate
    expect(wav.readUInt16LE(22)).toBe(1);          // channels
    expect(wav.readUInt16LE(34)).toBe(16);         // bitsPerSample
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.slice(44)).toEqual(pcm);
  });
});
