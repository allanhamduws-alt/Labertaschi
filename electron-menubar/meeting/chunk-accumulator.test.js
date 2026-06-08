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

  it('VAD: schneidet an einer Sprechpause statt hart bei max', () => {
    const chunks = [];
    const acc = new ChunkAccumulator({ sampleRate: 100, minSeconds: 1, maxSeconds: 4, silenceRms: 0.05, onChunk: (c) => chunks.push(c) });
    // 400 Samples (800 Byte): überall laut, außer Stille bei Samples [300,340)
    const samples = new Int16Array(400).fill(10000);
    for (let i = 300; i < 340; i++) samples[i] = 0;
    acc.push(Buffer.from(samples.buffer));
    expect(chunks.length).toBe(1);
    expect(chunks[0].pcm.length).toBe(680); // Schnitt am Ende des leisen Fensters (340 Samples)
    expect(chunks[0].tOffset).toBe(0);
  });

  it('VAD: harter Fallback bei max, wenn keine Pause gefunden wird', () => {
    const chunks = [];
    const acc = new ChunkAccumulator({ sampleRate: 100, minSeconds: 1, maxSeconds: 2, silenceRms: 0.05, onChunk: (c) => chunks.push(c) });
    const samples = new Int16Array(300).fill(10000); // durchgehend laut, 600 Byte
    acc.push(Buffer.from(samples.buffer));
    expect(chunks.length).toBe(1);
    expect(chunks[0].pcm.length).toBe(400); // hart bei maxBytes (2s * 100 * 2)
  });

  it('VAD: tOffset kumuliert die echten Chunk-Längen', () => {
    const chunks = [];
    const acc = new ChunkAccumulator({ sampleRate: 100, minSeconds: 1, maxSeconds: 2, silenceRms: 0.05, onChunk: (c) => chunks.push(c) });
    const loud = new Int16Array(800).fill(10000); // 1600 Byte, durchgehend laut
    acc.push(Buffer.from(loud.buffer));
    // 1600 Byte / maxBytes(400) → 4 harte Schnitte à 400 Byte = 2 s
    expect(chunks.map((c) => c.tOffset)).toEqual([0, 2, 4, 6]);
  });
});
