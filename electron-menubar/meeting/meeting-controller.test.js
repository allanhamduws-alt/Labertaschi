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
    tee.emit('pcm', Buffer.alloc(200));      // System-Audio
    ctl.onMicPcm(Buffer.alloc(200));         // Mikrofon

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

  it('trackt Deepgram-Usage bei aktivierter Diarisierung', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-ctl3-'));
    const store = fakeStore({ diarizationEnabled: true, deepgramApiKey: 'dk' });
    const meetingStore = createMeetingStore({ baseDir, store });
    const tee = new FakeTee();
    const ctl = createMeetingController({
      store, meetingStore, audioTee: tee,
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100,
      // injizierte Fake-Diarisierung → ein System-Sprecher
      diarize: async () => ([{ tStart: 0, tEnd: 1, speaker: 'Sprecher 1', channel: 'system', text: 'Hallo' }]),
      now: () => 1700000000000,
    });

    const { id } = ctl.start();
    tee.emit('pcm', Buffer.alloc(200)); // genau ein System-Fenster → audio_system.wav entsteht
    await ctl.stop();

    const full = meetingStore.get(id);
    expect(full.index.diarizationUsed).toBe(true);
    expect(full.index.diarizationSeconds).toBeGreaterThan(0);
    expect(full.index.diarizationSpeakers).toBe(1);
    expect(full.index.diarizationCostUsd).toBeGreaterThanOrEqual(0);

    const usage = store.get('deepgramUsage');
    expect(usage.totalRequests).toBe(1);
    expect(usage.totalSeconds).toBeGreaterThan(0);
    expect(usage.totalCostUsd).toBeGreaterThan(0);
    expect(Object.keys(usage.perMonth).length).toBe(1);
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
    tee.emit('pcm', Buffer.alloc(200));
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
    const diarizeCalls = [];
    const ctl = createMeetingController({
      store, meetingStore, audioTee: new FakeTee(),
      getOverlayWindow: () => null, getMainWindow: () => null,
      fetchImpl: fakeFetch, windowSeconds: 1, sampleRate: 100,
      diarize: async (audioPath) => {
        diarizeCalls.push(audioPath);
        return [{ tStart: 0, tEnd: 1, speaker: 'Sprecher 1', channel: 'system', text: 'Vor Ort' }];
      },
      now: () => 1700000000000,
    });

    const { id } = ctl.start();
    expect(ctl.getStatus().meetingMode).toBe('call');
    ctl.setSessionMeetingMode('inperson');
    expect(ctl.getStatus().meetingMode).toBe('inperson');
    ctl.onMicPcm(Buffer.alloc(200)); // ein Mikro-Fenster → audio_mic.wav entsteht
    await ctl.stop();

    // Deepgram wurde auf die MIKROFON-Datei angewendet
    expect(diarizeCalls.some((p) => p.endsWith('audio_mic.wav'))).toBe(true);
    // und das Sprecher-Label landet auf einem mic-Kanal-Segment
    const segs = meetingStore.get(id).transcript.segments;
    expect(segs.some((s) => s.channel === 'mic' && s.speaker === 'Sprecher 1')).toBe(true);
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
