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

    // Jede Transkription an anderer Zeit, damit Mic + System sich NICHT überlappen (sonst
    // würde die Call-Modus-Echo-Unterdrückung das Mic-Segment als Lautsprecher-Echo verwerfen).
    let callN = 0;
    const seqFetch = async (url, opts) => {
      if (String(url).includes('/audio/transcriptions')) {
        const start = callN++ * 5;
        return { ok: true, json: async () => ({ segments: [{ start, end: start + 1, text: 'Testsatz' }] }) };
      }
      return fakeFetch(url, opts);
    };
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => win, getMainWindow: () => null,
      fetchImpl: seqFetch, windowSeconds: 1, sampleRate: 100, excludePid: 4242,
      now: () => 1700000000000,
    });

    const { id } = ctl.start();
    expect(typeof id).toBe('string');
    expect(tee.isRunning).toBe(true);
    // System-Kanal hat echtes Signal → wird automatisch als Gegenstelle einbezogen (kein Toggle mehr).

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
    ctl.onMicPcm(signal()); // Default 'inperson' → Mikrofon-Kanal wird getrennt
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

  it('ohne System-Audio wird NUR der Mikrofon-Kanal diarisiert (nie pauschal alles „Ich")', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl6-'));
    const store = fakeStore({ diarizationEnabled: true });
    const meetingStore = createMeetingStore({ baseDir, store });
    let diarizeCallCount = 0; const channelsSeen = [];
    const ctl = createMeetingController({
      store, meetingStore, audioTee: new FakeTee(),
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100,
      // lokale Diarisierung: labelt die übergebenen Segmente; gibt eigenen Text NICHT vor
      diarizeSegments: (segs, _pcm, opts) => { diarizeCallCount++; channelsSeen.push(opts && opts.channel); return segs.map((s) => ({ ...s, speaker: 'me' })); },
      now: () => 1700000000000,
    });

    const { id } = ctl.start();
    ctl.onMicPcm(signal()); // ein Mikro-Fenster → audio_mic.wav entsteht (System-Kanal bleibt leer)
    await ctl.stop();

    // Kein System-Audio → nur der MIKROFON-Kanal wird diarisiert (genau ein Aufruf, channel:'mic').
    expect(diarizeCallCount).toBe(1);
    expect(channelsSeen).toEqual(['mic']);
    const segs = meetingStore.get(id).transcript.segments;
    expect(segs.some((s) => s.channel === 'mic' && s.speaker === 'me' && s.text === 'Testsatz')).toBe(true);
  });

  it('systemAudioMode "never": System-Kanal wird trotz Signal NICHT einbezogen', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctlnever-'));
    const store = fakeStore({ systemAudioMode: 'never' });
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100, now: () => 1700000000000,
    });
    const { id } = ctl.start();
    tee.emit('pcm', signal()); // System-Signal vorhanden …
    ctl.onMicPcm(signal());
    await ctl.stop();
    const segs = meetingStore.get(id).transcript.segments;
    expect(segs.some((s) => s.channel === 'mic')).toBe(true);
    expect(segs.some((s) => s.channel === 'system')).toBe(false); // … aber bewusst ausgeschlossen
  });

  it('Anruf-Detektor: onCallState setzt callActive + emittiert meeting:call-state', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctlcall-'));
    const store = fakeStore();
    const meetingStore = createMeetingStore({ baseDir, store });
    const events = [];
    const win = { webContents: { send: (ch, p) => events.push({ ch, p }) } };
    // Fake-Detektor mit gleicher Schnittstelle wie CallDetectorManager
    const detector = new EventEmitter(); detector.isSupported = true;
    detector.start = () => {}; detector.stop = () => {};
    const ctl = createMeetingController({
      store, meetingStore, audioTee: new FakeTee(), callDetector: detector,
      getOverlayWindow: () => win, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100, now: () => 1700000000000,
    });
    ctl.start();
    expect(ctl.getStatus().callActive).toBe(false);
    detector.emit('call-state', true); // Detektor meldet: anderer Prozess nutzt Mikro
    expect(ctl.getStatus().callActive).toBe(true);
    expect(events.some((e) => e.ch === 'meeting:call-state' && e.p.active === true)).toBe(true);
    await ctl.stop();
  });

  it('auto + Detektor lief, aber kein Anruf (Musik): System-Signal wird NICHT als Gegenstelle gewertet', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctlmusic-'));
    const store = fakeStore(); // systemAudioMode default 'auto'
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    const detector = new EventEmitter(); detector.isSupported = true;
    detector.start = () => {}; detector.stop = () => {};
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee, callDetector: detector,
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100, now: () => 1700000000000,
    });
    const { id } = ctl.start();
    // Detektor lief, meldet aber NIE einen Anruf → System-Signal gilt als Musik/Medien.
    tee.emit('pcm', signal());
    ctl.onMicPcm(signal());
    await ctl.stop();
    const segs = meetingStore.get(id).transcript.segments;
    expect(segs.some((s) => s.channel === 'system')).toBe(false);
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
