import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const { createMeetingStore } = require('./meeting-store.js');

function fakeStore() {
  const data = { meetings: [] };
  return { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

describe('MeetingStore', () => {
  let baseDir, store, ms;
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-meet-'));
    store = fakeStore();
    ms = createMeetingStore({ baseDir, store });
  });
  it('create legt Ordner + Index an', () => {
    const id = ms.create('2026-06-08T10:00:00.000Z');
    expect(fs.existsSync(path.join(baseDir, id, 'chunks'))).toBe(true);
    expect(ms.list().length).toBe(1);
    expect(ms.list()[0].id).toBe(id);
  });
  it('saveTranscript + get liefert Segmente', () => {
    const id = ms.create('2026-06-08T10:00:00.000Z');
    ms.saveTranscript(id, { segments: [{ tStart: 0, tEnd: 1, speaker: 'me', channel: 'mic', text: 'Hi' }], language: 'de' });
    expect(ms.get(id).transcript.segments[0].text).toBe('Hi');
  });
  it('toggleTodo schaltet erledigt um', () => {
    const id = ms.create('2026-06-08T10:00:00.000Z');
    ms.saveSummary(id, { kurzzusammenfassung: '', kernpunkte: [], todos: [{ text: 'X', verantwortlich: null, erledigt: false }], offeneFragen: [], generatedAt: '', model: '' });
    ms.toggleTodo(id, 0);
    expect(ms.get(id).summary.todos[0].erledigt).toBe(true);
  });
  it('remove löscht Ordner + Index', () => {
    const id = ms.create('2026-06-08T10:00:00.000Z');
    expect(ms.remove(id)).toBe(true);
    expect(ms.list().length).toBe(0);
    expect(fs.existsSync(path.join(baseDir, id))).toBe(false);
  });
});
