const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  Tray,
  clipboard,
  nativeImage,
  shell,
  dialog,
  screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, exec } = require('node:child_process');

// ============================================================================
// ISOLIERTER TEST-MODUS
// Wenn PAPLY_USER_DATA gesetzt ist, nutzt die App einen separaten Daten-Ordner.
// So lassen sich neue Versionen lokal testen, ohne die Produktiv-Konfiguration
// (Groq-Key, History, Settings) der installierten App anzufassen. Muss VOR
// app.whenReady und vor der ersten electron-store-Nutzung gesetzt werden.
// Aktivierung: `npm run dev:test`.
// ============================================================================
if (process.env.PAPLY_USER_DATA) {
  try {
    app.setPath('userData', process.env.PAPLY_USER_DATA);
    console.log('[paply] Isolierter Test-Modus — userData:', process.env.PAPLY_USER_DATA);
  } catch (e) {
    console.error('[paply] Konnte userData-Pfad nicht setzen:', e.message);
  }
}

// ============================================================================
// PLATFORM HELPERS
// ============================================================================
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// ============================================================================
// GLOBE KEY MANAGER (macOS Fn/Globe key support)
// ============================================================================
const GlobeKeyManager = require('./globe-key-manager');
const globeKeyManager = new GlobeKeyManager();

// ============================================================================
// AUDIO TEE MANAGER + MEETING CONTROLLER (System-Audio-Aufnahme für Meetings)
// ============================================================================
const AudioTeeManager = require('./audio-tee-manager');
const audioTeeManager = new AudioTeeManager();
const { createMeetingController } = require('./meeting/meeting-controller');
const { createMeetingStore } = require('./meeting/meeting-store');
let meetingController = null;   // lazy in app.whenReady (braucht getStore + Pfade)
let meetingStore = null;        // dito; von IPC-Handlern referenziert
let meetingOverlayWindow = null;

// ============================================================================
// PUSH-TO-TALK STATE
// ============================================================================
let pttKeyDownTime = 0;      // Timestamp when hotkey was pressed down
let pttIsHolding = false;     // True while key is held in PTT mode
let pttHoldTimer = null;      // Timer to detect hold vs. tap

function getDefaultShortcut() {
  return isMac ? 'Alt+Command+K' : 'Ctrl+Alt+K';
}

function getQuitAccelerator() {
  return isMac ? 'Command+Q' : 'Ctrl+Q';
}

// ============================================================================
// LAZY LOADED MODULES
// ============================================================================
let store = null;
let autoLauncher = null;

function getStore() {
  if (!store) {
    const Store = require('electron-store');
    store = new Store({
      defaults: {
        groqApiKey: '',
        enablePolish: false,
        shortcut: getDefaultShortcut(),
        autoStart: false,
        language: 'de',
        autopaste: true,
        beepEnabled: true,
        copyToClipboard: false,
        hideDock: false,
        history: [],
        // Profile/Rollen (Standard-Agenten)
        activeProfile: 'coding',
        profiles: {
          coding: { name: 'Coding', language: 'de', polishFlavor: 'code', autopaste: true },
          meeting: { name: 'Meeting', language: 'de', polishFlavor: 'meeting', autopaste: false },
          dictation: { name: 'Diktat', language: 'de', polishFlavor: 'plain', autopaste: true },
        },
        // Custom Agents (vom Nutzer erstellt)
        customAgents: [],
        // Stats (öffentlich)
        stats: {
          wordsTotal: 0,
          wordsToday: 0,
          wordsWeek: 0,
          minutesTotal: 0,
          minutesToday: 0,
          minutesWeek: 0,
          sessionsCount: 0,
          sessionsToday: 0,
          sessionsWeek: 0,
          errorsCount: 0,
          lastResetDay: null,
          lastResetWeek: null,
        },
        // Owner Analytics (hidden)
        ownerMode: false,
        ownerStats: {
          tokensGroq: 0,
          tokensGroqPolish: 0,
          estimatedCost: 0,
        },
        // PTT hold threshold in ms (press longer than this = hold-to-talk mode)
        pttThreshold: 350,
        // Snippets
        snippets: [
          { id: 'ticket', name: 'Ticket-Entwurf', template: '## Ticket\n\n{{text}}\n\n### Action Items\n- [ ] ' },
          { id: 'meeting', name: 'Meeting-Notizen', template: '# Meeting Notes\n\n{{text}}\n\n## Next Steps\n' },
          { id: 'code-comment', name: 'Code-Kommentar', template: '// {{text}}' },
        ],
        // Favorites
        favorites: [],
        // Meeting-Recorder
        meetings: [],
        meetingHotkey: 'Command+Shift+X',
        meetingSummaryModel: 'llama-3.3-70b-versatile',
        // Mehr-Sprecher-Trennung im System-Kanal (Deepgram, Phase 2)
        deepgramApiKey: '',
        diarizationEnabled: false,
      },
    });
  }
  return store;
}

function getAutoLauncher() {
  if (!autoLauncher) {
    const AutoLaunch = require('auto-launch');
    autoLauncher = new AutoLaunch({
      name: 'paply',
      path: app.getPath('exe'),
    });
  }
  return autoLauncher;
}

async function updateAutoLaunch() {
  // In Dev/unsinged runs the login item often does not exist; skip there
  if (!app.isPackaged) return;

  try {
    const enabled = getStore().get('autoStart');
    const launcher = getAutoLauncher();
    if (enabled) {
      await launcher.enable();
    } else {
      await launcher.disable();
    }
  } catch (e) {
    console.error('AutoLaunch error:', e);
  }
}

// ============================================================================
// STATS MANAGEMENT
// ============================================================================
function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

function detectRole(text) {
  if (!text) return 'dictation';
  const lower = text.toLowerCase();

  // Coding keywords
  const codeKeywords = ['function', 'const', 'let', 'var', 'import', 'export', 'class', 'return',
    'usestate', 'useeffect', 'component', 'react', 'typescript', 'javascript', 'python',
    'api', 'endpoint', 'database', 'query', 'async', 'await', 'promise', 'callback',
    'git', 'commit', 'push', 'pull', 'merge', 'branch', 'npm', 'yarn', 'package'];

  // Meeting keywords
  const meetingKeywords = ['meeting', 'action item', 'action items', 'agenda', 'discussion',
    'teilnehmer', 'besprechung', 'termin', 'next steps', 'follow up', 'deadline',
    'projekt', 'project', 'team', 'status update', 'blocker'];

  const codeScore = codeKeywords.filter(kw => lower.includes(kw)).length;
  const meetingScore = meetingKeywords.filter(kw => lower.includes(kw)).length;

  if (codeScore >= 2) return 'coding';
  if (meetingScore >= 2) return 'meeting';
  return 'dictation';
}

function calculateDelta(transcript, polished) {
  if (!transcript || !polished) return null;

  const transcriptWords = countWords(transcript);
  const polishedWords = countWords(polished);

  // Simple filler word detection (German + English)
  const fillerWords = ['ähm', 'äh', 'also', 'sozusagen', 'quasi', 'halt', 'ne', 'oder so',
    'um', 'uh', 'like', 'you know', 'basically', 'actually', 'literally'];

  const transcriptLower = transcript.toLowerCase();
  const polishedLower = polished.toLowerCase();

  const fillersRemoved = fillerWords.filter(fw =>
    transcriptLower.includes(fw) && !polishedLower.includes(fw)
  );

  return {
    wordsBefore: transcriptWords,
    wordsAfter: polishedWords,
    wordsDiff: transcriptWords - polishedWords,
    fillersRemoved: fillersRemoved.length,
    fillersList: fillersRemoved.slice(0, 5),
  };
}

function resetStatsIfNeeded() {
  const s = getStore();
  const stats = s.get('stats') || {};
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const weekStart = getWeekStart(now).toISOString().split('T')[0];

  if (stats.lastResetDay !== today) {
    stats.wordsToday = 0;
    stats.minutesToday = 0;
    stats.sessionsToday = 0;
    stats.lastResetDay = today;
  }

  if (stats.lastResetWeek !== weekStart) {
    stats.wordsWeek = 0;
    stats.minutesWeek = 0;
    stats.sessionsWeek = 0;
    stats.lastResetWeek = weekStart;
  }

  s.set('stats', stats);
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

function updateStats(wordCount, durationMinutes = 0, isError = false) {
  const s = getStore();
  resetStatsIfNeeded();

  const stats = s.get('stats') || {};

  if (isError) {
    stats.errorsCount = (stats.errorsCount || 0) + 1;
  } else {
    stats.wordsTotal = (stats.wordsTotal || 0) + wordCount;
    stats.wordsToday = (stats.wordsToday || 0) + wordCount;
    stats.wordsWeek = (stats.wordsWeek || 0) + wordCount;
    stats.minutesTotal = (stats.minutesTotal || 0) + durationMinutes;
    stats.minutesToday = (stats.minutesToday || 0) + durationMinutes;
    stats.minutesWeek = (stats.minutesWeek || 0) + durationMinutes;
    stats.sessionsCount = (stats.sessionsCount || 0) + 1;
    stats.sessionsToday = (stats.sessionsToday || 0) + 1;
    stats.sessionsWeek = (stats.sessionsWeek || 0) + 1;
  }

  s.set('stats', stats);

  // Update owner stats (token estimation)
  if (s.get('ownerMode')) {
    const ownerStats = s.get('ownerStats') || {};
    // Rough estimation: ~1 token per 4 characters for text, ~100 tokens per minute for audio
    ownerStats.tokensGroq = (ownerStats.tokensGroq || 0) + Math.round(durationMinutes * 100);
    ownerStats.tokensGroqPolish = (ownerStats.tokensGroqPolish || 0) + Math.round(wordCount * 1.5);
    // Cost estimation: Groq Whisper ~$0.0001/min, Groq Llama ~$0.00079/1k tokens (output)
    ownerStats.estimatedCost = (ownerStats.estimatedCost || 0) +
      (durationMinutes * 0.0001) + (wordCount * 1.5 * 0.00079 / 1000);
    s.set('ownerStats', ownerStats);
  }

  // Notify main window of stats update
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stats:updated', stats);
  }
}

// ============================================================================
// HISTORY MANAGEMENT
// ============================================================================
const MAX_HISTORY_DAYS = 90;

function cleanupOldHistory() {
  const s = getStore();
  const history = s.get('history') || [];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_HISTORY_DAYS);

  const filtered = history.filter(item => {
    const itemDate = new Date(item.timestamp);
    return itemDate >= cutoffDate;
  });

  if (filtered.length !== history.length) {
    s.set('history', filtered);
    console.log(`Cleaned up ${history.length - filtered.length} old history entries`);
  }

  return filtered;
}

function addToHistory(entry) {
  const s = getStore();
  const history = s.get('history') || [];

  const wordCount = countWords(entry.polished || entry.transcript);
  const role = detectRole(entry.transcript);
  const delta = entry.polished ? calculateDelta(entry.transcript, entry.polished) : null;

  const newEntry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    transcript: entry.transcript,
    polished: entry.polished || null,
    language: entry.language,
    role: role,
    wordCount: wordCount,
    delta: delta,
    polishUsed: !!entry.polished,
    favorite: false,
  };

  history.unshift(newEntry);

  // Cleanup entries older than 90 days
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_HISTORY_DAYS);
  const filtered = history.filter(item => {
    const itemDate = new Date(item.timestamp);
    return itemDate >= cutoffDate;
  });

  s.set('history', filtered);

  // Update stats
  updateStats(wordCount, entry.durationMinutes || 0);

  updateTrayMenu();

  // Notify main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:updated', history);
  }

  return newEntry;
}

function getHistory() {
  // Cleanup old entries when retrieving history
  cleanupOldHistory();
  return getStore().get('history') || [];
}

function clearHistory() {
  getStore().set('history', []);
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:updated', []);
  }
}

function toggleFavorite(id) {
  const s = getStore();
  const history = s.get('history') || [];
  const item = history.find(h => h.id === id);
  if (item) {
    item.favorite = !item.favorite;
    s.set('history', history);
    return item.favorite;
  }
  return false;
}

function deleteHistoryItem(id) {
  const s = getStore();
  const history = s.get('history') || [];
  const index = history.findIndex(h => h.id === id);
  if (index !== -1) {
    history.splice(index, 1);
    s.set('history', history);
    updateTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('history:updated', history);
    }
    return true;
  }
  return false;
}

// ============================================================================
// API CALLS
// ============================================================================
const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GITHUB_REPO = 'allanhamduws-alt/paply';
const CURRENT_VERSION = require('./package.json').version;

// Verwirf reine Satzzeichen/Stille-Ergebnisse (z.B. "." oder "..." von Whisper bei Stille)
function isTrivialTranscript(input) {
  if (!input) return true;
  const trimmed = input.trim();
  if (!trimmed) return true;
  // Entferne alle Nicht-Buchstaben/Nicht-Ziffern
  const lettersOrDigits = trimmed.replace(/[^\p{L}\p{N}]+/gu, '');
  if (!lettersOrDigits) return true;
  // Sehr kurze Transkripte (1 Zeichen mit max 3 Gesamtlänge) sind trivial
  if (lettersOrDigits.length < 2 && trimmed.length <= 3) return true;
  return false;
}

async function transcribeAudio(audioBuffer, language = 'de', retries = 3) {
  const apiKey = getStore().get('groqApiKey');
  if (!apiKey) {
    throw new Error('Groq API Key nicht konfiguriert');
  }

  for (let i = 0; i <= retries; i++) {
    try {
      const formData = new FormData();
      const audioBlob = new Blob([audioBuffer], { type: 'audio/webm' });
      formData.append('file', audioBlob, 'audio.webm');
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('language', language);
      formData.append('response_format', 'json');

      console.log(`Starting Groq transcription (attempt ${i + 1}/${retries + 1}, size: ${audioBuffer.length} bytes)...`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text();
        console.error('Groq error:', res.status, errText);

        // If it's a rate limit or server error, maybe retry
        if (res.status >= 500 || res.status === 429) {
          if (i < retries) {
            console.log(`Retrying due to status ${res.status}...`);
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            continue;
          }
        }

        let errorMsg = `Transkription fehlgeschlagen (${res.status})`;
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error?.message) errorMsg = errJson.error.message;
        } catch (e) {
          if (errText.length < 100) errorMsg += `: ${errText}`;
        }
        throw new Error(errorMsg);
      }

      const json = await res.json();
      const rawText = json?.text?.trim() ?? '';

      if (isTrivialTranscript(rawText)) {
        console.log('Transcript discarded (trivial):', rawText);
        return '';
      }

      return rawText;
    } catch (error) {
      // Besseres Logging mit Ursache
      console.error(`Transcription attempt ${i + 1} failed:`, error.message);
      if (error.cause) {
        console.error('Fetch detail error:', error);
      }

      // Prüfe sowohl message als auch cause für Netzwerkfehler
      const causeCode = error.cause?.code || '';
      const causeMessage = error.cause?.message || '';
      const isNetworkError =
        error.message.includes('ECONNRESET') ||
        error.message.includes('fetch failed') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ECONNREFUSED') ||
        causeCode === 'ECONNRESET' ||
        causeCode === 'ETIMEDOUT' ||
        causeCode === 'ECONNREFUSED' ||
        causeCode === 'ENOTFOUND' ||
        causeMessage.includes('ECONNRESET') ||
        error.name === 'AbortError';

      if (isNetworkError && i < retries) {
        // Exponentielles Backoff: 1s, 2s, 4s
        const delay = Math.min(1000 * Math.pow(2, i), 8000);
        console.log(`Network error detected (${causeCode || error.message}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
}

// ============================================================================
// AUTO UPDATER (electron-updater)
// ============================================================================
let autoUpdater = null;
let updateCheckInProgress = false;
let downloadInProgress = false;

function getAutoUpdater() {
  if (!autoUpdater) {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    // Für unsignierte Windows-Builds: Signatur-Prüfung deaktivieren
    if (isWin) {
      autoUpdater.forceDevUpdateConfig = true;
    }

    // Logger für bessere Debugging-Infos
    autoUpdater.logger = require('electron').app.isPackaged
      ? null
      : console;
  }
  return autoUpdater;
}

function setupAutoUpdater() {
  const updater = getAutoUpdater();
  updater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  updater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    updateCheckInProgress = false;

    dialog.showMessageBox({
      type: 'info',
      title: 'Update verfügbar!',
      message: `Neue Version ${info.version} verfügbar`,
      detail: `Du hast Version ${CURRENT_VERSION}.\n\n${info.releaseNotes || 'Neue Verbesserungen und Bugfixes.'}\n\nMöchtest du das Update jetzt herunterladen und installieren?`,
      buttons: ['Herunterladen', 'Später'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        downloadInProgress = true;
        updater.downloadUpdate();
      }
    });
  });

  updater.on('update-not-available', (info) => {
    console.log('No update available, current version:', info.version);
    updateCheckInProgress = false;

    if (!updateCheckInProgress) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Kein Update verfügbar',
        message: 'Du hast die neueste Version!',
        detail: `Aktuelle Version: ${CURRENT_VERSION}`,
        buttons: ['OK'],
      });
    }
  });

  updater.on('error', (error) => {
    console.error('Auto-updater error:', error);
    updateCheckInProgress = false;
    downloadInProgress = false;

    // Fallback: Open GitHub releases page
    dialog.showMessageBox({
      type: 'error',
      title: 'Update-Fehler',
      message: 'Auto-Update fehlgeschlagen',
      detail: `${error.message}\n\nMöchtest du die Releases-Seite öffnen?`,
      buttons: ['GitHub öffnen', 'Abbrechen'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        shell.openExternal(`https://github.com/${GITHUB_REPO}/releases/latest`);
      }
    });
  });

  updater.on('download-progress', (progress) => {
    console.log(`Download progress: ${Math.round(progress.percent)}%`);
  });

  updater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    downloadInProgress = false;

    dialog.showMessageBox({
      type: 'info',
      title: 'Update bereit',
      message: 'Update heruntergeladen!',
      detail: `Version ${info.version} wurde heruntergeladen.\n\nDie App wird jetzt neu gestartet, um das Update zu installieren.`,
      buttons: ['Jetzt neu starten', 'Später'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        updater.quitAndInstall(false, true);
      }
    });
  });
}

async function checkForUpdates(silent = false) {
  if (updateCheckInProgress || downloadInProgress) {
    console.log('Update check already in progress');
    return;
  }

  updateCheckInProgress = true;
  const updater = getAutoUpdater();

  try {
    // Remove the dialog for silent checks
    if (silent) {
      updater.once('update-not-available', () => {
        updateCheckInProgress = false;
      });
    }

    await updater.checkForUpdates();
  } catch (error) {
    console.error('Update check failed:', error);
    updateCheckInProgress = false;

    if (!silent) {
      // Fallback to manual GitHub check
      await checkForUpdatesManual();
    }
  }
}

// Fallback manual update check (for unsigned builds)
async function checkForUpdatesManual() {
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!response.ok) {
      dialog.showMessageBox({
        type: 'error',
        title: 'Update-Prüfung fehlgeschlagen',
        message: 'Konnte nicht nach Updates suchen.',
        detail: `Status: ${response.status}`,
        buttons: ['OK'],
      });
      return null;
    }

    const release = await response.json();
    const latestVersion = release.tag_name.replace(/^v/, '');

    console.log(`Current version: ${CURRENT_VERSION}, Latest: ${latestVersion}`);

    if (compareVersions(latestVersion, CURRENT_VERSION) > 0) {
      const assetName = isMac ? '.dmg' : 'Setup';
      const downloadAsset = release.assets.find(a =>
        a.name.toLowerCase().includes(assetName.toLowerCase())
      );

      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Update verfügbar!',
        message: `Neue Version ${latestVersion} verfügbar`,
        detail: `Du hast Version ${CURRENT_VERSION}.\n\n${release.body || 'Neue Verbesserungen und Bugfixes.'}\n\nMöchtest du das Update jetzt herunterladen?\n\nHinweis: Nach dem Download bitte manuell installieren.`,
        buttons: ['Herunterladen', 'Später'],
        defaultId: 0,
      });

      if (result.response === 0) {
        const downloadUrl = downloadAsset?.browser_download_url || release.html_url;
        shell.openExternal(downloadUrl);
      }
      return { hasUpdate: true, version: latestVersion };
    } else {
      dialog.showMessageBox({
        type: 'info',
        title: 'Kein Update verfügbar',
        message: 'Du hast die neueste Version!',
        detail: `Aktuelle Version: ${CURRENT_VERSION}`,
        buttons: ['OK'],
      });
      return { hasUpdate: false, version: CURRENT_VERSION };
    }
  } catch (error) {
    console.error('Manual update check failed:', error);
    dialog.showMessageBox({
      type: 'error',
      title: 'Update-Prüfung fehlgeschlagen',
      message: 'Konnte nicht nach Updates suchen.',
      detail: error.message,
      buttons: ['OK'],
    });
    return null;
  }
}

function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

function getPolishPrompt(text, language, flavor, customSettings = null) {
  // Handle custom agent settings
  if (flavor === 'custom' && customSettings) {
    return getCustomAgentPrompt(text, language, customSettings);
  }

  const flavorPrompts = {
    code: `Du polierst Sprachtranskriptionen eines Softwareentwicklers. Der Text wurde per Whisper transkribiert — Tech-Begriffe sind oft falsch geschrieben.

DEINE AUFGABE:
1. Entferne Füllwörter (ähm, äh, also, sozusagen, quasi, halt, ne, oder so), Wiederholungen, Versprecher
2. Korrigiere Grammatik und Satzbau — aber behalte den INHALT und die AUSSAGE exakt bei
3. Erkenne und korrigiere ALLE falsch transkribierten Tech-Begriffe aus der Softwareentwicklung

TECH-BEGRIFFE KORREKTUR (Whisper schreibt diese oft falsch):
- Frameworks/Libraries: React, Next.js, Vue, Angular, Svelte, Express, Django, Flask, Laravel, Rails, Spring Boot, FastAPI, Tailwind CSS, shadcn/ui, Prisma, Drizzle, tRPC, Zustand, Redux, Vite, Webpack, Turbopack
- Sprachen: TypeScript, JavaScript, Python, Rust, Go, Swift, Kotlin, C#, C++, PHP, Ruby, Dart, SQL
- Tools/Plattformen: GitHub, GitLab, Docker, Kubernetes, Vercel, Netlify, AWS, Supabase, Firebase, MongoDB, PostgreSQL, Redis, Elasticsearch, Terraform, Jenkins, CircleCI
- React-Begriffe: useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer, JSX, TSX, Props, State, Hooks, Component, Provider, Context
- Allgemein: API, REST, GraphQL, WebSocket, OAuth, JWT, CORS, CRUD, CLI, IDE, npm, yarn, pnpm, Bun, Node.js, Deno, ESLint, Prettier, CI/CD, DevOps, Frontend, Backend, Fullstack, Middleware, Deployment, Repository, Branch, Merge, Pull Request, Commit, Endpoint, Payload, Middleware, Groq, LLM, GPT, Claude, Anthropic, OpenAI
- Wenn der Sprecher ein Wort ausspricht und danach buchstabiert oder korrigiert, verwende die korrigierte Version
- "Grog" oder "GROG" → Groq, "Lama" oder "Lava" → Llama, "shad cn" → shadcn, "use state" → useState, "type script" → TypeScript, "next js" → Next.js, "node js" → Node.js, "Hiku" oder "HICUM" → Haiku

DATEINAMEN:
- Setze @ vor Dateinamen: "datei punkt tsx" → @datei.tsx
- CamelCase beibehalten: @RecordingWidget.tsx
- GROSSBUCHSTABEN beibehalten: @ROADMAP.md

WICHTIG:
- Gib NUR den korrigierten Text zurück, KEINE Kommentare oder Erklärungen
- Ändere NICHT den Sinn oder füge eigene Inhalte hinzu
- Behalte den natürlichen Sprechstil bei, mache nur technische Korrekturen

TEXT:
${text}`,

    meeting: `Du polierst Sprachtranskriptionen von Meetings und Besprechungen. Erstelle daraus ein sauberes Protokoll.

DEINE AUFGABE:
1. Entferne Füllwörter (ähm, äh, also, sozusagen, quasi, halt, ne), Wiederholungen, Versprecher
2. Strukturiere den Inhalt als übersichtliche Stichpunkte
3. Erkenne und markiere Aufgaben, Entscheidungen und nächste Schritte

FORMATIERUNG:
- Personennamen korrekt: Max Müller (nicht max müller)
- Datum: "am fünfzehnten dezember" → am 15. Dezember
- Uhrzeit: "um vierzehn uhr" → um 14:00 Uhr
- E-Mail: "max at firma punkt de" → max@firma.de
- URLs: "www punkt beispiel punkt com" → www.beispiel.com
- Action Items mit → oder - [ ] markieren
- Mehrere Themen als separate Stichpunkte strukturieren

WICHTIG:
- Gib NUR das formatierte Protokoll zurück, KEINE Kommentare
- Behalte alle Fakten, Namen, Zahlen und Entscheidungen exakt bei
- Fasse NICHT zusammen — strukturiere nur

TEXT:
${text}`,

    plain: `Du polierst Sprachtranskriptionen. Säubere den Text grammatikalisch, ohne den Inhalt oder Stil zu verändern.

DEINE AUFGABE:
1. Entferne Füllwörter (ähm, äh, also, sozusagen, quasi, halt, ne, oder so), Wiederholungen, Versprecher
2. Korrigiere Grammatik, Satzbau, Interpunktion
3. Deutsche Rechtschreibung: Substantive groß, korrekter Satzanfang

GESPROCHENE SATZZEICHEN UMWANDELN:
- "Punkt" → .  "Komma" → ,  "Fragezeichen" → ?  "Ausrufezeichen" → !
- "neuer Absatz" oder "Absatz" → Zeilenumbruch

WICHTIG:
- Gib NUR den korrigierten Text zurück, KEINE Kommentare
- Minimale Eingriffe — behalte den natürlichen Sprachfluss bei
- Ändere NICHT den Inhalt, nur die Form

TEXT:
${text}`,
  };

  return flavorPrompts[flavor] || flavorPrompts.code;
}

// Generate prompt for custom agents with their specific settings
function getCustomAgentPrompt(text, language, settings) {
  // Special handling for Prompt Generator mode
  if (settings.isPromptGenerator) {
    return getPromptGeneratorPrompt(text, language, settings);
  }

  const toneDescriptions = {
    technical: 'technisch und präzise',
    formal: 'formell und professionell',
    casual: 'locker und umgangssprachlich',
    creative: 'kreativ und ausdrucksstark'
  };

  const formatDescriptions = {
    prose: 'als Fließtext',
    bullets: 'als Stichpunkte',
    markdown: 'mit Markdown-Formatierung',
    code: 'als Code-Kommentare oder technische Dokumentation'
  };

  const lengthDescriptions = {
    short: 'kurz und knapp',
    medium: 'ausgewogen',
    long: 'ausführlich und detailliert'
  };

  const tone = toneDescriptions[settings.tone] || 'neutral';
  const format = formatDescriptions[settings.format] || 'als Fließtext';
  const length = lengthDescriptions[settings.length] || 'ausgewogen';
  const creativity = settings.creativity || 50;
  const outputLang = settings.outputLang || 'same';
  const domain = settings.domain || 'general';
  const fillerWords = settings.fillerWords !== false; // Default: remove filler words

  let domainHint = '';
  if (domain && domain !== 'general') {
    const domainHints = {
      tech: 'Beachte Tech-Begriffe (APIs, Frameworks, Programmiersprachen)',
      business: 'Beachte Business-Terminologie und professionelle Ausdrucksweise',
      creative: 'Beachte kreative Freiheiten und expressive Sprache',
      academic: 'Beachte akademische Terminologie und wissenschaftlichen Stil'
    };
    domainHint = domainHints[domain] || '';
  }

  let outputLangHint = '';
  if (outputLang === 'en') {
    outputLangHint = '\n\nWICHTIG: Übersetze den finalen Text ins Englische!';
  } else if (outputLang === 'de') {
    outputLangHint = '\n\nWICHTIG: Übersetze den finalen Text ins Deutsche!';
  }

  const creativityHint = creativity > 70
    ? 'Sei kreativ: Verbessere Formulierungen, füge passende Ausdrücke hinzu.'
    : creativity < 30
      ? 'Sei minimal: Nur offensichtliche Fehler korrigieren, Originaltext maximal beibehalten.'
      : 'Sei ausgewogen: Korrigiere Fehler, behalte aber den Originalstil bei.';

  return `Du bist ein Transkriptions-Polierer für "${settings.name || 'Custom Agent'}".

EINGABESPRACHE: ${language}
TON: ${tone}
FORMAT: ${format}
LÄNGE: ${length}
KREATIVITÄT: ${creativity}% - ${creativityHint}
${domainHint}

REGELN:
${fillerWords ? '1. ENTFERNE: Füllwörter (ähm, äh, also, sozusagen, quasi, halt, ne, oder so), Wiederholungen, Versprecher' : '1. BEHALTE: Natürliche Sprachfluss, auch mit Füllwörtern'}
2. KORRIGIERE: Grammatik, Satzbau, Interpunktion
3. FORMATIERE: ${format}
4. ANPASSEN: Stil an "${tone}" anpassen

WICHTIG:
- Gib NUR den korrigierten Text zurück
- KEINE Kommentare, KEINE Erklärungen
- KEINE Interpretation was der User "meinen könnte"${outputLangHint}

TEXT:
${text}`;
}

// Special prompt for Prompt Generator mode (for Midjourney, DALL-E, etc.)
function getPromptGeneratorPrompt(text, language, settings) {
  const creativity = settings.creativity || 80;
  const outputLang = settings.outputLang || 'en';

  const creativityLevel = creativity > 70
    ? 'sehr detailliert und kreativ ausschmücken'
    : creativity > 40
      ? 'moderat erweitern und verbessern'
      : 'eng am Original bleiben, nur formattieren';

  return `Du bist ein Prompt-Generator für KI-Bildgenerierung (Midjourney, DALL-E, Stable Diffusion).

Deine Aufgabe: Wandle die gesprochene Beschreibung in einen professionellen, detaillierten Prompt um.

EINGABESPRACHE: ${language}
AUSGABESPRACHE: ${outputLang === 'en' ? 'Englisch' : outputLang === 'de' ? 'Deutsch' : 'wie Eingabe'}
KREATIVITÄT: ${creativity}% - ${creativityLevel}

PROMPT-STRUKTUR (folge dieser Reihenfolge):
1. Hauptmotiv/Subjekt - Was ist das zentrale Element?
2. Stil/Medium - Fotorealistisch, Illustration, 3D, Ölgemälde, etc.
3. Atmosphäre/Stimmung - Licht, Farben, Emotionen
4. Details - Texturen, Materialien, Umgebung
5. Technische Parameter - Kamerawinkel, Brennweite, Rendering-Qualität

WICHTIGE BEGRIFFE (nutze wenn passend):
- Qualität: masterpiece, highly detailed, 8k, ultra HD, professional
- Licht: golden hour, soft lighting, dramatic shadows, volumetric lighting
- Stil: cinematic, ethereal, minimalist, surreal, hyperrealistic
- Kamera: wide angle, close-up, bird's eye view, shallow depth of field

BEISPIEL-INPUT: "Ich möchte einen Astronauten der auf einem fremden Planeten steht und in die Ferne schaut"
BEISPIEL-OUTPUT: "Lone astronaut standing on alien planet surface, gazing at distant nebula, sci-fi concept art, volumetric lighting, cosmic atmosphere, detailed space suit with reflective visor, purple and orange alien landscape, dramatic composition, cinematic wide shot, 8k, highly detailed, masterpiece"

REGELN:
1. Entferne ALLE Füllwörter und Unsicherheiten
2. Extrahiere die Kernidee und erweitere sie professionell
3. Nutze passende technische Begriffe
4. Halte den Prompt zwischen 50-150 Wörtern
5. ${outputLang === 'en' ? 'Ausgabe MUSS auf Englisch sein' : outputLang === 'de' ? 'Ausgabe auf Deutsch' : 'Behalte die Sprache bei'}

WICHTIG:
- Gib NUR den fertigen Prompt zurück
- KEINE Erklärungen, KEINE Kommentare
- KEIN "Here is your prompt:" oder ähnliches

GESPROCHENE BESCHREIBUNG:
${text}`;
}

async function polishText(text, language = 'de', flavor = 'code', customSettings = null) {
  const apiKey = getStore().get('groqApiKey');
  if (!apiKey) return null;

  const prompt = getPolishPrompt(text, language, flavor, customSettings);

  const payload = {
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: 'Du bist ein Transkriptions-Polierer. Gib NUR den korrigierten Text zurück. Keine Kommentare, keine Erklärungen.' },
      { role: 'user', content: prompt },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error('Groq polish error:', res.status);
      return null;
    }

    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    clearTimeout(timeout);
    console.error('Polish error:', error);
    return null;
  }
}

// ============================================================================
// WINDOWS
// ============================================================================
let tray = null;
let mainWindow = null;
let settingsWindow = null;
let historyWindow = null;
let recordingWindow = null;

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: 'paply',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // On macOS, clicking the dock icon should show the window
  app.on('activate', () => {
    if (mainWindow === null) {
      createMainWindow();
    } else {
      mainWindow.show();
    }
  });

  return mainWindow;
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: true,
    minimizable: false,
    maximizable: false,
    minWidth: 420,
    minHeight: 500,
    title: 'paply Einstellungen',
    backgroundColor: '#F9FAFB',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createHistoryWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus();
    return;
  }

  historyWindow = new BrowserWindow({
    width: 600,
    height: 500,
    resizable: true,
    minimizable: true,
    title: 'paply History',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  historyWindow.loadFile(path.join(__dirname, 'renderer', 'history.html'));
  historyWindow.on('closed', () => { historyWindow = null; });
}

function createRecordingWindow() {
  if (recordingWindow && !recordingWindow.isDestroyed()) {
    return recordingWindow;
  }

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  // Compact widget size
  const widgetWidth = 140;
  const widgetHeight = 52;

  const windowOptions = {
    width: widgetWidth,
    height: widgetHeight,
    show: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (isMac) {
    windowOptions.frame = false;
    windowOptions.transparent = true;
    windowOptions.focusable = false;
  } else {
    windowOptions.frame = false;
    windowOptions.transparent = false;
    windowOptions.backgroundColor = '#1e1e1e';
    windowOptions.focusable = false;
  }

  recordingWindow = new BrowserWindow(windowOptions);

  recordingWindow.loadFile(path.join(__dirname, 'renderer', 'recording.html'));
  recordingWindow.on('closed', () => { recordingWindow = null; });

  // Position: bottom center, slightly above the Dock
  const x = Math.round((width - widgetWidth) / 2);
  const y = height - widgetHeight - 80; // 80px above bottom edge (above Dock)
  recordingWindow.setPosition(x, y);

  return recordingWindow;
}

function createMeetingOverlayWindow() {
  if (meetingOverlayWindow && !meetingOverlayWindow.isDestroyed()) {
    meetingOverlayWindow.showInactive();
    return meetingOverlayWindow;
  }

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  const widgetWidth = 200;
  const widgetHeight = 64;

  const windowOptions = {
    width: widgetWidth,
    height: widgetHeight,
    show: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (isMac) {
    windowOptions.frame = false;
    windowOptions.transparent = true;
    windowOptions.focusable = false;
  } else {
    windowOptions.frame = false;
    windowOptions.transparent = false;
    windowOptions.backgroundColor = '#1e1e1e';
    windowOptions.focusable = false;
  }

  meetingOverlayWindow = new BrowserWindow(windowOptions);
  meetingOverlayWindow.loadFile(path.join(__dirname, 'renderer', 'meeting-overlay.html'));
  meetingOverlayWindow.on('closed', () => { meetingOverlayWindow = null; });

  // Position: oben rechts
  meetingOverlayWindow.setPosition(width - widgetWidth - 24, 24);
  meetingOverlayWindow.showInactive();

  return meetingOverlayWindow;
}

function showAboutDialog() {
  const shortcut = getStore().get('shortcut');
  const quitKey = isMac ? '⌘Q' : 'Ctrl+Q';
  dialog.showMessageBox({
    type: 'info',
    title: 'Über paply',
    message: 'paply',
    detail: `Version ${CURRENT_VERSION}

Sprachtranskription mit Groq Whisper Large V3 Turbo
Optionales Polishing mit Groq Llama 3.3

Shortcuts:
• ${shortcut === 'GLOBE' ? 'Fn/Globe-Taste' : shortcut} - Aufnahme starten/stoppen
• ${quitKey} - Beenden

© 2024 paply`,
    buttons: ['OK'],
  });
}

// ============================================================================
// TRAY MENU
// ============================================================================
function updateTrayMenu() {
  if (!tray) return;

  const s = getStore();
  const history = getHistory();
  const shortcut = s.get('shortcut');
  const enablePolish = s.get('enablePolish');
  const groqKey = s.get('groqApiKey');

  const historySubmenu = history.length > 0
    ? history.slice(0, 10).map((item) => {
      const preview = (item.polished || item.transcript || '').substring(0, 40);
      const date = new Date(item.timestamp).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      return {
        label: `${date}: ${preview}${preview.length >= 40 ? '...' : ''}`,
        click: () => { clipboard.writeText(item.polished || item.transcript); },
      };
    })
    : [{ label: 'Keine Einträge', enabled: false }];

  if (history.length > 0) {
    historySubmenu.push({ type: 'separator' });
    historySubmenu.push({ label: 'Alle anzeigen...', click: createHistoryWindow });
    historySubmenu.push({ label: 'History löschen', click: clearHistory });
  }

  const statusLabel = groqKey
    ? (enablePolish && groqKey ? '✓ Bereit (mit Polish)' : '✓ Bereit')
    : '⚠ API Key fehlt';

  const template = [
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Dashboard öffnen', click: showMainWindow },
    { label: 'Transcribe', accelerator: shortcut === 'GLOBE' ? undefined : shortcut, click: startTranscription },
    { type: 'separator' },
    { label: 'History', submenu: historySubmenu },
    { type: 'separator' },
    { label: 'Einstellungen...', click: createSettingsWindow },
    { label: 'Nach Updates suchen...', click: () => checkForUpdates(false) },
    { label: 'Über paply', click: showAboutDialog },
    { type: 'separator' },
    { label: 'Beenden', accelerator: getQuitAccelerator(), click: () => app.quit() },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function setupTray() {
  let icon;

  if (isMac) {
    // macOS: Use template image for proper menubar appearance
    const iconPath = path.join(__dirname, 'iconTemplate.png');
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
      icon.setTemplateImage(true);
    } else {
      icon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAbwAAAG8B8aLcQwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABYSURBVDiNY2CgMmBEF/j//z/DtWvX0IXh4vr6+v/////HKoauwMDAAN4cZAVwzYwQBmaGT58+MTAwMLxmYGBgYGJiYti7dy9cHq4ATQypBlkzVgNGNQADAGVDHxEz5ThqAAAAAElFTkSuQmCC',
      );
      icon.setTemplateImage(true);
    }
  } else {
    // Windows: Use regular colored icon
    const icoPath = path.join(__dirname, 'icon.ico');
    const pngPath = path.join(__dirname, 'icon.png');
    if (fs.existsSync(icoPath)) {
      icon = nativeImage.createFromPath(icoPath);
    } else if (fs.existsSync(pngPath)) {
      icon = nativeImage.createFromPath(pngPath);
    } else {
      icon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAbwAAAG8B8aLcQwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABYSURBVDiNY2CgMmBEF/j//z/DtWvX0IXh4vr6+v/////HKoauwMDAAN4cZAVwzYwQBmaGT58+MTAwMLxmYGBgYGJiYti7dy9cHq4ATQypBlkzVgNGNQADAGVDHxEz5ThqAAAAAElFTkSuQmCC',
      );
    }
  }

  tray = new Tray(icon);
  tray.setToolTip('paply');
  updateTrayMenu();

  // On Windows, both left and right click should show the context menu
  if (isWin) {
    tray.on('click', () => { tray.popUpContextMenu(); });
    tray.on('right-click', () => { tray.popUpContextMenu(); });
  } else {
    tray.on('click', () => { tray.popUpContextMenu(); });
  }
}

// ============================================================================
// RECORDING & TRANSCRIPTION
// ============================================================================
let isRecording = false;
let previousAppName = null;

function savePreviousApp() {
  return new Promise((resolve) => {
    if (isMac) {
      const proc = spawn('osascript', [
        '-e', 'tell application "System Events" to get name of first application process whose frontmost is true',
      ]);
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.on('close', () => { previousAppName = output.trim(); resolve(previousAppName); });
      proc.on('error', () => resolve(null));
    } else {
      // On Windows, we don't track previous app - just resolve
      resolve(null);
    }
  });
}

function autopasteText(text) {
  clipboard.writeText(text);

  if (isMac) {
    // Use "set frontmost of process" instead of "activate" to avoid
    // bringing ALL windows of the app to front across all screens.
    // "activate" reorganizes every window on every display — "set frontmost"
    // only raises the app's currently-focused window on the current screen.
    const script = previousAppName
      ? `tell application "System Events"
           set frontmost of process "${previousAppName}" to true
           delay 0.3
           keystroke "v" using command down
         end tell`
      : `delay 0.2
         tell application "System Events" to keystroke "v" using command down`;

    setTimeout(() => {
      const proc = spawn('osascript', ['-e', script]);
      proc.stderr.on('data', (d) => console.error('AppleScript error:', d.toString()));
    }, 150);
  } else if (isWin) {
    setTimeout(() => {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^v')
      `.trim();

      const tempFile = path.join(app.getPath('temp'), 'paply-paste.ps1');
      fs.writeFileSync(tempFile, psScript, 'utf8');

      exec(`powershell -ExecutionPolicy Bypass -File "${tempFile}"`, (err, stdout, stderr) => {
        if (err) console.error('PowerShell paste error:', err);
        if (stderr) console.error('PowerShell stderr:', stderr);
        try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
      });
    }, 400);
  }
}

function startTranscription() {
  // Legacy toggle: used by dashboard button, tray menu, etc.
  if (isRecording) {
    stopRecording();
  } else {
    beginRecording();
  }
}

async function beginRecording() {
  if (isRecording) return;
  isRecording = true;
  await savePreviousApp();
  const win = createRecordingWindow();
  win.showInactive();
  win.webContents.send('recording:start');
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  recordingWindow?.webContents.send('recording:stop');
}

// ============================================================================
// PUSH-TO-TALK LOGIC
// ============================================================================

/**
 * Called when the main hotkey is pressed DOWN.
 * Smart combo behavior — always active, no mode selection needed:
 *   - Short tap → starts recording, stays on (toggle)
 *   - Second short tap → stops recording (toggle off)
 *   - Hold (> threshold) → Push-to-Talk, stops on release
 */
function handleHotkeyDown() {
  pttKeyDownTime = Date.now();

  if (isRecording) {
    // Already recording — stop it (second tap = toggle off)
    stopRecording();
    if (pttHoldTimer) { clearTimeout(pttHoldTimer); pttHoldTimer = null; }
    return;
  }

  // Start recording immediately (responsive feel)
  const threshold = getStore().get('pttThreshold', 350);
  beginRecording();
  pttIsHolding = false;

  // After threshold, mark as "holding" so release will stop
  if (pttHoldTimer) clearTimeout(pttHoldTimer);
  pttHoldTimer = setTimeout(() => {
    pttIsHolding = true;
    pttHoldTimer = null;
  }, threshold);
}

/**
 * Called when the main hotkey is released (key UP).
 * If the key was held long enough, stop recording (PTT).
 * If it was a short tap, recording stays on (toggle).
 */
function handleHotkeyUp() {
  // If recording was already stopped by handleHotkeyDown (second tap), skip
  if (!isRecording) {
    pttIsHolding = false;
    pttKeyDownTime = 0;
    return;
  }

  const holdDuration = Date.now() - pttKeyDownTime;
  const threshold = getStore().get('pttThreshold', 350);

  if (pttHoldTimer) {
    clearTimeout(pttHoldTimer);
    pttHoldTimer = null;
  }

  if (holdDuration >= threshold || pttIsHolding) {
    // Long press (held) — stop recording on release
    stopRecording();
  }
  // Short press (tap) — recording stays on

  pttIsHolding = false;
  pttKeyDownTime = 0;
}

// ============================================================================
// AUDIO BACKUP SYSTEM (RAM + Disk persistence for crash-safe recovery)
// ============================================================================
let lastAudioBackup = null;
let backupTimestamp = null;
const BACKUP_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Lazy-initialized backup directory on disk
let _backupDir = null;
function getBackupDir() {
  if (!_backupDir) {
    _backupDir = path.join(app.getPath('userData'), 'audio-backups');
  }
  return _backupDir;
}

function saveAudioBackup(audioData) {
  // Store as proper Buffer to avoid serialization issues
  if (Buffer.isBuffer(audioData)) {
    lastAudioBackup = audioData;
  } else if (audioData instanceof Uint8Array || audioData instanceof ArrayBuffer) {
    lastAudioBackup = Buffer.from(audioData);
  } else if (typeof audioData === 'object' && audioData.type === 'Buffer') {
    lastAudioBackup = Buffer.from(audioData.data);
  } else {
    lastAudioBackup = Buffer.from(audioData);
  }
  backupTimestamp = Date.now();
  console.log('Audio backup saved:', lastAudioBackup.length, 'bytes');

  // Persist to disk asynchronously
  try {
    const dir = getBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `backup_${backupTimestamp}.webm`;
    fs.writeFile(path.join(dir, filename), lastAudioBackup, (err) => {
      if (err) {
        console.error('Failed to write audio backup to disk:', err);
      } else {
        console.log('Audio backup persisted to disk:', filename);
      }
    });
  } catch (err) {
    console.error('Failed to persist audio backup:', err);
  }
}

function loadBackupFromDisk() {
  try {
    const dir = getBackupDir();
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.webm'))
      .sort()
      .reverse();

    if (files.length > 0) {
      const latest = files[0];
      const timestamp = parseInt(latest.match(/backup_(\d+)/)?.[1] || '0');
      const age = Date.now() - timestamp;

      if (age < BACKUP_EXPIRY_MS) {
        lastAudioBackup = fs.readFileSync(path.join(dir, latest));
        backupTimestamp = timestamp;
        console.log('Audio backup restored from disk:', latest, '(' + lastAudioBackup.length + ' bytes)');
      }
    }
  } catch (err) {
    console.error('Failed to load audio backup from disk:', err);
  }
}

function getAudioBackup() {
  // If no RAM backup, try loading from disk as fallback
  if (!lastAudioBackup || !backupTimestamp) {
    loadBackupFromDisk();
    if (!lastAudioBackup || !backupTimestamp) return null;
  }

  // Check if backup is expired (24 hours)
  if (Date.now() - backupTimestamp > BACKUP_EXPIRY_MS) {
    clearAudioBackup();
    return null;
  }

  return lastAudioBackup;
}

function clearAudioBackup() {
  lastAudioBackup = null;
  backupTimestamp = null;
  console.log('Audio backup cleared');

  // Also clear disk backups
  try {
    const dir = getBackupDir();
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(f => {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch (e) {
          console.error('Failed to delete backup file:', f, e);
        }
      });
    }
  } catch (err) {
    console.error('Failed to clear disk backups:', err);
  }
}

function cleanupOldBackups() {
  try {
    const dir = getBackupDir();
    if (!fs.existsSync(dir)) return;

    const now = Date.now();
    fs.readdirSync(dir).forEach(f => {
      const timestamp = parseInt(f.match(/backup_(\d+)/)?.[1] || '0');
      if (now - timestamp > BACKUP_EXPIRY_MS) {
        try {
          fs.unlinkSync(path.join(dir, f));
          console.log('Cleaned up old backup:', f);
        } catch (e) {
          console.error('Failed to delete old backup:', f, e);
        }
      }
    });
  } catch (err) {
    console.error('Failed to cleanup old backups:', err);
  }
}

async function retryLastRecording() {
  const backup = getAudioBackup();
  if (!backup) {
    console.log('No backup available for retry');
    dialog.showMessageBox({
      type: 'info',
      title: 'Keine Aufnahme',
      message: 'Keine Aufnahme zum Wiederholen verfügbar.',
      detail: 'Das Backup ist entweder abgelaufen oder es gab keine fehlerhafte Aufnahme.',
      buttons: ['OK'],
    });
    return;
  }

  console.log('Retrying last recording from backup...');

  // Show recording window with processing state
  const win = createRecordingWindow();
  win.showInactive();
  win.webContents.send('status:update', { status: 'transcribing', detail: 'Wiederhole...' });

  // Process the backup audio
  await processAudioData(backup, true);
}

async function processAudioData(audioData, isRetry = false) {
  const updateStatus = (status, detail = '') => {
    recordingWindow?.webContents.send('status:update', { status, detail });
  };

  const s = getStore();
  const autopaste = s.get('autopaste');

  try {
    const language = s.get('language');
    const enablePolish = s.get('enablePolish');
    updateStatus('transcribing');

    // KEIN Placeholder mehr - wir fügen nur den finalen Text ein, wenn er bereit ist

    // Ensure audioData is a proper Buffer
    let audioBuffer;
    if (Buffer.isBuffer(audioData)) {
      audioBuffer = audioData;
    } else if (audioData instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(audioData);
    } else if (audioData instanceof Uint8Array) {
      audioBuffer = Buffer.from(audioData);
    } else if (typeof audioData === 'object' && audioData.type === 'Buffer') {
      // IPC serializes Buffer as {type: 'Buffer', data: [...]}
      audioBuffer = Buffer.from(audioData.data);
    } else {
      audioBuffer = Buffer.from(audioData);
    }

    console.log('Audio buffer type:', typeof audioData, 'Buffer size:', audioBuffer.length);

    const transcript = await transcribeAudio(audioBuffer, language);
    console.log('Transcript:', transcript);

    // Bei leerer Transkription (Stille) einfach beenden - nichts ausgeben
    if (!transcript) {
      console.log('Empty transcript - nothing to paste');
      updateStatus('done');
      setTimeout(() => recordingWindow?.hide(), 300);
      return { success: true, empty: true };
    }

    let polished = null;
    if (enablePolish && s.get('groqApiKey')) {
      updateStatus('polishing');
      const activeProfileId = s.get('activeProfile') || 'coding';
      const profiles = s.get('profiles') || {};
      const customAgents = s.get('customAgents') || [];

      // Find active agent (standard or custom)
      let activeAgent = profiles[activeProfileId];
      let polishFlavor = 'code';
      let customSettings = null;

      if (activeAgent) {
        polishFlavor = activeAgent.polishFlavor || 'code';
      } else {
        // Check custom agents
        const customAgent = customAgents.find(a => a.id === activeProfileId);
        if (customAgent) {
          polishFlavor = 'custom';
          customSettings = customAgent;
        }
      }

      // Polish the transcript (Claude handles file name formatting in the prompt)
      polished = await polishText(transcript, language, polishFlavor, customSettings);
      console.log('Polished:', polished);
    } else {
      // No polishing - use transcript as-is
      polished = null;
    }

    addToHistory({ transcript, polished, language });

    const finalText = polished || transcript;
    const copyToClipboard = s.get('copyToClipboard');

    // Direkt den finalen Text einfügen - kein Placeholder mehr
    if (autopaste) {
      autopasteText(finalText);
    } else if (copyToClipboard) {
      clipboard.writeText(finalText);
    }

    // Success - clear backup
    clearAudioBackup();

    updateStatus('done');
    setTimeout(() => recordingWindow?.hide(), 300);
    return { success: true, transcript, polished };

  } catch (error) {
    console.error('Transcription error:', error);

    // Bei Fehler nichts tun - es wurde kein Placeholder eingefügt

    // Keep backup for retry
    if (!isRetry) {
      console.log('Backup preserved for retry');
    }

    // Show error with retry option
    updateStatus('error', error.message || 'Transkription fehlgeschlagen');

    // Show retry notification in recording window
    recordingWindow?.webContents.send('error:retry', {
      message: error.message || 'Transkription fehlgeschlagen',
      hotkey: isMac ? '⌥⇧⌘R' : 'Ctrl+Alt+Shift+R'
    });

    setTimeout(() => {
      recordingWindow?.hide();
    }, 3000);

    return { success: false, error };
  }
}

// ============================================================================
// HOTKEY
// ============================================================================
let currentShortcut = null;
let smartPasteWindow = null;
let agentHotkeys = [];
let uioHook = null;
let uioHookStarted = false;

/**
 * Initialize uiohook-napi for keyUp detection (needed for Push-to-Talk).
 * Returns the uioHook instance or null if not available.
 */
function getUioHook() {
  if (uioHook) return uioHook;
  try {
    const { uIOhook } = require('uiohook-napi');
    uioHook = uIOhook;
    return uioHook;
  } catch (err) {
    console.warn('[PTT] uiohook-napi not available:', err.message);
    return null;
  }
}

/**
 * Map an Electron accelerator string to a uiohook keycode.
 * This handles the most common keys; extend as needed.
 */
function acceleratorToUioKeycode(accelerator) {
  const keyMap = {
    'A': 30, 'B': 48, 'C': 46, 'D': 32, 'E': 18, 'F': 33, 'G': 34,
    'H': 35, 'I': 23, 'J': 36, 'K': 37, 'L': 38, 'M': 50, 'N': 49,
    'O': 24, 'P': 25, 'Q': 16, 'R': 19, 'S': 31, 'T': 20, 'U': 22,
    'V': 47, 'W': 17, 'X': 45, 'Y': 21, 'Z': 44,
    '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
    'F1': 59, 'F2': 60, 'F3': 61, 'F4': 62, 'F5': 63, 'F6': 64,
    'F7': 65, 'F8': 66, 'F9': 67, 'F10': 68, 'F11': 87, 'F12': 88,
    'SPACE': 57, 'ENTER': 28, 'BACKSPACE': 14, 'TAB': 15, 'ESCAPE': 1,
    '`': 41, '-': 12, '=': 13, '[': 26, ']': 27, '\\': 43,
    ';': 39, "'": 40, ',': 51, '.': 52, '/': 53,
  };
  // Extract the main key (last part after +)
  const parts = accelerator.split('+');
  const mainKey = parts[parts.length - 1].toUpperCase().trim();
  return keyMap[mainKey] || null;
}

function registerHotkey() {
  const shortcut = getStore().get('shortcut');

  // Unregister previous shortcut
  if (currentShortcut && currentShortcut !== 'GLOBE') {
    try { globalShortcut.unregister(currentShortcut); } catch {}
  }

  // Stop Globe key listener if switching away from GLOBE
  if (shortcut !== 'GLOBE') {
    globeKeyManager.stop();
    globeKeyManager.removeAllListeners();
  }

  // Handle GLOBE key (macOS only)
  if (shortcut === 'GLOBE') {
    if (!isMac) {
      console.error('GLOBE key only supported on macOS');
      return;
    }
    currentShortcut = 'GLOBE';

    // Remove old listeners before adding new ones
    globeKeyManager.removeAllListeners();

    globeKeyManager.on('globe-down', () => {
      console.log('Globe key DOWN');
      handleHotkeyDown();
    });
    globeKeyManager.on('globe-up', () => {
      console.log('Globe key UP');
      handleHotkeyUp();
    });
    globeKeyManager.start();

    console.log('Hotkey registered: GLOBE (Fn) key');
  } else {
    // Standard Electron globalShortcut for keyDown
    const ok = globalShortcut.register(shortcut, () => {
      console.log('Hotkey pressed:', shortcut);
      handleHotkeyDown();
    });

    if (ok) {
      currentShortcut = shortcut;
      console.log('Hotkey registered:', shortcut);
    } else {
      console.error('Hotkey registration failed:', shortcut);
    }

    // Always set up keyUp detection for combo mode (tap=toggle, hold=PTT)
    setupUioHookKeyUp(shortcut);
  }

  // Register Smart-Paste hotkey (Cmd+Option+Shift+V / Ctrl+Alt+Shift+V)
  // Avoid Cmd+Shift+V — that's "Paste without formatting" in most apps!
  const smartPasteKey = isMac ? 'Command+Option+Shift+V' : 'Ctrl+Alt+Shift+V';
  globalShortcut.register(smartPasteKey, () => {
    console.log('Smart-Paste hotkey pressed');
    showSmartPasteOverlay();
  });

  // Register Recovery hotkey (Cmd+Option+Shift+R / Ctrl+Alt+Shift+R)
  // Avoid Cmd+Shift+R — that's "Hard Reload" in browsers!
  const recoveryKey = isMac ? 'Command+Option+Shift+R' : 'Ctrl+Alt+Shift+R';
  globalShortcut.register(recoveryKey, () => {
    console.log('Recovery hotkey pressed');
    retryLastRecording();
  });

  // Register Meeting-Recorder hotkey (Standard Cmd+Shift+X, Toggle)
  const meetingKey = getStore().get('meetingHotkey', 'Command+Shift+X');
  try { globalShortcut.unregister(meetingKey); } catch {}
  const meetingOk = globalShortcut.register(meetingKey, () => {
    console.log('Meeting hotkey pressed:', meetingKey);
    if (meetingController && meetingController.isActive()) {
      Promise.resolve(meetingController.stop()).catch((e) => console.error('Meeting stop error:', e));
    } else if (meetingController) {
      meetingController.start();
    }
  });
  if (!meetingOk) console.error('Meeting hotkey registration failed:', meetingKey);

  // Register Agent-Switch hotkeys (Cmd+1, Cmd+2, Cmd+3, ...)
  registerAgentHotkeys();
}

/**
 * Set up uiohook keyUp listener for Push-to-Talk.
 * This detects when the user releases the hotkey.
 */
function setupUioHookKeyUp(shortcut) {
  const hook = getUioHook();
  if (!hook) {
    console.warn('[PTT] Cannot set up keyUp detection — uiohook-napi not available');
    return;
  }

  const targetKeycode = acceleratorToUioKeycode(shortcut);
  if (!targetKeycode) {
    console.warn(`[PTT] Cannot map shortcut "${shortcut}" to uiohook keycode`);
    return;
  }

  // Remove previous listeners to avoid duplicates
  hook.removeAllListeners('keyup');

  hook.on('keyup', (e) => {
    if (e.keycode === targetKeycode) {
      handleHotkeyUp();
    }
  });

  // Start hook if not already running
  if (!uioHookStarted) {
    try {
      hook.start();
      uioHookStarted = true;
      console.log('[PTT] uiohook keyUp listener started for keycode:', targetKeycode);
    } catch (err) {
      console.error('[PTT] Failed to start uiohook:', err.message);
    }
  } else {
    console.log('[PTT] uiohook keyUp listener updated for keycode:', targetKeycode);
  }
}

/**
 * Stop uiohook if no longer needed (e.g. switching to toggle mode).
 */
function stopUioHook() {
  if (uioHook && uioHookStarted) {
    try {
      uioHook.removeAllListeners('keyup');
      uioHook.stop();
      uioHookStarted = false;
      console.log('[PTT] uiohook stopped');
    } catch (err) {
      console.warn('[PTT] Error stopping uiohook:', err.message);
    }
  }
}

function registerAgentHotkeys() {
  // Unregister existing agent hotkeys
  agentHotkeys.forEach(key => {
    try {
      globalShortcut.unregister(key);
    } catch (e) {
      // Ignore
    }
  });
  agentHotkeys = [];

  const s = getStore();
  const profiles = s.get('profiles') || {};

  // Standard-Agenten: Nur benutzerdefinierte Hotkeys verwenden (keine Defaults)
  const agents = [
    { id: 'coding', key: profiles.coding?.hotkey || '' },
    { id: 'meeting', key: profiles.meeting?.hotkey || '' },
    { id: 'dictation', key: profiles.dictation?.hotkey || '' },
  ];

  // Custom Agents bekommen ihre benutzerdefinierten Hotkeys (wenn vorhanden)
  const customAgents = s.get('customAgents') || [];
  customAgents.forEach((agent) => {
    // Nur hinzufügen, wenn ein benutzerdefinierter Hotkey gesetzt ist
    if (agent.hotkey && agent.hotkey.trim()) {
      agents.push({
        id: agent.id,
        key: agent.hotkey,
      });
    }
  });

  // Register each agent hotkey (skip agents with empty/cleared hotkeys)
  agents.filter(agent => agent.key && agent.key.trim()).forEach(agent => {
    try {
      const registered = globalShortcut.register(agent.key, () => {
        console.log(`Agent hotkey pressed: ${agent.key} -> ${agent.id}`);
        switchAgent(agent.id);
      });

      if (registered) {
        agentHotkeys.push(agent.key);
        console.log(`Agent hotkey registered: ${agent.key} -> ${agent.id}`);
      } else {
        console.warn(`Failed to register agent hotkey: ${agent.key} (might be in use by another app)`);
      }
    } catch (e) {
      console.error(`Error registering hotkey ${agent.key}:`, e.message);
    }
  });
}

function switchAgent(agentId) {
  const s = getStore();
  const currentAgent = s.get('activeProfile');

  if (currentAgent === agentId) {
    console.log(`Already on agent: ${agentId}`);
    return;
  }

  // Update active profile
  s.set('activeProfile', agentId);

  // Get agent info (check standard profiles first, then custom agents)
  const profiles = s.get('profiles') || {};
  const customAgents = s.get('customAgents') || [];
  let agentInfo = profiles[agentId];
  let agentName = agentInfo?.name || agentId;
  let agentIcon = '🎯';
  let agentColor = '#7ED957';

  // Check custom agents if not found in standard profiles
  if (!agentInfo) {
    const customAgent = customAgents.find(a => a.id === agentId);
    if (customAgent) {
      agentInfo = customAgent;
      agentName = customAgent.name;
      agentIcon = customAgent.icon || '🎯';
      agentColor = customAgent.color || '#7ED957';
    }
  }

  // Update settings based on agent
  if (agentInfo) {
    s.set('autopaste', agentInfo.autopaste ?? true);
    s.set('language', agentInfo.language || 'de');
  }

  console.log(`Switched to agent: ${agentName}`);

  // Show visual feedback
  showAgentSwitchNotification(agentId, agentName, agentIcon, agentColor);

  // Notify dashboard if open
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:switched', { id: agentId, name: agentName, icon: agentIcon, color: agentColor });
  }
}

function showAgentSwitchNotification(agentId, agentName, agentIcon = '🎯', agentColor = '#7ED957') {
  // Show in recording window as a brief toast
  if (recordingWindow && !recordingWindow.isDestroyed()) {
    recordingWindow.webContents.send('agent:switched', { id: agentId, name: agentName, icon: agentIcon, color: agentColor });

    // Briefly show the recording window for feedback
    recordingWindow.show();
    setTimeout(() => {
      if (recordingWindow && !recordingWindow.isDestroyed() && !isRecording) {
        recordingWindow.hide();
      }
    }, 1200);
  }

  // Update tray tooltip
  if (tray) {
    tray.setToolTip(`paply - ${agentIcon} ${agentName}`);
  }
}

function showSmartPasteOverlay() {
  // Get last transcript from history
  const history = getHistory();
  if (history.length === 0) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Smart-Paste',
      message: 'Keine Transkription vorhanden',
      detail: 'Erstelle zuerst eine Transkription, um Smart-Paste zu nutzen.',
      buttons: ['OK'],
    });
    return;
  }

  const lastText = history[0].polished || history[0].transcript;
  const snippets = getStore().get('snippets') || [];

  // Build menu for snippet selection
  const template = [
    { label: 'Als Plain Text', click: () => { clipboard.writeText(lastText); } },
    { label: 'Als Markdown', click: () => { clipboard.writeText('```\n' + lastText + '\n```'); } },
    { type: 'separator' },
  ];

  snippets.forEach(snippet => {
    template.push({
      label: `Snippet: ${snippet.name}`,
      click: () => {
        const result = snippet.template.replace(/\{\{text\}\}/g, lastText);
        clipboard.writeText(result);
      },
    });
  });

  const menu = Menu.buildFromTemplate(template);
  menu.popup();
}

// ============================================================================
// IPC HANDLERS
// ============================================================================
function setupIpcHandlers() {
  // Meeting-Recorder
  ipcMain.handle('meeting:start', () => (meetingController ? meetingController.start() : null));
  ipcMain.handle('meeting:stop', () => (meetingController ? meetingController.stop() : null));
  ipcMain.handle('meeting:get-status', () => (meetingController ? meetingController.getStatus() : { active: false, id: null }));
  ipcMain.on('meeting:overlay-expand', (_e, expanded) => {
    if (!meetingOverlayWindow || meetingOverlayWindow.isDestroyed()) return;
    const { screen } = require('electron');
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    const w = expanded ? 360 : 200;
    const h = expanded ? 240 : 64;
    meetingOverlayWindow.setBounds({ x: width - w - 24, y: 24, width: w, height: h });
  });
  ipcMain.on('meeting:mic-pcm', (_e, buf) => { if (meetingController) meetingController.onMicPcm(Buffer.from(buf)); });
  ipcMain.on('meeting:mic-level', (_e, lvl) => { if (meetingController) meetingController.onMicLevel(lvl); });
  ipcMain.handle('meetings:list', () => (meetingStore ? meetingStore.list() : []));
  ipcMain.handle('meetings:get', (_e, id) => (meetingStore ? meetingStore.get(id) : null));
  ipcMain.handle('meetings:delete', (_e, id) => (meetingStore ? meetingStore.remove(id) : false));
  ipcMain.handle('meetings:retranscribe', (_e, id) => (meetingController ? meetingController.retranscribe(id) : false));
  ipcMain.handle('meetings:regenerateSummary', (_e, id) => (meetingController ? meetingController.regenerateSummary(id) : null));
  ipcMain.handle('meetings:updateSpeakerName', (_e, id, channel, name) => (meetingStore ? meetingStore.updateSpeakerName(id, channel, name) : false));
  ipcMain.handle('meetings:toggleTodo', (_e, id, idx) => (meetingStore ? meetingStore.toggleTodo(id, idx) : false));

  // Settings
  ipcMain.handle('settings:get', () => {
    const s = getStore();
    return {
      groqApiKey: s.get('groqApiKey'),
      enablePolish: s.get('enablePolish'),
      shortcut: s.get('shortcut'),
      autoStart: s.get('autoStart'),
      language: s.get('language'),
      autopaste: s.get('autopaste'),
      beepEnabled: s.get('beepEnabled'),
      copyToClipboard: s.get('copyToClipboard'),
      hideDock: s.get('hideDock'),
      activeProfile: s.get('activeProfile'),
      pttThreshold: s.get('pttThreshold', 350),
      meetingHotkey: s.get('meetingHotkey', 'Command+Shift+X'),
      deepgramApiKey: s.get('deepgramApiKey', ''),
      diarizationEnabled: s.get('diarizationEnabled', false),
    };
  });

  ipcMain.handle('settings:set', (_event, settings) => {
    const s = getStore();
    if (settings.groqApiKey !== undefined) s.set('groqApiKey', settings.groqApiKey);
    if (settings.enablePolish !== undefined) s.set('enablePolish', settings.enablePolish);
    if (settings.language !== undefined) s.set('language', settings.language);
    if (settings.autopaste !== undefined) s.set('autopaste', settings.autopaste);
    if (settings.beepEnabled !== undefined) s.set('beepEnabled', settings.beepEnabled);
    if (settings.copyToClipboard !== undefined) s.set('copyToClipboard', settings.copyToClipboard);

    if (settings.shortcut !== undefined && settings.shortcut !== s.get('shortcut')) {
      s.set('shortcut', settings.shortcut);
      registerHotkey();
    }

    if (settings.meetingHotkey !== undefined && settings.meetingHotkey !== s.get('meetingHotkey')) {
      s.set('meetingHotkey', settings.meetingHotkey);
      registerHotkey();
    }

    if (settings.deepgramApiKey !== undefined) s.set('deepgramApiKey', settings.deepgramApiKey);
    if (settings.diarizationEnabled !== undefined) s.set('diarizationEnabled', settings.diarizationEnabled);

    if (settings.pttThreshold !== undefined) {
      s.set('pttThreshold', settings.pttThreshold);
    }

    if (settings.autoStart !== undefined) {
      s.set('autoStart', settings.autoStart);
      updateAutoLaunch();
    }

    if (settings.hideDock !== undefined) {
      s.set('hideDock', settings.hideDock);
      if (app.dock) {
        if (settings.hideDock) {
          app.dock.hide();
        } else {
          app.dock.show();
        }
      }
    }

    if (settings.activeProfile !== undefined) {
      s.set('activeProfile', settings.activeProfile);
    }

    updateTrayMenu();
    return true;
  });

  // History
  ipcMain.handle('history:get', () => getHistory());
  ipcMain.handle('history:clear', () => { clearHistory(); return true; });
  ipcMain.handle('history:copy', (_event, id) => {
    const item = getHistory().find((h) => h.id === id);
    if (item) {
      clipboard.writeText(item.polished || item.transcript);
      return true;
    }
    return false;
  });
  ipcMain.handle('history:delete', (_event, id) => deleteHistoryItem(id));
  ipcMain.handle('history:toggleFavorite', (_event, id) => toggleFavorite(id));

  // Stats
  ipcMain.handle('stats:get', () => {
    resetStatsIfNeeded();
    return getStore().get('stats');
  });

  ipcMain.handle('stats:owner', () => {
    const s = getStore();
    if (!s.get('ownerMode')) return null;
    return s.get('ownerStats');
  });

  // Owner Mode
  ipcMain.handle('owner:check', () => getStore().get('ownerMode'));
  ipcMain.handle('owner:toggle', (_event, password) => {
    // Simple password check for owner mode (can be changed)
    const s = getStore();
    if (password === 'paply-owner-2024') {
      s.set('ownerMode', !s.get('ownerMode'));
      return s.get('ownerMode');
    }
    return false;
  });

  // Profiles / Agents
  ipcMain.handle('profiles:get', () => {
    const s = getStore();
    return {
      active: s.get('activeProfile'),
      profiles: s.get('profiles'),
      customAgents: s.get('customAgents') || [],
    };
  });

  ipcMain.handle('profiles:setActive', (_event, profileId) => {
    const s = getStore();
    const profiles = s.get('profiles');
    const customAgents = s.get('customAgents') || [];

    // Check standard profiles
    if (profiles[profileId]) {
      s.set('activeProfile', profileId);
      const profile = profiles[profileId];
      if (profile.language) s.set('language', profile.language);
      if (profile.autopaste !== undefined) s.set('autopaste', profile.autopaste);
      updateTrayMenu();
      return true;
    }

    // Check custom agents
    const customAgent = customAgents.find(a => a.id === profileId);
    if (customAgent) {
      s.set('activeProfile', profileId);
      if (customAgent.language) s.set('language', customAgent.language);
      if (customAgent.autopaste !== undefined) s.set('autopaste', customAgent.autopaste);
      updateTrayMenu();
      return true;
    }

    return false;
  });

  ipcMain.handle('profiles:update', (_event, profileId, updates) => {
    const s = getStore();
    const profiles = s.get('profiles');
    if (profiles[profileId]) {
      profiles[profileId] = { ...profiles[profileId], ...updates };
      s.set('profiles', profiles);

      // Re-register hotkeys if hotkey was updated
      if (updates.hotkey !== undefined) {
        registerAgentHotkeys();
        console.log(`Profile ${profileId} hotkey updated to: ${updates.hotkey || '(default)'}`);
      }

      return true;
    }
    return false;
  });

  // Custom Agents CRUD
  ipcMain.handle('agents:getAll', () => {
    return getStore().get('customAgents') || [];
  });

  ipcMain.handle('agents:create', (_event, agent) => {
    const s = getStore();
    const agents = s.get('customAgents') || [];
    const newAgent = {
      ...agent,
      id: agent.id || `agent_${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    agents.push(newAgent);
    s.set('customAgents', agents);
    registerAgentHotkeys(); // Re-register hotkeys
    return newAgent;
  });

  ipcMain.handle('agents:update', (_event, agentId, updates) => {
    const s = getStore();
    const agents = s.get('customAgents') || [];
    const index = agents.findIndex(a => a.id === agentId);
    if (index !== -1) {
      agents[index] = { ...agents[index], ...updates, updatedAt: new Date().toISOString() };
      s.set('customAgents', agents);
      registerAgentHotkeys(); // Re-register hotkeys
      return agents[index];
    }
    return null;
  });

  ipcMain.handle('agents:delete', (_event, agentId) => {
    const s = getStore();
    const agents = s.get('customAgents') || [];
    const filtered = agents.filter(a => a.id !== agentId);
    s.set('customAgents', filtered);

    // If deleted agent was active, switch to default
    if (s.get('activeProfile') === agentId) {
      s.set('activeProfile', 'coding');
    }

    registerAgentHotkeys(); // Re-register hotkeys
    return true;
  });

  ipcMain.handle('agents:reorder', (_event, orderedIds) => {
    const s = getStore();
    const agents = s.get('customAgents') || [];
    const reordered = orderedIds
      .map(id => agents.find(a => a.id === id))
      .filter(Boolean);
    s.set('customAgents', reordered);
    registerAgentHotkeys(); // Re-register hotkeys
    return reordered;
  });

  ipcMain.handle('agents:updateHotkey', (_event, agentId, hotkey) => {
    const s = getStore();
    const agents = s.get('customAgents') || [];
    const index = agents.findIndex(a => a.id === agentId);
    if (index !== -1) {
      agents[index].hotkey = hotkey || '';
      agents[index].updatedAt = new Date().toISOString();
      s.set('customAgents', agents);
      registerAgentHotkeys(); // Re-register hotkeys
      console.log(`Agent hotkey updated: ${agentId} -> ${hotkey || '(none)'}`);
      return agents[index];
    }
    return null;
  });

  // Snippets
  ipcMain.handle('snippets:get', () => getStore().get('snippets'));

  ipcMain.handle('snippets:add', (_event, snippet) => {
    const s = getStore();
    const snippets = s.get('snippets') || [];
    const newSnippet = {
      id: `custom-${Date.now()}`,
      name: snippet.name,
      template: snippet.template,
    };
    snippets.push(newSnippet);
    s.set('snippets', snippets);
    return newSnippet;
  });

  ipcMain.handle('snippets:delete', (_event, id) => {
    const s = getStore();
    const snippets = s.get('snippets') || [];
    const index = snippets.findIndex(sn => sn.id === id);
    if (index !== -1) {
      snippets.splice(index, 1);
      s.set('snippets', snippets);
      return true;
    }
    return false;
  });

  ipcMain.handle('snippets:apply', (_event, snippetId, text) => {
    const snippets = getStore().get('snippets') || [];
    const snippet = snippets.find(sn => sn.id === snippetId);
    if (snippet) {
      const result = snippet.template.replace(/\{\{text\}\}/g, text);
      clipboard.writeText(result);
      return result;
    }
    return text;
  });

  // Transcription trigger from dashboard
  ipcMain.handle('transcription:start', () => {
    startTranscription();
    return true;
  });

  ipcMain.handle('transcription:stop', () => {
    if (isRecording) {
      isRecording = false;
      recordingWindow?.webContents.send('recording:stop');
    }
    return true;
  });

  ipcMain.handle('transcription:status', () => ({
    isRecording,
  }));

  ipcMain.on('recording:audio', async (_event, audioData) => {
    console.log('Received audio:', audioData.byteLength, 'bytes');
    isRecording = false;

    // Save backup immediately
    saveAudioBackup(audioData);

    // Process the audio
    await processAudioData(audioData, false);
  });

  ipcMain.on('open:accessibility', () => {
    if (isMac) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else if (isWin) {
      // On Windows, open Privacy Settings
      shell.openExternal('ms-settings:privacy-microphone');
    }
  });

  // Expose platform info to renderer
  ipcMain.handle('platform:get', () => ({
    isMac,
    isWin,
    platform: process.platform,
  }));
}

// ============================================================================
// APP LIFECYCLE
// ============================================================================
app.whenReady().then(() => {
  const s = getStore();

  // Dock-Icon verstecken wenn gewünscht (Standard: sichtbar)
  if (app.dock && s.get('hideDock')) {
    app.dock.hide();
  }

  // Restore audio backup from disk (crash-safe recovery)
  cleanupOldBackups();
  loadBackupFromDisk();

  // Setup auto-updater
  setupAutoUpdater();

  setupIpcHandlers();
  setupTray();
  createRecordingWindow();

  // Meeting-Recorder initialisieren (vor registerHotkey, damit der Hotkey-Callback ihn findet)
  meetingStore = createMeetingStore({
    baseDir: path.join(app.getPath('userData'), 'meetings'),
    store: getStore(),
  });
  meetingController = createMeetingController({
    store: getStore(),
    meetingStore,
    audioTee: audioTeeManager,
    getOverlayWindow: () => createMeetingOverlayWindow(),
    getMainWindow: () => mainWindow,
    fetchImpl: (...args) => globalThis.fetch(...args),
    // WICHTIG: KEIN excludeProcesses — AudioTee scheitert bei der Tap-Erstellung,
    // wenn die PID kein Audio-Objekt hat (der Main-Prozess spielt kein Audio ab).
    // Daher das gesamte System-Audio aufnehmen.
    // Intelligentes Chunking: Schnitt bevorzugt an Sprechpausen zwischen 20–40 s
    // (statt hart bei 30 s), spätestens hart bei 40 s.
    chunkMinSeconds: 20,
    chunkMaxSeconds: 40,
  });

  registerHotkey();
  updateAutoLaunch();

  // Reset daily/weekly stats if needed
  resetStatsIfNeeded();

  console.log('paply started');
  console.log('Version:', CURRENT_VERSION);
  console.log('Shortcut:', s.get('shortcut'));
  console.log('Groq Key:', s.get('groqApiKey') ? 'Set' : 'Not set');
  console.log('Polish:', s.get('enablePolish') ? 'Enabled' : 'Disabled');

  // Auto-open dashboard (or settings on first run if no API key)
  if (!s.get('groqApiKey')) {
    setTimeout(() => {
      createMainWindow();
      dialog.showMessageBox({
        type: 'info',
        title: 'Willkommen bei paply!',
        message: 'API Key benötigt',
        detail: 'Bitte konfiguriere deinen Groq API Key in den Einstellungen.\n\nDu kannst einen kostenlosen API Key hier erstellen:\nhttps://console.groq.com/keys',
        buttons: ['OK'],
      });
    }, 500);
  } else {
    // Open main window on startup
    setTimeout(() => createMainWindow(), 300);
  }

  // Check for updates silently on startup (after 5 seconds)
  setTimeout(() => {
    checkForUpdates(true);
  }, 5000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  globeKeyManager.stop();
  audioTeeManager.stop();
  if (meetingController && meetingController.isActive()) {
    Promise.resolve(meetingController.stop()).catch(() => {});
  }
  stopUioHook();
});
app.on('window-all-closed', (e) => { e.preventDefault(); });
