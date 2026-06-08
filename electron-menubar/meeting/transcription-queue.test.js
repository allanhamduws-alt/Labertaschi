import { describe, it, expect } from 'vitest';
const { TranscriptionQueue, parseVerbose } = require('./transcription-queue.js');

describe('transcription-queue', () => {
  it('parseVerbose verschiebt Segment-Zeiten um tOffset', () => {
    const json = { segments: [{ start: 0, end: 1.5, text: ' Hallo' }, { start: 1.5, end: 2, text: ' Welt' }] };
    const segs = parseVerbose(json, 30);
    expect(segs).toEqual([{ tStart: 30, tEnd: 31.5, text: 'Hallo' }, { tStart: 31.5, tEnd: 32, text: 'Welt' }]);
  });
  it('enqueue transkribiert und emittiert segments', async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ segments: [{ start: 0, end: 1, text: 'Hi' }] }) });
    const q = new TranscriptionQueue({ apiKey: 'k', language: 'de', fetchImpl: fakeFetch });
    const got = [];
    q.on('segments', (e) => got.push(e));
    q.enqueue({ channel: 'mic', wavBuffer: Buffer.alloc(44), tOffset: 0 });
    await q.idle();
    expect(got[0].channel).toBe('mic');
    expect(got[0].segments[0].text).toBe('Hi');
  });
});
