import { describe, it, expect } from 'vitest';
import { floatTo16BitPCM, rms, downsample } from './pcm-utils.js';

describe('pcm-utils', () => {
  it('floatTo16BitPCM klemmt und skaliert', () => {
    const buf = floatTo16BitPCM(new Float32Array([0, 1, -1, 2]));
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, 4);
    expect(i16[0]).toBe(0);
    expect(i16[1]).toBe(32767);
    expect(i16[2]).toBe(-32768);
    expect(i16[3]).toBe(32767); // geklemmt
  });
  it('rms von Stille ist 0, von Vollausschlag ~1', () => {
    expect(rms(floatTo16BitPCM(new Float32Array([0, 0, 0])))).toBeCloseTo(0, 5);
    expect(rms(floatTo16BitPCM(new Float32Array([1, -1, 1, -1])))).toBeCloseTo(1, 1);
  });
  it('downsample halbiert die Länge bei 2:1', () => {
    const out = downsample(new Float32Array([0, 0.5, 1, 0.5]), 32000, 16000);
    expect(out.length).toBe(2);
  });
});
