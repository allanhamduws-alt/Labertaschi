import { describe, it, expect } from 'vitest';
import { ChunkAccumulator } from './chunk-accumulator.js';

describe('ChunkAccumulator', () => {
  it('emittiert volle Fenster und nummeriert sie', () => {
    const chunks = [];
    const acc = new ChunkAccumulator({ sampleRate: 100, windowSeconds: 1, onChunk: (c) => chunks.push(c) });
    const oneSec = Buffer.alloc(100 * 2); // 100 samples * 2 bytes
    acc.push(oneSec);
    acc.push(oneSec);
    expect(chunks.length).toBe(2);
    expect(chunks[0].seq).toBe(0);
    expect(chunks[0].tOffset).toBe(0);
    expect(chunks[1].seq).toBe(1);
    expect(chunks[1].tOffset).toBe(1);
  });
  it('flush gibt Restdaten aus', () => {
    const chunks = [];
    const acc = new ChunkAccumulator({ sampleRate: 100, windowSeconds: 1, onChunk: (c) => chunks.push(c) });
    acc.push(Buffer.alloc(50 * 2));
    expect(chunks.length).toBe(0);
    acc.flush();
    expect(chunks.length).toBe(1);
  });
});
