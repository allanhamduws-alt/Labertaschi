import { describe, it, expect } from 'vitest';
import { mergeSegments, suppressBleed } from './transcript-merger.js';

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

describe('suppressBleed (Lautsprecher-Echo im Call-Modus)', () => {
  it('verwirft Mic-Segmente, die mit System-Segmenten überlappen (Echo), behält die echten', () => {
    const sys = [{ tStart: 0, tEnd: 5, text: 'Partner redet' }, { tStart: 10, tEnd: 15, text: 'Partner wieder' }];
    const mic = [
      { tStart: 0.3, tEnd: 4.5, text: 'echo des partners' }, // überlappt sys[0] → Echo
      { tStart: 6, tEnd: 8, text: 'ich sage was' },          // keine Überlappung → behalten
      { tStart: 10.2, tEnd: 14, text: 'echo zwei' },          // überlappt sys[1] → Echo
    ];
    const kept = suppressBleed(mic, sys);
    expect(kept.map((s) => s.text)).toEqual(['ich sage was']);
  });
  it('ohne System-Segmente bleibt alles erhalten', () => {
    const mic = [{ tStart: 0, tEnd: 2, text: 'A' }];
    expect(suppressBleed(mic, [])).toEqual(mic);
  });
});
