import { describe, it, expect } from 'vitest';
import { mergeSegments, suppressBleed, canonicalizeSpeakerLabels } from './transcript-merger.js';

describe('canonicalizeSpeakerLabels', () => {
  it('verankert „Ich" am zuerst sprechenden Mikro-Sprecher (auch wenn das LLM die Labels vertauscht hat)', () => {
    // LLM hat „Sprecher 2" als ersten (= Gerätebesitzer) gruppiert und „me" auf den Antworter gelegt
    const segs = [
      { speaker: 'Sprecher 2', channel: 'mic', text: 'Anissa, wie gehts?' },
      { speaker: 'me', channel: 'mic', text: 'Nein.' },
      { speaker: 'Sprecher 2', channel: 'mic', text: 'Sag mal, was in der Schule?' },
      { speaker: 'me', channel: 'mic', text: 'Deutsch.' },
    ];
    const out = canonicalizeSpeakerLabels(segs);
    expect(out.map((s) => s.speaker)).toEqual(['me', 'Sprecher 2', 'me', 'Sprecher 2']);
  });
  it('behält die Gruppierung, nummeriert weitere Sprecher nach Auftreten', () => {
    const segs = [
      { speaker: 'x', channel: 'mic' }, { speaker: 'y', channel: 'mic' }, { speaker: 'z', channel: 'mic' }, { speaker: 'y', channel: 'mic' },
    ];
    expect(canonicalizeSpeakerLabels(segs).map((s) => s.speaker)).toEqual(['me', 'Sprecher 2', 'Sprecher 3', 'Sprecher 2']);
  });
  it('Mikro- und System-Sprecher getrennt kanonisiert', () => {
    const segs = [
      { speaker: 'me', channel: 'mic' }, { speaker: 'other', channel: 'system' }, { speaker: 'Gegenstelle 2', channel: 'system' },
    ];
    expect(canonicalizeSpeakerLabels(segs).map((s) => s.speaker)).toEqual(['me', 'other', 'Gegenstelle 2']);
  });
});

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
