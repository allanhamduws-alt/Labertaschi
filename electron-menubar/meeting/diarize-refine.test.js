import { describe, it, expect } from 'vitest';
const { refineSpeakers, buildRefinePrompt, parseRefineResponse } = require('./diarize-refine.js');

const SEGS = [
  { speaker: 'me', text: 'Ich will was austesten.', channel: 'mic' },
  { speaker: 'me', text: 'Ich möchte schlafen.', channel: 'mic' },        // eigentlich der andere
  { speaker: 'me', text: 'Okay, wann willst du schlafen?', channel: 'mic' },
  { speaker: 'Sprecher 2', text: 'Ich denke um 22 Uhr.', channel: 'mic' },
];

describe('buildRefinePrompt', () => {
  it('enthält die vorhandenen Sprecher + nummerierte Zeilen', () => {
    const p = buildRefinePrompt(SEGS, ['me', 'Sprecher 2']);
    expect(p).toContain('"me"');
    expect(p).toContain('"Sprecher 2"');
    expect(p).toContain('1. [me] Ich möchte schlafen.');
  });
});

describe('parseRefineResponse', () => {
  const allowed = new Set(['me', 'Sprecher 2']);
  it('parst sauberes JSON', () => {
    const m = parseRefineResponse('{"speakers":[{"i":1,"speaker":"Sprecher 2"}]}', allowed);
    expect(m.get(1)).toBe('Sprecher 2');
  });
  it('ist robust gegen ```json-Fences/Text drumherum', () => {
    const m = parseRefineResponse('Hier:\n```json\n{"speakers":[{"i":0,"speaker":"me"}]}\n```', allowed);
    expect(m.get(0)).toBe('me');
  });
  it('ignoriert unbekannte Sprecher (keine neuen erfinden)', () => {
    const m = parseRefineResponse('{"speakers":[{"i":0,"speaker":"Fremder"}]}', allowed);
    expect(m.has(0)).toBe(false);
  });
  it('Müll → leere Map', () => {
    expect(parseRefineResponse('kein json', allowed).size).toBe(0);
  });
});

describe('refineSpeakers', () => {
  const fakeFetch = (body) => async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
  });

  it('wendet die LLM-Korrektur an (Text bleibt, nur Sprecher ändert sich)', async () => {
    const out = await refineSpeakers(SEGS, {
      apiKey: 'k',
      fetchImpl: fakeFetch({ speakers: [
        { i: 0, speaker: 'me' }, { i: 1, speaker: 'Sprecher 2' },
        { i: 2, speaker: 'me' }, { i: 3, speaker: 'Sprecher 2' },
      ] }),
    });
    expect(out[1].speaker).toBe('Sprecher 2');   // korrigiert
    expect(out[1].text).toBe('Ich möchte schlafen.'); // Text unverändert
    expect(out[0].speaker).toBe('me');
  });

  it('überspringt bei nur einem Sprecher', async () => {
    let called = false;
    const segs = [{ speaker: 'me', text: 'a' }, { speaker: 'me', text: 'b' }, { speaker: 'me', text: 'c' }];
    const out = await refineSpeakers(segs, { apiKey: 'k', fetchImpl: () => { called = true; } });
    expect(called).toBe(false);
    expect(out).toEqual(segs);
  });

  it('überspringt ohne API-Key', async () => {
    const out = await refineSpeakers(SEGS, { apiKey: '' });
    expect(out).toEqual(SEGS);
  });

  it('überspringt zu lange Transkripte (maxSegments)', async () => {
    let called = false;
    const segs = Array.from({ length: 5 }, (_, i) => ({ speaker: i % 2 ? 'me' : 'Sprecher 2', text: 't' + i }));
    const out = await refineSpeakers(segs, { apiKey: 'k', maxSegments: 4, fetchImpl: () => { called = true; } });
    expect(called).toBe(false);
    expect(out).toEqual(segs);
  });

  it('429 wirft mit code rate_limit', async () => {
    await expect(refineSpeakers(SEGS, {
      apiKey: 'k',
      fetchImpl: async () => ({ ok: false, status: 429 }),
    })).rejects.toMatchObject({ code: 'rate_limit' });
  });
});
