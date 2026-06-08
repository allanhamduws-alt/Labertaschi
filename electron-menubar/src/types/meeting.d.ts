// Datenmodell für den Meeting-Recorder (Phase 1).
// Siehe docs/superpowers/specs/2026-06-08-meeting-recorder-design.md

export interface MeetingIndexEntry {
  id: string; // `${startEpochMs}-${shortId}`
  startTime: string; // ISO
  durationMs: number;
  title: string; // auto aus Kurzzusammenfassung, editierbar
  speakerCount: number;
  preview: string; // erste ~120 Zeichen des Transkripts
  hasSummary: boolean;
  favorite: boolean;
}

export interface MeetingSegment {
  tStart: number; // Sekunden ab Sessionstart
  tEnd: number;
  speaker: 'me' | 'other' | string; // Phase 2: 'other-1', ...
  channel: 'mic' | 'system';
  text: string; // wortgetreu
}

export interface MeetingTranscript {
  segments: MeetingSegment[];
  language: string;
}

export interface MeetingTodo {
  text: string;
  verantwortlich: string | null;
  erledigt: boolean;
}

export interface MeetingSummary {
  kurzzusammenfassung: string;
  kernpunkte: string[];
  todos: MeetingTodo[];
  offeneFragen: string[];
  generatedAt: string;
  model: string;
}

export interface MeetingFull {
  index: MeetingIndexEntry;
  transcript: MeetingTranscript;
  summary: MeetingSummary | null;
  audio: { mic: string | null; system: string | null }; // absolute Pfade
}
