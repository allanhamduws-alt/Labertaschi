import type { MeetingIndexEntry, MeetingFull, MeetingSummary, MeetingSegment } from './meeting';

export interface Settings {
  groqApiKey: string;
  enablePolish: boolean;
  shortcut: string;
  autoStart: boolean;
  language: 'de' | 'en';
  autopaste: boolean;
  beepEnabled: boolean;
  copyToClipboard: boolean;
  hideDock: boolean;
  activeProfile: string;
  pttThreshold: number;
  meetingHotkey: string;
  diarizationEnabled: boolean;
  // System-Audio (Gegenstelle eines Anrufs auf diesem Computer): 'auto' = automatisch erkennen
  // (empfohlen), 'always' = immer einbeziehen, 'never' = nie. Default 'auto'.
  systemAudioMode: 'auto' | 'always' | 'never';
  // LLM für Protokoll + Sprecher-Korrektur. 'auto' = Groq, bei Limit Gemini-Fallback.
  geminiApiKey: string;
  llmProvider: 'auto' | 'groq' | 'gemini';
}

export interface HistoryItem {
  id: number;
  timestamp: string;
  transcript: string;
  polished: string | null;
  language: string;
  role: string;
  wordCount: number;
  delta: {
    wordsBefore: number;
    wordsAfter: number;
    wordsDiff: number;
    fillersRemoved: number;
    fillersList: string[];
  } | null;
  polishUsed: boolean;
  favorite: boolean;
}

export interface Stats {
  wordsTotal: number;
  wordsToday: number;
  wordsWeek: number;
  minutesTotal: number;
  minutesToday: number;
  minutesWeek: number;
  sessionsCount: number;
  sessionsToday: number;
  sessionsWeek: number;
  errorsCount: number;
}

export interface Profile {
  name: string;
  language: string;
  polishFlavor: string;
  autopaste: boolean;
  hotkey?: string;
}

export interface CustomAgent {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  tone?: string;
  format?: string;
  length?: string;
  creativity?: number;
  outputLang?: string;
  domain?: string;
  fillerWords?: boolean;
  isPromptGenerator?: boolean;
  hotkey?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Snippet {
  id: string;
  name: string;
  template: string;
}

export interface ScreenContext {
  files: string[];
  activeFile?: string;
  visibleCode?: string;
  errors?: string[];
  context?: string;
}

export interface Platform {
  isMac: boolean;
  isWin: boolean;
  platform: string;
  version?: string;
}

export interface ElectronAPI {
  // Settings
  getSettings: () => Promise<Settings>;
  setSettings: (settings: Partial<Settings>) => Promise<boolean>;

  // History
  getHistory: () => Promise<HistoryItem[]>;
  clearHistory: () => Promise<boolean>;
  copyHistoryItem: (id: number) => Promise<boolean>;
  deleteHistoryItem: (id: number) => Promise<boolean>;
  toggleFavorite: (id: number) => Promise<boolean>;
  onHistoryUpdated: (cb: (history: HistoryItem[]) => void) => void;

  // Recording
  onRecordingStart: (cb: () => void) => void;
  onRecordingStop: (cb: () => void) => void;
  onStatusUpdate: (cb: (status: { status: string; detail?: string }) => void) => void;
  onErrorRetry: (cb: (data: { message: string; hotkey: string }) => void) => void;
  sendAudio: (audioData: ArrayBuffer) => void;

  // Transcription control
  startTranscription: () => Promise<boolean>;
  stopTranscription: () => Promise<boolean>;
  getTranscriptionStatus: () => Promise<{ isRecording: boolean }>;

  // Stats
  getStats: () => Promise<Stats>;
  getOwnerStats: () => Promise<{ tokensGroq: number; tokensGroqPolish: number; estimatedCost: number } | null>;
  onStatsUpdated: (cb: (stats: Stats) => void) => void;

  // Owner Mode
  checkOwnerMode: () => Promise<boolean>;
  toggleOwnerMode: (password: string) => Promise<boolean>;

  // Profiles / Agents
  getProfiles: () => Promise<{ active: string; profiles: Record<string, Profile>; customAgents: CustomAgent[] }>;
  setActiveProfile: (profileId: string) => Promise<boolean>;
  updateProfile: (profileId: string, updates: Partial<Profile>) => Promise<boolean>;
  onAgentSwitched: (cb: (data: { id: string; name: string; icon?: string; color?: string }) => void) => void;

  // Custom Agents CRUD
  getCustomAgents: () => Promise<CustomAgent[]>;
  createAgent: (agent: Partial<CustomAgent>) => Promise<CustomAgent>;
  updateAgent: (agentId: string, updates: Partial<CustomAgent>) => Promise<CustomAgent | null>;
  deleteAgent: (agentId: string) => Promise<boolean>;
  reorderAgents: (orderedIds: string[]) => Promise<CustomAgent[]>;
  updateAgentHotkey: (agentId: string, hotkey: string) => Promise<CustomAgent | null>;

  // Screen Parser
  captureScreen: () => Promise<ScreenContext | null>;
  getScreenContext: () => Promise<ScreenContext | null>;
  onScreenContext: (cb: (data: ScreenContext) => void) => void;

  // Snippets
  getSnippets: () => Promise<Snippet[]>;
  addSnippet: (snippet: { name: string; template: string }) => Promise<Snippet>;
  deleteSnippet: (id: string) => Promise<boolean>;
  applySnippet: (snippetId: string, text: string) => Promise<string>;

  // Accessibility
  openAccessibilitySettings: () => void;

  // Meeting-Recorder
  startMeeting: () => Promise<{ id: string } | null>;
  stopMeeting: () => Promise<{ id: string | null } | null>;
  getMeetingStatus: () => Promise<{ active: boolean; id: string | null; diarization: boolean; callActive: boolean }>;
  setOverlayExpanded: (expanded: boolean) => void;
  sendMicPcm: (buf: ArrayBuffer) => void;
  sendMicLevel: (lvl: number) => void;
  sendSystemPcm: (buf: ArrayBuffer) => void;
  setMeetingDiarization: (enabled: boolean) => Promise<boolean>;
  listMeetings: () => Promise<MeetingIndexEntry[]>;
  getMeeting: (id: string) => Promise<MeetingFull | null>;
  deleteMeeting: (id: string) => Promise<boolean>;
  retranscribeMeeting: (id: string) => Promise<boolean>;
  regenerateSummary: (id: string) => Promise<MeetingSummary | { error: string } | null>;
  updateSpeakerName: (id: string, channel: 'mic' | 'system', name: string) => Promise<boolean>;
  renameSpeaker: (id: string, fromSpeaker: string, toName: string) => Promise<boolean>;
  toggleMeetingTodo: (id: string, idx: number) => Promise<boolean>;
  onMeetingStatus: (cb: (s: { color: 'green' | 'yellow' | 'red'; reason: string; durationMs: number; micLevel: number; systemLevel: number }) => void) => void;
  onMeetingTranscriptChunk: (cb: (segs: MeetingSegment[]) => void) => void;
  onMeetingStarted: (cb: (d: { id: string; diarization?: boolean; callActive?: boolean }) => void) => void;
  onMeetingStopped: (cb: (d: { id: string }) => void) => void;
  onMeetingCallState: (cb: (d: { active: boolean }) => void) => void;

  // Platform
  getPlatform: () => Promise<Platform>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
