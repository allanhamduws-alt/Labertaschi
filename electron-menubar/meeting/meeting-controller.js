// MeetingController — orchestriert eine Meeting-Aufnahme im Main-Prozess. CommonJS.
// Verdrahtet: AudioTee (System-Audio) + Mic-PCM (vom Overlay-Renderer) →
// ChunkAccumulator (30 s) → crash-sichere Chunk-Dateien → TranscriptionQueue
// (Groq Whisper) → TranscriptMerger → MeetingStore + Live-Events + HealthMonitor.
// Beim Stop: finale Audio-Dateien + KI-Protokoll (Groq Llama).
'use strict';

const fs = require('node:fs');
const { encodeWav, concatWavFiles } = require('../audio/wav-encoder');
const { rms, maxFrameRms } = require('../audio/pcm-utils');
const { ChunkAccumulator } = require('./chunk-accumulator');
const { TranscriptionQueue } = require('./transcription-queue');
const { mergeSegments } = require('./transcript-merger');
const { evaluateHealth } = require('./health-monitor');
const { generateMeetingSummary } = require('./summary');
const { diarizeLocal } = require('./diarize-local');

function speakerLabel(s) {
  if (s === 'me') return 'Ich';
  if (s === 'other') return 'Gegenstelle';
  return s;
}

function transcriptToText(segments) {
  return segments.map((s) => `${speakerLabel(s.speaker)}: ${s.text}`).join('\n');
}

/**
 * @param {{
 *   store: { get: Function, set?: Function },
 *   meetingStore: object,           // createMeetingStore(...)
 *   audioTee: import('events').EventEmitter & { start: Function, stop: Function, isRunning: boolean },
 *   getOverlayWindow: () => any,    // öffnet/liefert das Overlay-Fenster
 *   getMainWindow: () => any,
 *   fetchImpl?: Function,
 *   windowSeconds?: number,
 *   sampleRate?: number,
 *   excludePid?: number,
 *   now?: () => number,             // injizierbar für Tests
 * }} deps
 */
function createMeetingController(deps) {
  const {
    store, meetingStore, audioTee, getOverlayWindow, getMainWindow,
    fetchImpl, windowSeconds = 30, sampleRate = 16000, excludePid,
    chunkMinSeconds, chunkMaxSeconds, silenceRms,
    speechGate = 0.0008, // Stille-Gate: tief genug, dass leise Stimmen bleiben, hoch genug für Digital-Stille
    diarizeSegments = diarizeLocal, // lokale Sprecher-Trennung (injizierbar für Tests)
    keepAudio = false, // true = finale Audiodateien NICHT löschen (Debug/Test/Loopback-Validierung)
    now = () => Date.now(),
  } = deps;

  // Baut einen ChunkAccumulator: VAD-Schnitt (an Sprechpausen) wenn min/max gesetzt,
  // sonst fester Schnitt bei windowSeconds (Abwärtskompatibilität / Tests).
  function makeAccumulator(onChunk) {
    const opts = { sampleRate, onChunk };
    if (chunkMinSeconds != null || chunkMaxSeconds != null) {
      opts.minSeconds = chunkMinSeconds != null ? chunkMinSeconds : 20;
      opts.maxSeconds = chunkMaxSeconds != null ? chunkMaxSeconds : 40;
      if (silenceRms != null) opts.silenceRms = silenceRms;
    } else {
      opts.windowSeconds = windowSeconds;
    }
    return new ChunkAccumulator(opts);
  }

  let active = false;
  let stopping = false;   // true während der async-Finalisierung in stop()
  let sessionId = null;
  let startedAtMs = 0;
  let micSegs = [];
  let sysSegs = [];
  // Bisheriger Transkript-Kontext je Kanal (als Whisper-prompt für Kontinuität)
  let lastTextByChannel = { mic: '', system: '' };
  let micAcc = null;
  let sysAcc = null;
  let queue = null;
  let healthTimer = null;
  let overlayWin = null;

  // Health-/Pegel-Zustand
  let lastSystemPcmMs = 0;
  let micLevel = 0;
  let systemLevel = 0;
  let micWriteOk = true;
  let diskError = false;
  let permissionDenied = false;
  let systemAudioError = null;
  let gotSystemPcm = false;
  // Pro-Session-Entscheidung zur Sprecher-Trennung (Snapshot des globalen Defaults
  // beim Start, per Overlay-Toggle für DIESE Aufnahme überschreibbar).
  let sessionDiarization = false;
  // Meeting-Modus: 'call' = System-Kanal trennen (Gegenstelle), Mikro = "Ich";
  // 'inperson' = Mikrofon-Kanal trennen (mehrere Leute vor Ort an einem Mikro).
  let sessionMeetingMode = 'call';

  // Finale Audiodateien werden beim Stop aus den Chunk-Dateien gestreamt (RAM-schonend).

  // AudioTee-Listener-Referenzen (zum Entfernen)
  let onTeePcm = null;
  let onTeeError = null;
  let onTeeLog = null;

  function _emit(channel, payload) {
    const wins = [overlayWin, getMainWindow ? getMainWindow() : null];
    for (const w of wins) {
      try {
        if (w && w.webContents && (typeof w.isDestroyed !== 'function' || !w.isDestroyed())) {
          w.webContents.send(channel, payload);
        }
      } catch { /* Fenster evtl. zerstört — ignorieren */ }
    }
  }

  function _handleChunk(channel, { pcm, seq, tOffset }) {
    // 1) Crash-sicher: WAV sofort auf Platte, VOR der Transkription
    const wav = encodeWav(pcm, { sampleRate, channels: 1 });
    try {
      fs.writeFileSync(meetingStore.chunkPath(sessionId, channel, seq), wav);
      micWriteOk = true;
    } catch {
      diskError = true;
      micWriteOk = false;
    }
    // 2) Stille-Gate: nur Chunks mit echtem Signal transkribieren. Auf reiner Stille
    //    halluziniert Whisper Phrasen ("Vielen Dank"). Schwelle liegt deutlich unter
    //    Stimm-Pegel, damit leise/entfernte Stimmen NICHT als Rauschen wegfallen.
    //    Die Audiodatei (Chunk) wird trotzdem gesichert — nur die STT wird übersprungen.
    if (maxFrameRms(pcm, { sampleRate }) >= speechGate) {
      queue.enqueue({ channel, wavBuffer: wav, tOffset });
    }
  }

  function _onSegments({ channel, segments }) {
    if (!segments || segments.length === 0) return;
    (channel === 'mic' ? micSegs : sysSegs).push(...segments);
    // Kontext für den nächsten Chunk dieses Kanals fortschreiben (letzte ~800 Zeichen)
    const added = segments.map((s) => s.text).join(' ');
    lastTextByChannel[channel] = ((lastTextByChannel[channel] || '') + ' ' + added).slice(-800).trimStart();
    const merged = mergeSegments(micSegs, sysSegs);
    _emit('meeting:transcript-chunk', merged);
    try {
      meetingStore.saveTranscript(sessionId, { segments: merged, language: store.get('language') });
    } catch { diskError = true; }
  }

  function _emitHealth() {
    const secondsSinceSystemAudio = lastSystemPcmMs ? (now() - lastSystemPcmMs) / 1000 : 0;
    const health = evaluateHealth({
      micWriteOk,
      systemProcessAlive: !!audioTee.isRunning,
      systemPermissionDenied: permissionDenied,
      systemAudioError,
      diskError,
      micLevel,
      systemLevel,
      secondsSinceSystemAudio,
      gotSystemPcm,
      secondsSinceStart: (now() - startedAtMs) / 1000,
    });
    _emit('meeting:status', {
      color: health.color,
      reason: health.reason,
      durationMs: now() - startedAtMs,
      micLevel,
      systemLevel,
    });
  }

  function start() {
    if (active || stopping) return { id: sessionId };
    active = true;
    startedAtMs = now();
    sessionId = meetingStore.create(new Date(startedAtMs).toISOString());

    micSegs = []; sysSegs = []; lastTextByChannel = { mic: '', system: '' };
    micLevel = 0; systemLevel = 0; micWriteOk = true; diskError = false; permissionDenied = false; systemAudioError = null; gotSystemPcm = false;
    lastSystemPcmMs = startedAtMs; // Stille-Erkennung erst nach Schwelle
    sessionDiarization = !!store.get('diarizationEnabled');
    sessionMeetingMode = 'call';

    queue = new TranscriptionQueue({
      apiKey: store.get('groqApiKey'),
      language: store.get('language'),
      fetchImpl,
      getPrompt: (ch) => lastTextByChannel[ch] || '',
    });
    queue.on('segments', _onSegments);
    queue.on('error', () => { /* Audio bleibt gesichert; Status bleibt grün/gelb */ });

    micAcc = makeAccumulator((c) => _handleChunk('mic', c));
    sysAcc = makeAccumulator((c) => _handleChunk('system', c));

    onTeePcm = (buf) => {
      systemLevel = rms(buf);
      // Nur ECHTES Signal (mit Energie) zählt als „System-Audio empfangen".
      // Reine Stille (rms ~0) bedeutet meist: Berechtigung fehlt -> AudioTee tappt lautlos.
      if (systemLevel > 0.005) { lastSystemPcmMs = now(); gotSystemPcm = true; }
      sysAcc.push(buf);
    };
    onTeeError = (err) => {
      const msg = err && err.message ? err.message : 'unbekannter Fehler';
      const m = msg.toLowerCase();
      if (m.includes('permission') || m.includes('berechtigung') || m.includes('not authorized') || m.includes('tcc')) {
        permissionDenied = true;
      } else {
        systemAudioError = msg;
      }
    };
    onTeeLog = () => {};
    audioTee.on('pcm', onTeePcm);
    audioTee.on('error', onTeeError);
    audioTee.on('log', onTeeLog);
    audioTee.start({ sampleRate, chunkDurationMs: 200, excludeProcesses: excludePid ? [excludePid] : undefined });

    overlayWin = getOverlayWindow ? getOverlayWindow() : null;
    _emit('meeting:started', {
      id: sessionId,
      diarization: sessionDiarization,
      meetingMode: sessionMeetingMode,
      hasDeepgramKey: !!store.get('deepgramApiKey'),
    });
    healthTimer = setInterval(_emitHealth, 1000);

    return { id: sessionId };
  }

  function onMicPcm(buf) {
    if (!active || !micAcc) return;
    micLevel = rms(buf);
    micAcc.push(buf);
  }

  function onMicLevel(lvl) {
    if (typeof lvl === 'number') micLevel = lvl;
  }

  async function stop() {
    if (!active) return { id: null };
    active = false;
    stopping = true; // blockiert start() bis die Finalisierung abgeschlossen ist
    const id = sessionId;
    try {
      if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }

      micAcc.flush();
      sysAcc.flush();
      audioTee.stop();
      if (onTeePcm) audioTee.removeListener('pcm', onTeePcm);
      if (onTeeError) audioTee.removeListener('error', onTeeError);
      if (onTeeLog) audioTee.removeListener('log', onTeeLog);

      await queue.idle();

      const language = store.get('language');
      // Finale Audiodateien aus den crash-sicher geschriebenen Chunk-Dateien
      // zusammenfügen (streaming, konstanter RAM — auch bei mehrstündigen Meetings).
      const nodePath = require('node:path');
      const chunksDir = nodePath.dirname(meetingStore.chunkPath(id, 'mic', 0));
      const meetingDir = nodePath.dirname(chunksDir);
      try {
        for (const ch of ['mic', 'system']) {
          const files = fs.readdirSync(chunksDir)
            .filter((f) => f.startsWith(ch + '_') && f.endsWith('.wav'))
            .sort()
            .map((f) => nodePath.join(chunksDir, f));
          if (files.length) concatWavFiles(files, nodePath.join(meetingDir, `audio_${ch}.wav`), { sampleRate, channels: 1 });
        }
      } catch { /* Audio-Finalisierung fehlgeschlagen — Chunk-Dateien bleiben als Fallback */ }

      // LOKALE Sprecher-Diarisierung (ohne Cloud, kostenlos, kein API-Key): pro Transkript-
      // Segment werden akustische Merkmale (Grundton/Pitch) berechnet und in N Sprecher
      // geclustert. Funktioniert bei EINEM Mikrofon (mehrere Personen am selben Mikro) —
      // genau der Fall, an dem Deepgrams kanalbasierte Trennung scheitert. Groqs Transkript-
      // TEXT bleibt vollständig erhalten; nur das Sprecher-Label pro Segment wird gesetzt.
      // Modus 'call' (Default): System-Kanal trennen (Gegenstelle), Mikro bleibt "Ich".
      // Modus 'inperson': Mikrofon-Kanal trennen (mehrere Leute vor Ort an EINEM Mikro).
      let micForMerge = micSegs;
      let sysForMerge = sysSegs;
      let diarizationInfo = { diarizationUsed: false, diarizationSeconds: 0, diarizationCostUsd: 0, diarizationSpeakers: 0 };
      if (sessionDiarization) {
        const targetChannel = sessionMeetingMode === 'inperson' ? 'mic' : 'system';
        const segs = targetChannel === 'mic' ? micSegs : sysSegs;
        try {
          const targetPath = nodePath.join(meetingDir, `audio_${targetChannel}.wav`);
          if (fs.existsSync(targetPath) && segs.length) {
            const buf = fs.readFileSync(targetPath);
            const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, Math.max(0, (buf.length - 44) >> 1));
            const labeled = diarizeSegments(segs, pcm, { sampleRate });
            if (Array.isArray(labeled) && labeled.length) {
              if (targetChannel === 'mic') micForMerge = labeled; else sysForMerge = labeled;
              diarizationInfo = {
                diarizationUsed: true,
                diarizationSeconds: 0, // lokal: keine Sekunden-/Kostenabrechnung
                diarizationCostUsd: 0,
                diarizationSpeakers: new Set(labeled.map((s) => s.speaker)).size,
              };
            }
          }
        } catch { /* lokale Diarisierung fehlgeschlagen — Groqs Transkript bleibt erhalten */ }
      }

      const merged = mergeSegments(micForMerge, sysForMerge);
      try { meetingStore.saveTranscript(id, { segments: merged, language }); } catch { /* Disk-Fehler */ }

      const durationMs = now() - startedAtMs;
      const preview = (merged[0] && merged[0].text ? merged[0].text : '').slice(0, 120);
      const speakerCount = new Set(merged.map((s) => s.speaker)).size || 1;
      const title = new Date(startedAtMs).toLocaleString('de-DE');
      try { meetingStore.finalizeIndex(id, { durationMs, preview, speakerCount, title, ...diarizationInfo }); } catch { /* Disk-Fehler */ }

      // KI-Protokoll (best effort)
      try {
        const text = transcriptToText(merged);
        if (text.trim()) {
          const summary = await generateMeetingSummary(text, {
            apiKey: store.get('groqApiKey'),
            model: store.get('meetingSummaryModel'),
            language,
            fetchImpl,
          });
          meetingStore.saveSummary(id, summary);
          const sumTitle = (summary.kurzzusammenfassung || '').slice(0, 60);
          meetingStore.finalizeIndex(id, { hasSummary: true, title: sumTitle || title });
        }
      } catch { /* Protokoll später per Button nachholbar */ }

      // Speicher: Das Transkript IST der Deliverable (Allans Entscheidung). Die volle
      // Audioqualität wurde live für Groq-STT + Deepgram-Diarisierung genutzt; danach wird
      // die Audio NICHT mehr aufbewahrt. Kein Opus mehr (16 kbit/s zerstörte Wiedergabe/
      // Re-Processing). 'keepAudio' (Debug/Test/Loopback) behält die finalen WAV-Spuren.
      if (!keepAudio) {
        for (const ch of ['mic', 'system']) {
          try { fs.rmSync(nodePath.join(meetingDir, `audio_${ch}.wav`)); } catch { /* nicht vorhanden / best effort */ }
        }
      }
      // Redundante Chunk-Dateien entfernen (nur Absturzsicherung während der Aufnahme).
      try { fs.rmSync(chunksDir, { recursive: true, force: true }); } catch { /* best effort */ }

      _emit('meeting:stopped', { id });
      try { if (overlayWin && typeof overlayWin.hide === 'function') overlayWin.hide(); } catch { /* Fake/zerstört */ }
      overlayWin = null;
    } finally {
      sessionId = null;
      stopping = false;
    }
    return { id };
  }

  function isActive() {
    return active;
  }

  // Pull-Modell: das Overlay fragt beim Mount den aktuellen Zustand ab,
  // falls das 'meeting:started'-Push-Event verloren ging (Fenster noch nicht geladen).
  function getStatus() {
    return {
      active,
      id: sessionId,
      diarization: active ? sessionDiarization : !!store.get('diarizationEnabled'),
      meetingMode: sessionMeetingMode,
      hasDeepgramKey: !!store.get('deepgramApiKey'),
    };
  }

  // Pro-Session-Override der Sprecher-Trennung (Overlay-Toggle): gilt nur für die
  // laufende Aufnahme, ändert den globalen Default (diarizationEnabled) nicht.
  function setSessionDiarization(enabled) {
    sessionDiarization = !!enabled;
    return sessionDiarization;
  }

  // Pro-Session-Meeting-Modus (Overlay): 'call' (System trennen) oder 'inperson'
  // (Mikrofon trennen). Greift beim Stop, ändert keinen globalen Default.
  function setSessionMeetingMode(mode) {
    sessionMeetingMode = mode === 'inperson' ? 'inperson' : 'call';
    return sessionMeetingMode;
  }

  async function regenerateSummary(id) {
    const full = meetingStore.get(id);
    if (!full) return null;
    const text = transcriptToText(full.transcript.segments || []);
    if (!text.trim()) return null;
    const summary = await generateMeetingSummary(text, {
      apiKey: store.get('groqApiKey'),
      model: store.get('meetingSummaryModel'),
      language: (full.transcript.language) || store.get('language'),
      fetchImpl,
    });
    meetingStore.saveSummary(id, summary);
    meetingStore.finalizeIndex(id, { hasSummary: true });
    return summary;
  }

  async function retranscribe(id) {
    const path = require('node:path');
    // 'Neu transkribieren' funktioniert nur, solange noch eine finale WAV existiert
    // (ältere Meetings oder keepAudio). Standardmäßig wird Audio nach dem Stop gelöscht
    // (Transkript ist der Deliverable) → dann liefert retranscribe false (UI deaktiviert
    // den Button entsprechend, da meeting.audio dann null ist).
    const meetingDir = path.dirname(path.dirname(meetingStore.chunkPath(id, 'mic', 0)));
    const mic = []; const sys = [];
    const lastText = { mic: '', system: '' };
    const q = new TranscriptionQueue({
      apiKey: store.get('groqApiKey'), language: store.get('language'), fetchImpl,
      getPrompt: (ch) => lastText[ch] || '',
    });
    q.on('segments', ({ channel, segments }) => {
      (channel === 'mic' ? mic : sys).push(...segments);
      const added = segments.map((s) => s.text).join(' ');
      lastText[channel] = ((lastText[channel] || '') + ' ' + added).slice(-800).trimStart();
    });

    const windowBytes = (windowSeconds || 30) * sampleRate * 2;
    let any = false;
    const channelPcm = {}; // Int16-PCM je Kanal (für die lokale Diarisierung wiederverwendet)
    for (const channel of ['mic', 'system']) {
      const wavPath = path.join(meetingDir, `audio_${channel}.wav`);
      if (!fs.existsSync(wavPath)) continue; // Audio wurde nach dem Stop gelöscht
      any = true;
      const buf = fs.readFileSync(wavPath);
      const pcm = buf.subarray(44); // WAV-Header (44 Bytes) überspringen
      channelPcm[channel] = new Int16Array(buf.buffer, buf.byteOffset + 44, Math.max(0, (buf.length - 44) >> 1));
      let cumOffset = 0;
      for (let off = 0; off < pcm.length; off += windowBytes) {
        const slice = pcm.subarray(off, Math.min(off + windowBytes, pcm.length));
        // Stille-Gate (wie bei der Live-Transkription): leere Fenster nicht senden.
        if (maxFrameRms(slice, { sampleRate }) >= speechGate) {
          const chunkWav = encodeWav(Buffer.from(slice), { sampleRate, channels: 1 });
          q.enqueue({ channel, wavBuffer: chunkWav, tOffset: cumOffset });
        }
        cumOffset += slice.length / 2 / sampleRate;
      }
    }
    if (!any) return false;
    await q.idle();
    // Lokale Sprecher-Trennung beim Neu-Transkribieren (wenn aktiviert): trennt mehrere
    // Personen am Mikrofon (Vor-Ort-Fall). So lassen sich bestehende Aufnahmen nachträglich
    // in Sprecher auftrennen, ohne neu aufzunehmen.
    let micF = mic; let sysF = sys;
    if (store.get('diarizationEnabled')) {
      try {
        if (channelPcm.mic && mic.length > 1) micF = diarizeSegments(mic, channelPcm.mic, { sampleRate });
      } catch { /* Trennung best effort — Text bleibt erhalten */ }
    }
    const merged = mergeSegments(micF, sysF);
    const full = meetingStore.get(id);
    meetingStore.saveTranscript(id, { segments: merged, language: (full && full.transcript.language) || store.get('language') });
    return true;
  }

  return { start, stop, isActive, getStatus, setSessionDiarization, setSessionMeetingMode, onMicPcm, onMicLevel, regenerateSummary, retranscribe };
}

module.exports = { createMeetingController, transcriptToText, speakerLabel };
