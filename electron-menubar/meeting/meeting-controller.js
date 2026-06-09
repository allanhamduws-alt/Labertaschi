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
const { mergeSegments, suppressBleed } = require('./transcript-merger');
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
    callDetector = null, // nativer Anruf-Detektor (macOS); null = nicht verfügbar → Signal-Fallback
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
  // Anruf-Erkennung: callActive = aktueller Zustand (für die Live-Anzeige im Overlay);
  // callDetectedEver = ob WÄHREND der Aufnahme je ein Anruf lief (für die Stop-Auswertung);
  // callDetectorRan = ob der native Detektor lief (sonst Signal-Präsenz-Fallback).
  let callActive = false;
  let callDetectedEver = false;
  let callDetectorRan = false;

  // Finale Audiodateien werden beim Stop aus den Chunk-Dateien gestreamt (RAM-schonend).

  // AudioTee-Listener-Referenzen (zum Entfernen)
  let onTeePcm = null;
  let onTeeError = null;
  let onTeeLog = null;
  let onDetectorState = null;

  // Wird der System-Kanal als „Gegenstelle" gewertet? Eine einzige Regel statt zweier Modi:
  // - Einstellung 'always'/'never' überschreibt.
  // - 'auto' (Default): lief der native Detektor, ihm vertrauen (anderer Prozess nutzt Mikro =
  //   echter Anruf, nicht nur Musik); sonst Fallback auf Signal-Präsenz (System-Kanal hatte Audio).
  function systemIsRemote() {
    const mode = store.get('systemAudioMode') || 'auto';
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return callDetectorRan ? callDetectedEver : gotSystemPcm;
  }

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
    // Einheitliche Regel (kein Modus mehr): ist der System-Kanal eine Gegenstelle, kommt er
    // dazu und das Lautsprecher-Echo wird aus dem Mic-Kanal gefiltert; sonst nur Mikrofon.
    const merged = systemIsRemote()
      ? mergeSegments(suppressBleed(micSegs, sysSegs), sysSegs)
      : mergeSegments(micSegs, []);
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
    callActive = false; callDetectedEver = false; callDetectorRan = false;

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

    // Nativer Anruf-Detektor (macOS): erkennt, ob ein ANDERER Prozess gerade das Mikrofon
    // nutzt (= Zwei-Wege-Anruf auf diesem Mac). Treibt die Live-Anzeige + die 'auto'-Regel.
    if (callDetector && callDetector.isSupported) {
      callDetectorRan = true;
      onDetectorState = (a) => onCallState(a);
      callDetector.on('call-state', onDetectorState);
      try { callDetector.start({ excludePid }); } catch { /* Detektor optional — Fallback greift */ }
    }

    overlayWin = getOverlayWindow ? getOverlayWindow() : null;
    _emit('meeting:started', {
      id: sessionId,
      diarization: sessionDiarization,
      callActive,
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
      if (callDetector) { try { callDetector.stop(); } catch { /* best effort */ } if (onDetectorState) callDetector.removeListener('call-state', onDetectorState); }

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

      // EINHEITLICHE Pipeline (kein Modus mehr): Immer beide Quellen aufgenommen. Eine Regel —
      // ist der System-Kanal eine Gegenstelle (systemIsRemote: Anruf erkannt bzw. Signal-Fallback),
      // wird er einbezogen und sein Lautsprecher-Echo aus dem Mic-Kanal gefiltert; sonst weggelassen.
      // Sprecher-Trennung (lokal, ohne Cloud): IMMER der Mikrofon-Kanal (lautester = „Ich", weitere
      // = Raum-/Telefon-Sprecher) UND — falls Gegenstelle aktiv — der System-Kanal („Gegenstelle"…).
      // Groqs Transkript-TEXT bleibt vollständig erhalten; nur das Sprecher-Label wird gesetzt.
      const remote = systemIsRemote();
      let micForMerge = remote && sysSegs.length ? suppressBleed(micSegs, sysSegs) : micSegs;
      let sysForMerge = remote ? sysSegs : [];
      let diarizationInfo = { diarizationUsed: false, diarizationSeconds: 0, diarizationCostUsd: 0, diarizationSpeakers: 0 };
      if (sessionDiarization) {
        const readPcm = (ch) => {
          try {
            const p = nodePath.join(meetingDir, `audio_${ch}.wav`);
            if (!fs.existsSync(p)) return null;
            const buf = fs.readFileSync(p);
            return new Int16Array(buf.buffer, buf.byteOffset + 44, Math.max(0, (buf.length - 44) >> 1));
          } catch { return null; }
        };
        let used = false;
        try {
          if (micForMerge.length) {
            const micPcm = readPcm('mic');
            if (micPcm) { const l = diarizeSegments(micForMerge, micPcm, { sampleRate, channel: 'mic' }); if (Array.isArray(l) && l.length) { micForMerge = l; used = true; } }
          }
          if (remote && sysForMerge.length) {
            const sysPcm = readPcm('system');
            if (sysPcm) { const l = diarizeSegments(sysForMerge, sysPcm, { sampleRate, channel: 'system' }); if (Array.isArray(l) && l.length) { sysForMerge = l; used = true; } }
          }
        } catch { /* lokale Diarisierung fehlgeschlagen — Groqs Transkript bleibt erhalten */ }
        if (used) diarizationInfo.diarizationUsed = true;
      }

      const merged = mergeSegments(micForMerge, sysForMerge);
      if (diarizationInfo.diarizationUsed) diarizationInfo.diarizationSpeakers = new Set(merged.map((s) => s.speaker)).size;
      try { meetingStore.saveTranscript(id, { segments: merged, language }); } catch { /* Disk-Fehler */ }

      const durationMs = now() - startedAtMs;
      const preview = (merged[0] && merged[0].text ? merged[0].text : '').slice(0, 120);
      const speakerNames = [...new Set(merged.map((s) => s.speaker))];
      const speakerCount = speakerNames.length || 1;
      // Titel: ein KI-Protokoll setzt gleich ein echtes Thema. Kommt KEIN Protokoll zustande,
      // lieber den ersten gesprochenen Satz als Titel verwenden — nicht nur Datum/Uhrzeit.
      const firstSentence = (merged.find((s) => (s.text || '').trim().length > 8)?.text || '').trim().slice(0, 70);
      const title = firstSentence || new Date(startedAtMs).toLocaleString('de-DE');
      try { meetingStore.finalizeIndex(id, { durationMs, preview, speakerCount, speakerNames, title, ...diarizationInfo }); } catch { /* Disk-Fehler */ }

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
          meetingStore.finalizeIndex(id, { hasSummary: true, title: sumTitle || title, summaryError: null });
        }
      } catch (e) {
        // Protokoll später per Button nachholbar; Grund merken, damit die UI z.B. das
        // Groq-Tageslimit klar anzeigt statt nur „kein Protokoll".
        try { meetingStore.finalizeIndex(id, { summaryError: e && e.code === 'rate_limit' ? 'rate_limit' : 'error' }); } catch { /* Disk best effort */ }
      }

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
      callActive,
    };
  }

  // Pro-Session-Override der Sprecher-Trennung (Overlay-Toggle): gilt nur für die
  // laufende Aufnahme, ändert den globalen Default (diarizationEnabled) nicht.
  function setSessionDiarization(enabled) {
    sessionDiarization = !!enabled;
    return sessionDiarization;
  }

  // Anruf-Zustand vom nativen Detektor (oder von Tests). Setzt die Live-Anzeige + merkt sich,
  // dass während der Aufnahme ein Anruf lief (für die 'auto'-Auswertung beim Stop).
  function onCallState(activeFlag) {
    callActive = !!activeFlag;
    if (callActive) callDetectedEver = true;
    if (active) _emit('meeting:call-state', { active: callActive });
    return callActive;
  }

  async function regenerateSummary(id) {
    const full = meetingStore.get(id);
    if (!full) return null;
    const text = transcriptToText(full.transcript.segments || []);
    if (!text.trim()) return null;
    let summary;
    try {
      summary = await generateMeetingSummary(text, {
        apiKey: store.get('groqApiKey'),
        model: store.get('meetingSummaryModel'),
        language: (full.transcript.language) || store.get('language'),
        fetchImpl,
      });
    } catch (e) {
      // Tageslimit verständlich an die UI zurückgeben statt nur zu scheitern.
      if (e && e.code === 'rate_limit') return { error: 'rate_limit' };
      throw e;
    }
    meetingStore.saveSummary(id, summary);
    // Titel aus dem (neu erzeugten) Protokoll-Thema aktualisieren — behebt Alt-Meetings,
    // deren Titel noch Datum/Uhrzeit ist (z.B. wenn das Protokoll beim Stop fehlschlug).
    const sumTitle = (summary.kurzzusammenfassung || '').slice(0, 60);
    meetingStore.finalizeIndex(id, sumTitle ? { hasSummary: true, title: sumTitle, summaryError: null } : { hasSummary: true, summaryError: null });
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
    // Dieselbe einheitliche Regel wie live: gab es System-Segmente, war es eine Gegenstelle →
    // einbeziehen + Echo aus dem Mic-Kanal filtern; sonst nur Mikrofon. Diarisierung (wenn aktiv):
    // immer Mikrofon (lautester = „Ich"), bei Gegenstelle auch der System-Kanal.
    const remote = sys.length > 0;
    let micF = remote ? suppressBleed(mic, sys) : mic;
    let sysF = remote ? sys : [];
    if (store.get('diarizationEnabled')) {
      try { if (channelPcm.mic && micF.length) micF = diarizeSegments(micF, channelPcm.mic, { sampleRate, channel: 'mic' }); } catch { /* best effort */ }
      try { if (remote && channelPcm.system && sysF.length) sysF = diarizeSegments(sysF, channelPcm.system, { sampleRate, channel: 'system' }); } catch { /* best effort */ }
    }
    const merged = mergeSegments(micF, sysF);
    const full = meetingStore.get(id);
    meetingStore.saveTranscript(id, { segments: merged, language: (full && full.transcript.language) || store.get('language') });
    return true;
  }

  return { start, stop, isActive, getStatus, setSessionDiarization, onCallState, onMicPcm, onMicLevel, regenerateSummary, retranscribe };
}

module.exports = { createMeetingController, transcriptToText, speakerLabel };
