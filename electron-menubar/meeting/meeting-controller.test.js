import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
const { createMeetingController } = require('./meeting-controller.js');
const { createMeetingStore } = require('./meeting-store.js');

function fakeStore(init = {}) {
  const d = { language: 'de', groqApiKey: 'k', meetingSummaryModel: 'llama-3.3-70b-versatile', meetings: [], ...init };
  return { get: (k) => d[k], set: (k, v) => { d[k] = v; } };
}

class FakeTee extends EventEmitter {
  constructor() { super(); this.isRunning = false; }
  start() { this.isRunning = true; }
  stop() { this.isRunning = false; }
}

// Nicht-stilles PCM (200 Byte = 100 Samples bei sampleRate 100), damit das Stille-Gate
// es als echtes Signal durchlässt. Buffer.alloc(...) (Stille) würde geblockt.
function signal(bytes = 200, amp = 8000) {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) b.writeInt16LE(amp, i);
  return b;
}

async function fakeFetch(url) {
  if (String(url).includes('/audio/transcriptions')) {
    return { ok: true, json: async () => ({ segments: [{ start: 0, end: 1, text: 'Testsatz' }] }) };
  }
  // chat/completions → KI-Protokoll als JSON
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ kurzzusammenfassung: 'Z', kernpunkte: ['K'], todos: [], offeneFragen: [] }) } }],
    }),
  };
}

describe('MeetingController (Integration mit Fakes)', () => {
  it('nimmt auf, transkribiert beide Kanäle, mergt, erzeugt Protokoll und speichert', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl-'));
    const store = fakeStore();
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    const events = [];
    const win = { webContents: { send: (ch, p) => events.push({ ch, p }) } };

    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => win, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100, excludePid: 4242,
      now: () => 1700000000000,
    });

    const { id } = ctl.start();
    expect(typeof id).toBe('string');
    expect(tee.isRunning).toBe(true);

    // Genug PCM für je genau ein 1-s-Fenster (100 samples * 2 byte = 200 byte)
    tee.emit('pcm', signal());      // System-Audio
    ctl.onMicPcm(signal());         // Mikrofon

    await ctl.stop();

    const full = meetingStore.get(id);
    expect(full).not.toBeNull();
    expect(full.transcript.segments.length).toBeGreaterThan(0);
    // Beide Kanäle vertreten
    expect(full.transcript.segments.some((s) => s.channel === 'mic')).toBe(true);
    expect(full.transcript.segments.some((s) => s.channel === 'system')).toBe(true);
    // KI-Protokoll erzeugt
    expect(full.summary).not.toBeNull();
    expect(full.summary.kurzzusammenfassung).toBe('Z');
    expect(full.index.hasSummary).toBe(true);
    // Lifecycle-Events
    expect(events.some((e) => e.ch === 'meeting:started')).toBe(true);
    expect(events.some((e) => e.ch === 'meeting:stopped')).toBe(true);
    expect(tee.isRunning).toBe(false);
  });

  it('diarisiert lokal bei aktivierter Trennung (ohne Cloud, ohne Kosten)', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl3-'));
    const store = fakeStore({ diarizationEnabled: true });
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100,
      // injizierte lokale Diarisierung → labelt jedes Segment mit einem Sprecher
      diarizeSegments: (segs) => segs.map((s) => ({ ...s, speaker: 'Sprecher 1' })),
      now: () => 1700000000000,
    });

    const { id } = ctl.start();
    tee.emit('pcm', signal()); // genau ein System-Fenster → audio_system.wav entsteht
    await ctl.stop();

    const full = meetingStore.get(id);
    expect(full.index.diarizationUsed).toBe(true);
    expect(full.index.diarizationSpeakers).toBe(1);
    // Lokal: keine Cloud-Kosten, kein Deepgram-Usage-Tracking
    expect(full.index.diarizationCostUsd).toBe(0);
    expect(store.get('deepgramUsage')).toBeUndefined();
  });

  it('ohne Diarisierung kein Usage-Tracking (diarizationUsed bleibt false)', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl4-'));
    const store = fakeStore(); // diarizationEnabled default false
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100,
      now: () => 1700000000000,
    });
    const { id } = ctl.start();
    tee.emit('pcm', signal());
    await ctl.stop();
    expect(meetingStore.get(id).index.diarizationUsed).toBe(false);
    expect(store.get('deepgramUsage')).toBeUndefined();
  });

  it('setSessionDiarization überschreibt den Default für die laufende Aufnahme', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl5-'));
    const store = fakeStore({ diarizationEnabled: true, deepgramApiKey: 'dk' });
    const meetingStore = createMeetingStore({ baseDir, store });
    const ctl = createMeetingController({
      store, meetingStore, audioTee: new FakeTee(),
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100, now: () => 1700000000000,
    });
    ctl.start();
    expect(ctl.getStatus().diarization).toBe(true);
    ctl.setSessionDiarization(false);
    expect(ctl.getStatus().diarization).toBe(false);
  });

  it('Modus inperson diarisiert den MIKROFON-Kanal statt des System-Kanals', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl6-'));
    const store = fakeStore({ diarizationEnabled: true, deepgramApiKey: 'dk' });
    const meetingStore = createMeetingStore({ baseDir, store });
    let diarizeCallCount = 0;
    const ctl = createMeetingController({
      store, meetingStore, audioTee: new FakeTee(),
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100,
      // lokale Diarisierung: labelt die übergebenen Segmente; gibt eigenen Text NICHT vor
      diarizeSegments: (segs) => { diarizeCallCount++; return segs.map((s) => ({ ...s, speaker: 'Sprecher 1' })); },
      now: () => 1700000000000,
    });

    const { id } = ctl.start();
    expect(ctl.getStatus().meetingMode).toBe('call');
    ctl.setSessionMeetingMode('inperson');
    expect(ctl.getStatus().meetingMode).toBe('inperson');
    ctl.onMicPcm(signal()); // ein Mikro-Fenster → audio_mic.wav entsteht (System-Kanal bleibt leer)
    await ctl.stop();

    // Im inperson-Modus wird der MIKROFON-Kanal diarisiert (System-Segmente sind leer → kein
    // System-Aufruf). Das Sprecher-Label landet auf dem mic-Segment, Groqs TEXT bleibt erhalten.
    expect(diarizeCallCount).toBe(1);
    const segs = meetingStore.get(id).transcript.segments;
    expect(segs.some((s) => s.channel === 'mic' && s.speaker === 'Sprecher 1' && s.text === 'Testsatz')).toBe(true);
  });

  it('Stille-Gate: stille Chunks werden NICHT transkribiert (keine Halluzination)', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl7-'));
    const store = fakeStore();
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    let transcriptionCalls = 0;
    const countingFetch = async (url, opts) => {
      if (String(url).includes('/audio/transcriptions')) transcriptionCalls++;
      return fakeFetch(url, opts);
    };
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: countingFetch, windowSeconds: 1, sampleRate: 100, now: () => 1700000000000,
    });
    const { id } = ctl.start();
    tee.emit('pcm', Buffer.alloc(200));  // STILLE (alle Null) → soll NICHT transkribiert werden
    ctl.onMicPcm(Buffer.alloc(200));     // STILLE
    await ctl.stop();
    expect(transcriptionCalls).toBe(0); // kein STT-Aufruf auf Stille
    expect(meetingStore.get(id).transcript.segments.length).toBe(0); // kein "Vielen Dank"
  });

  it('löscht Audio nach dem Stop (Transkript ist der Deliverable, kein Opus, keine WAV/chunks)', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl8-'));
    const store = fakeStore();
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100, now: () => 1700000000000,
    });
    const { id } = ctl.start();
    tee.emit('pcm', signal());
    ctl.onMicPcm(signal());
    await ctl.stop();

    // Transkript bleibt erhalten
    const full = meetingStore.get(id);
    expect(full.transcript.segments.length).toBeGreaterThan(0);
    // Audio (WAV + Opus) ist weg, chunks/ gelöscht
    expect(full.audio.mic).toBeNull();
    expect(full.audio.system).toBeNull();
    const meetingDir = path.join(baseDir, id);
    const leftover = fs.readdirSync(meetingDir).filter((f) => f.endsWith('.wav') || f.endsWith('.opus'));
    expect(leftover).toEqual([]);
    expect(fs.existsSync(path.join(meetingDir, 'chunks'))).toBe(false);
  });

  it('keepAudio:true behält die finale Audiodatei (Debug/Test)', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl9-'));
    const store = fakeStore();
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100, now: () => 1700000000000,
      keepAudio: true,
    });
    const { id } = ctl.start();
    ctl.onMicPcm(signal());
    await ctl.stop();
    expect(meetingStore.get(id).audio.mic).not.toBeNull();
  });

  it('isActive spiegelt den Zustand', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl2-'));
    const store = fakeStore();
    const meetingStore = createMeetingStore({ baseDir, store });
    const ctl = createMeetingController({
      store, meetingStore, audioTee: new FakeTee(),
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100, now: () => 1700000000000,
    });
    expect(ctl.isActive()).toBe(false);
    ctl.start();
    expect(ctl.isActive()).toBe(true);
  });
});
