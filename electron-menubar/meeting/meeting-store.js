'use strict';
// CommonJS — Meeting-Persistenz: Index (electron-store-ähnlich) + Dateien (fs)

const fs = require('node:fs');
const path = require('node:path');

/**
 * Factory: createMeetingStore({ baseDir, store })
 *
 * baseDir  — absoluter Pfad zum meetings/-Wurzelverzeichnis
 * store    — electron-store-ähnliches Objekt mit get(key)/set(key, value)
 *            Der Store hält unter dem Schlüssel 'meetings' ein MeetingIndexEntry[].
 */
function createMeetingStore({ baseDir, store }) {
  // ---------- Hilfsfunktionen ----------

  function _indexList() {
    return store.get('meetings') || [];
  }

  function _indexSet(entries) {
    store.set('meetings', entries);
  }

  function _meetingDir(id) {
    return path.join(baseDir, id);
  }

  function _transcriptPath(id) {
    return path.join(_meetingDir(id), 'transcript.json');
  }

  function _summaryPath(id) {
    return path.join(_meetingDir(id), 'summary.json');
  }

  // ---------- Öffentliche API ----------

  /**
   * create(startTime: string ISO) → id
   * Legt Ordner + chunks/-Unterverzeichnis + Index-Eintrag an.
   */
  function create(startTime) {
    const epochMs = Date.parse(startTime);
    const shortId = Math.random().toString(36).slice(2, 8);
    const id = `${epochMs}-${shortId}`;

    const dir = _meetingDir(id);
    fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });

    const entry = {
      id,
      startTime,
      durationMs: 0,
      title: startTime,
      speakerCount: 1,
      preview: '',
      hasSummary: false,
      favorite: false,
      // Deepgram-Diarization-Tracking (gesetzt beim Stop, nur bei Erfolg)
      diarizationUsed: false,
      diarizationSeconds: 0,
      diarizationCostUsd: 0,
      diarizationSpeakers: 0,
    };

    const entries = _indexList();
    entries.push(entry);
    _indexSet(entries);

    return id;
  }

  /**
   * chunkPath(id, channel, seq) → string
   * channel: 'mic' | 'system'
   */
  function chunkPath(id, channel, seq) {
    const padded = String(seq).padStart(6, '0');
    return path.join(_meetingDir(id), 'chunks', `${channel}_${padded}.wav`);
  }

  /**
   * saveTranscript(id, MeetingTranscript)
   */
  function saveTranscript(id, transcript) {
    fs.writeFileSync(_transcriptPath(id), JSON.stringify(transcript, null, 2), 'utf8');
  }

  /**
   * loadTranscript(id) → MeetingTranscript | null
   */
  function loadTranscript(id) {
    const p = _transcriptPath(id);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * saveSummary(id, MeetingSummary)
   */
  function saveSummary(id, summary) {
    fs.writeFileSync(_summaryPath(id), JSON.stringify(summary, null, 2), 'utf8');
  }

  /**
   * finalizeIndex(id, { durationMs, title, speakerCount, preview, hasSummary })
   * Mergt Felder in den Index-Eintrag und persistiert.
   */
  function finalizeIndex(id, updates) {
    const entries = _indexList();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    entries[idx] = { ...entries[idx], ...updates };
    _indexSet(entries);
  }

  /**
   * list() → MeetingIndexEntry[]
   */
  function list() {
    return [..._indexList()];
  }

  /**
   * get(id) → MeetingFull | null
   */
  function get(id) {
    const entries = _indexList();
    const index = entries.find((e) => e.id === id);
    if (!index) return null;

    const transcript = loadTranscript(id) || { segments: [], language: '' };

    let summary = null;
    const sp = _summaryPath(id);
    if (fs.existsSync(sp)) {
      try {
        summary = JSON.parse(fs.readFileSync(sp, 'utf8'));
      } catch {
        summary = null;
      }
    }

    // Audio-Pfade. Seit v1.11.0 wird Audio nach dem Meeting verworfen (Transkript ist der
    // Deliverable) → i.d.R. null. .opus existiert nur noch bei Alt-Meetings (vor v1.11.0,
    // damals komprimiert) und bleibt rückwärtskompatibel abspielbar; sonst .wav (keepAudio).
    const audioPath = (channel) => {
      const opus = path.join(_meetingDir(id), `audio_${channel}.opus`);
      if (fs.existsSync(opus)) return opus;
      const wav = path.join(_meetingDir(id), `audio_${channel}.wav`);
      return fs.existsSync(wav) ? wav : null;
    };

    return {
      index,
      transcript,
      summary,
      audio: {
        mic: audioPath('mic'),
        system: audioPath('system'),
      },
    };
  }

  /**
   * remove(id) → boolean
   * Löscht Ordner + Index-Eintrag.
   */
  function remove(id) {
    const entries = _indexList();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;

    // Ordner löschen (rekursiv)
    const dir = _meetingDir(id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    entries.splice(idx, 1);
    _indexSet(entries);
    return true;
  }

  /**
   * updateSpeakerName(id, channel: 'mic'|'system', name: string) → boolean
   * Ersetzt in transcript.segments alle Einträge, bei denen channel === channel,
   * mit speaker = name.
   */
  function updateSpeakerName(id, channel, name) {
    const transcript = loadTranscript(id);
    if (!transcript) return false;

    transcript.segments = transcript.segments.map((seg) => {
      if (seg.channel === channel) {
        return { ...seg, speaker: name };
      }
      return seg;
    });

    saveTranscript(id, transcript);

    // Index-Preview ggf. aktualisieren
    return true;
  }

  /**
   * renameSpeaker(id, fromSpeaker: string, toName: string) → boolean
   * Benennt EINEN konkreten Sprecher-Label um (z.B. 'Sprecher 1' → 'Max').
   * Zwei Labels auf denselben Namen setzen = zusammenführen (Merge).
   * Aktualisiert speakerCount im Index. Liefert false, wenn das Label nicht vorkommt.
   */
  function renameSpeaker(id, fromSpeaker, toName) {
    const transcript = loadTranscript(id);
    if (!transcript || !Array.isArray(transcript.segments)) return false;

    let changed = false;
    transcript.segments = transcript.segments.map((seg) => {
      if (seg.speaker === fromSpeaker) {
        changed = true;
        return { ...seg, speaker: toName };
      }
      return seg;
    });
    if (!changed) return false;

    saveTranscript(id, transcript);
    const speakerCount = new Set(transcript.segments.map((s) => s.speaker)).size || 1;
    finalizeIndex(id, { speakerCount });
    return true;
  }

  /**
   * toggleTodo(id, idx: number) → boolean
   * Schaltet summary.todos[idx].erledigt um.
   */
  function toggleTodo(id, idx) {
    const sp = _summaryPath(id);
    if (!fs.existsSync(sp)) return false;

    let summary;
    try {
      summary = JSON.parse(fs.readFileSync(sp, 'utf8'));
    } catch {
      return false;
    }

    if (!summary.todos || idx < 0 || idx >= summary.todos.length) return false;

    summary.todos[idx] = { ...summary.todos[idx], erledigt: !summary.todos[idx].erledigt };
    fs.writeFileSync(sp, JSON.stringify(summary, null, 2), 'utf8');
    return true;
  }

  return {
    create,
    chunkPath,
    saveTranscript,
    loadTranscript,
    saveSummary,
    finalizeIndex,
    list,
    get,
    remove,
    updateSpeakerName,
    renameSpeaker,
    toggleTodo,
  };
}

module.exports = { createMeetingStore };
