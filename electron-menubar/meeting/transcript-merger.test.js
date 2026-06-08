import { describe, it, expect } from 'vitest';
import { mergeSegments } from './transcript-merger.js';

describe('mergeSegments', () => {
  it('verschmilzt zwei Kanäle chronologisch mit Sprecher-Labels', () => {
    const mic = [{ tStart: 0, tEnd: 2, text: 'Hallo' }, { tStart: 5, tEnd: 6, text: 'Ja genau' }];
    const sys = [{ tStart: 2, tEnd: 4, text: 'Guten Tag' }];
    const out = mergeSegments(mic, sys);
    expect(out.map(s => s.text)).toEqual(['Hallo', 'Guten Tag', 'Ja genau']);
    expect(out[0]).toMatchObject({ speaker: 'me', channel: 'mic' });
    expect(out[1]).toMatchObject({ speaker: 'other', channel: 'system' });
  });
  it('ist stabil bei gleichem tStart (mic vor system)', () => {
    const out = mergeSegments([{ tStart: 1, tEnd: 2, text: 'A' }], [{ tStart: 1, tEnd: 2, text: 'B' }]);
    expect(out.map(s => s.text)).toEqual(['A', 'B']);
  });
});
