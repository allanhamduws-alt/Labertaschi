import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const { parseDeepgram, diarizeWithDeepgram, assignSpeakers } = require('./diarization.js');

describe('assignSpeakers', () => {
  it('übernimmt das Sprecher-Label des am stärksten überlappenden Turns, behält aber den Text', () => {
    const text = [
      { tStart: 0, tEnd: 2, speaker: 'me', channel: 'mic', text: 'Hallo' },
      { tStart: 2.1, tEnd: 4, speaker: 'me', channel: 'mic', text: 'wie gehts' },
    ];
    const turns = [
      { tStart: 0, tEnd: 2, speaker: 'Sprecher 1' },
      { tStart: 2, tEnd: 4, speaker: 'Sprecher 2' },
    ];
    const out = assignSpeakers(text, turns);
    expect(out[0].speaker).toBe('Sprecher 1');
    expect(out[1].speaker).toBe('Sprecher 2');
    expect(out[0].text).toBe('Hallo');      // Groqs Text bleibt
    expect(out[1].text).toBe('wie gehts');
  });
  it('ohne Turns bleiben die Segmente unverändert (als Kopie)', () => {
    const text = [{ tStart: 0, tEnd: 1, speaker: 'me', text: 'x' }];
    const out = assignSpeakers(text, []);
    expect(out[0].speaker).toBe('me');
    expect(out).not.toBe(text);
  });
  it('ohne Überlappung wird der zeitlich nächste Sprecher zugewiesen (konsistente Labels)', () => {
    const out = assignSpeakers(
      [{ tStart: 10, tEnd: 11, speaker: 'me', text: 'x' }],
      [{ tStart: 0, tEnd: 1, speaker: 'Sprecher 1' }],
    );
    expect(out[0].speaker).toBe('Sprecher 1');
  });
  it('wählt bei Lücke den näheren von zwei Turns', () => {
    const out = assignSpeakers(
      [{ tStart: 5, tEnd: 6, speaker: 'me', text: 'x' }],
      [{ tStart: 0, tEnd: 1, speaker: 'Sprecher 1' }, { tStart: 6.5, tEnd: 8, speaker: 'Sprecher 2' }],
    );
    expect(out[0].speaker).toBe('Sprecher 2');
  });
});

describe('parseDeepgram', () => {
  it('nutzt utterances mit Sprecher-Labels (Sprecher 1/2 …)', () => {
    const json = { results: { utterances: [
      { start: 0, end: 2, transcript: 'Hallo zusammen', speaker: 0 },
      { start: 2, end: 4, transcript: 'Ja hi', speaker: 1 },
    ] } };
    expect(parseDeepgram(json)).toEqual([
      { tStart: 0, tEnd: 2, speaker: 'Sprecher 1', channel: 'system', text: 'Hallo zusammen' },
      { tStart: 2, tEnd: 4, speaker: 'Sprecher 2', channel: 'system', text: 'Ja hi' },
    ]);
  });
  it('Fallback: gruppiert words[] nach Sprecher', () => {
    const json = { results: { channels: [{ alternatives: [{ words: [
      { word: 'hallo', start: 0, end: 0.5, speaker: 0 },
      { word: 'welt', start: 0.5, end: 1, speaker: 0 },
      { word: 'hi', start: 1, end: 1.5, speaker: 1 },
    ] }] }] } };
    const segs = parseDeepgram(json);
    expect(segs.length).toBe(2);
    expect(segs[0]).toMatchObject({ speaker: 'Sprecher 1', text: 'hallo welt', channel: 'system' });
    expect(segs[1]).toMatchObject({ speaker: 'Sprecher 2', text: 'hi' });
  });
  it('leere Antwort -> []', () => {
    expect(parseDeepgram({})).toEqual([]);
    expect(parseDeepgram(null)).toEqual([]);
  });
});

describe('diarizeWithDeepgram', () => {
  it('ruft Deepgram mit korrekten Params/Headers und parst die Antwort', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-diar-'));
    const wav = path.join(dir, 'system.wav');
    fs.writeFileSync(wav, Buffer.alloc(100));
    let capturedUrl = null; let capturedHeaders = null;
    const fakeFetch = async (url, opts) => {
      capturedUrl = url; capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({ results: { utterances: [{ start: 0, end: 1, transcript: 'Test', speaker: 0 }] } }) };
    };
    const segs = await diarizeWithDeepgram(wav, { apiKey: 'dgkey', language: 'de', fetchImpl: fakeFetch });
    expect(capturedUrl).toContain('diarize=true');
    expect(capturedUrl).toContain('model=nova-3');
    expect(capturedUrl).toContain('language=de');
    expect(capturedHeaders.Authorization).toBe('Token dgkey');
    expect(segs[0]).toMatchObject({ speaker: 'Sprecher 1', text: 'Test', channel: 'system' });
  });
  it('wirft ohne API-Key', async () => {
    await expect(diarizeWithDeepgram('/tmp/x.wav', {})).rejects.toThrow();
  });
});
