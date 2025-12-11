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
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, exec } = require('node:child_process');

// ============================================================================
// PLATFORM HELPERS
// ============================================================================
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

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
        haikuApiKey: '',
        enablePolish: false,
        shortcut: getDefaultShortcut(),
        autoStart: false,
        language: 'de',
        autopaste: true,
        beepEnabled: true,
        history: [],
      },
    });
  }
  return store;
}

function getAutoLauncher() {
  if (!autoLauncher) {
    const AutoLaunch = require('auto-launch');
    autoLauncher = new AutoLaunch({
      name: 'Labertaschi',
      path: app.getPath('exe'),
    });
  }
  return autoLauncher;
}

function updateAutoLaunch() {
  try {
    const enabled = getStore().get('autoStart');
    const launcher = getAutoLauncher();
    if (enabled) {
      launcher.enable();
    } else {
      launcher.disable();
    }
  } catch (e) {
    console.error('AutoLaunch error:', e);
  }
}

// ============================================================================
// HISTORY MANAGEMENT
// ============================================================================
const MAX_HISTORY = 30;

function addToHistory(entry) {
  const s = getStore();
  const history = s.get('history') || [];
  const newEntry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    transcript: entry.transcript,
    polished: entry.polished || null,
    language: entry.language,
  };
  history.unshift(newEntry);
  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }
  s.set('history', history);
  updateTrayMenu();
  return newEntry;
}

function getHistory() {
  return getStore().get('history') || [];
}

function clearHistory() {
  getStore().set('history', []);
  updateTrayMenu();
}

// ============================================================================
// API CALLS
// ============================================================================
const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const GITHUB_REPO = 'allanhamduws-alt/Labertaschi';
const CURRENT_VERSION = require('./package.json').version;

async function transcribeAudio(audioBuffer, language = 'de') {
  const apiKey = getStore().get('groqApiKey');
  if (!apiKey) {
    throw new Error('Groq API Key nicht konfiguriert');
  }

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: 'audio/webm' });
  formData.append('file', blob, 'audio.webm');
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('language', language);
  formData.append('response_format', 'json');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      console.error('Groq error:', res.status, errText);
      throw new Error(`Transkription fehlgeschlagen (${res.status})`);
    }

    const json = await res.json();
    return json?.text?.trim() ?? '';
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') throw new Error('Timeout nach 30s');
    throw error;
  }
}

// ============================================================================
// UPDATE CHECKER
// ============================================================================
async function checkForUpdates(silent = false) {
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!response.ok) {
      if (!silent) {
        dialog.showMessageBox({
          type: 'error',
          title: 'Update-Prüfung fehlgeschlagen',
          message: 'Konnte nicht nach Updates suchen.',
          detail: `Status: ${response.status}`,
          buttons: ['OK'],
        });
      }
      return null;
    }

    const release = await response.json();
    const latestVersion = release.tag_name.replace(/^v/, '');
    
    console.log(`Current version: ${CURRENT_VERSION}, Latest: ${latestVersion}`);

    if (compareVersions(latestVersion, CURRENT_VERSION) > 0) {
      // New version available
      const platform = isMac ? 'mac' : 'windows';
      const assetName = isMac ? '.dmg' : 'Setup';
      const downloadAsset = release.assets.find(a => 
        a.name.toLowerCase().includes(assetName.toLowerCase())
      );

      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Update verfügbar!',
        message: `Neue Version ${latestVersion} verfügbar`,
        detail: `Du hast Version ${CURRENT_VERSION}.\n\n${release.body || 'Neue Verbesserungen und Bugfixes.'}\n\nMöchtest du das Update jetzt herunterladen?`,
        buttons: ['Herunterladen', 'Später'],
        defaultId: 0,
      });

      if (result.response === 0) {
        const downloadUrl = downloadAsset?.browser_download_url || release.html_url;
        shell.openExternal(downloadUrl);
      }
      return { hasUpdate: true, version: latestVersion };
    } else {
      if (!silent) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Kein Update verfügbar',
          message: 'Du hast die neueste Version!',
          detail: `Aktuelle Version: ${CURRENT_VERSION}`,
          buttons: ['OK'],
        });
      }
      return { hasUpdate: false, version: CURRENT_VERSION };
    }
  } catch (error) {
    console.error('Update check failed:', error);
    if (!silent) {
      dialog.showMessageBox({
        type: 'error',
        title: 'Update-Prüfung fehlgeschlagen',
        message: 'Konnte nicht nach Updates suchen.',
        detail: error.message,
        buttons: ['OK'],
      });
    }
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

async function polishText(text, language = 'de') {
  const apiKey = getStore().get('haikuApiKey');
  if (!apiKey) return null;

  const prompt = `Du bist ein Transkriptions-Polierer. Deine EINZIGE Aufgabe: Sprache säubern.

SPRACHE: ${language}
TON: Code

REGELN:
1. ENTFERNE: Füllwörter (ähm, äh, also, sozusagen, quasi, halt, ne, oder so), Wiederholungen, Versprecher
2. KORRIGIERE: Grammatik, Satzbau, Interpunktion - aber behalte den Inhalt exakt bei
3. TECH-BEGRIFFE: Korrigiere falsch erkannte Tech-Begriffe (use state → useState, shad cn → shadcn)

WICHTIG:
- Gib NUR den korrigierten Text zurück
- KEINE Kommentare, KEINE Erklärungen, KEINE Markdown-Formatierung

TEXT:
${text}`;

  const payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You polish voice dictations for coding tasks.',
    messages: [{ role: 'user', content: prompt }],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error('Anthropic error:', res.status);
      return null;
    }

    const json = await res.json();
    return json?.content?.[0]?.text?.trim() || null;
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
let settingsWindow = null;
let historyWindow = null;
let recordingWindow = null;

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Labertaschi Einstellungen',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
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
    title: 'Labertaschi History',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  historyWindow.loadFile(path.join(__dirname, 'history.html'));
  historyWindow.on('closed', () => { historyWindow = null; });
}

function createRecordingWindow() {
  if (recordingWindow && !recordingWindow.isDestroyed()) {
    return recordingWindow;
  }

  // Windows doesn't handle transparent frameless windows well
  const windowOptions = {
    width: 300,
    height: 120,
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
    // Windows: use a small titled window that stays on top
    windowOptions.frame = false;
    windowOptions.transparent = false;
    windowOptions.backgroundColor = '#1a1a2e';
    windowOptions.focusable = false;
  }

  recordingWindow = new BrowserWindow(windowOptions);

  recordingWindow.loadFile(path.join(__dirname, 'recording.html'));
  recordingWindow.on('closed', () => { recordingWindow = null; });

  // Position window in top-right corner
  if (isWin) {
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width } = primaryDisplay.workAreaSize;
    recordingWindow.setPosition(width - 320, 20);
  }

  return recordingWindow;
}

function showAboutDialog() {
  const shortcut = getStore().get('shortcut');
  const quitKey = isMac ? '⌘Q' : 'Ctrl+Q';
  dialog.showMessageBox({
    type: 'info',
    title: 'Über Labertaschi',
    message: 'Labertaschi',
    detail: `Version ${CURRENT_VERSION}

Sprachtranskription mit Groq Whisper Large V3
Optionales Polishing mit Claude Haiku 4.5

Shortcuts:
• ${shortcut} - Aufnahme starten/stoppen
• ${quitKey} - Beenden

© 2024 Labertaschi`,
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
  const haikuKey = s.get('haikuApiKey');
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
    ? (enablePolish && haikuKey ? '✓ Bereit (mit Polish)' : '✓ Bereit')
    : '⚠ API Key fehlt';

  const template = [
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Transcribe', accelerator: shortcut, click: startTranscription },
    { type: 'separator' },
    { label: 'History', submenu: historySubmenu },
    { type: 'separator' },
    { label: 'Einstellungen...', click: createSettingsWindow },
    { label: 'Nach Updates suchen...', click: () => checkForUpdates(false) },
    { label: 'Über Labertaschi', click: showAboutDialog },
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
  tray.setToolTip('Labertaschi');
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
    const script = previousAppName
      ? `tell application "${previousAppName}" to activate
         delay 0.3
         tell application "System Events" to keystroke "v" using command down`
      : `delay 0.2
         tell application "System Events" to keystroke "v" using command down`;

    setTimeout(() => {
      const proc = spawn('osascript', ['-e', script]);
      proc.stderr.on('data', (d) => console.error('AppleScript error:', d.toString()));
    }, 150);
  } else if (isWin) {
    // On Windows, use PowerShell with a more robust approach
    // We need to give time for the recording window to hide and previous window to regain focus
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
[System.Windows.Forms.SendKeys]::SendWait("^v")
      `.trim();
      
      // Write script to temp file and execute (avoids escaping issues)
      const tempFile = path.join(app.getPath('temp'), 'labertaschi-paste.ps1');
      fs.writeFileSync(tempFile, psScript, 'utf8');
      
      exec(`powershell -ExecutionPolicy Bypass -File "${tempFile}"`, (err, stdout, stderr) => {
        if (err) console.error('PowerShell paste error:', err);
        if (stderr) console.error('PowerShell stderr:', stderr);
        // Clean up temp file
        try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
      });
    }, 400);
  }
}

function startTranscription() {
  if (isRecording) {
    isRecording = false;
    recordingWindow?.webContents.send('recording:stop');
    recordingWindow?.hide();
  } else {
    isRecording = true;
    savePreviousApp();
    const win = createRecordingWindow();
    win.showInactive();
    win.webContents.send('recording:start');
  }
}

// ============================================================================
// HOTKEY
// ============================================================================
let currentShortcut = null;

function registerHotkey() {
  const shortcut = getStore().get('shortcut');
  if (currentShortcut) globalShortcut.unregister(currentShortcut);

  const ok = globalShortcut.register(shortcut, () => {
    console.log('Hotkey pressed:', shortcut);
    startTranscription();
  });

  if (ok) {
    currentShortcut = shortcut;
    console.log('Hotkey registered:', shortcut);
  } else {
    console.error('Hotkey registration failed:', shortcut);
  }
}

// ============================================================================
// IPC HANDLERS
// ============================================================================
function setupIpcHandlers() {
  ipcMain.handle('settings:get', () => {
    const s = getStore();
    return {
      groqApiKey: s.get('groqApiKey'),
      haikuApiKey: s.get('haikuApiKey'),
      enablePolish: s.get('enablePolish'),
      shortcut: s.get('shortcut'),
      autoStart: s.get('autoStart'),
      language: s.get('language'),
      autopaste: s.get('autopaste'),
      beepEnabled: s.get('beepEnabled'),
    };
  });

  ipcMain.handle('settings:set', (_event, settings) => {
    const s = getStore();
    if (settings.groqApiKey !== undefined) s.set('groqApiKey', settings.groqApiKey);
    if (settings.haikuApiKey !== undefined) s.set('haikuApiKey', settings.haikuApiKey);
    if (settings.enablePolish !== undefined) s.set('enablePolish', settings.enablePolish);
    if (settings.language !== undefined) s.set('language', settings.language);
    if (settings.autopaste !== undefined) s.set('autopaste', settings.autopaste);
    if (settings.beepEnabled !== undefined) s.set('beepEnabled', settings.beepEnabled);

    if (settings.shortcut !== undefined && settings.shortcut !== s.get('shortcut')) {
      s.set('shortcut', settings.shortcut);
      registerHotkey();
    }

    if (settings.autoStart !== undefined) {
      s.set('autoStart', settings.autoStart);
      updateAutoLaunch();
    }

    updateTrayMenu();
    return true;
  });

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

  ipcMain.on('recording:audio', async (_event, audioData) => {
    console.log('Received audio:', audioData.byteLength, 'bytes');
    isRecording = false;
    recordingWindow?.hide();

    try {
      const s = getStore();
      const language = s.get('language');
      const enablePolish = s.get('enablePolish');
      const haikuKey = s.get('haikuApiKey');
      const autopaste = s.get('autopaste');

      const transcript = await transcribeAudio(Buffer.from(audioData), language);
      console.log('Transcript:', transcript);

      if (!transcript) return;

      let polished = null;
      if (enablePolish && haikuKey) {
        polished = await polishText(transcript, language);
        console.log('Polished:', polished);
      }

      addToHistory({ transcript, polished, language });

      const finalText = polished || transcript;
      if (autopaste) {
        autopasteText(finalText);
      } else {
        clipboard.writeText(finalText);
      }
    } catch (error) {
      console.error('Transcription error:', error);
      dialog.showErrorBox('Fehler', error.message || 'Transkription fehlgeschlagen');
    }
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
  // Verstecke Dock-Icon
  if (app.dock) app.dock.hide();
  setupIpcHandlers();
  setupTray();
  createRecordingWindow();
  registerHotkey();
  updateAutoLaunch();

  const s = getStore();
  console.log('Labertaschi started');
  console.log('Shortcut:', s.get('shortcut'));
  console.log('Groq Key:', s.get('groqApiKey') ? 'Set' : 'Not set');
  console.log('Haiku Key:', s.get('haikuApiKey') ? 'Set' : 'Not set');

  // Auto-open settings on first run if no API key is configured
  if (!s.get('groqApiKey')) {
    setTimeout(() => {
      createSettingsWindow();
      dialog.showMessageBox({
        type: 'info',
        title: 'Willkommen bei Labertaschi!',
        message: 'API Key benötigt',
        detail: 'Bitte konfiguriere deinen Groq API Key in den Einstellungen.\n\nDu kannst einen kostenlosen API Key hier erstellen:\nhttps://console.groq.com/keys',
        buttons: ['OK'],
      });
    }, 500);
  }

  // Check for updates silently on startup (after 5 seconds)
  setTimeout(() => {
    checkForUpdates(true).then(result => {
      if (result?.hasUpdate) {
        console.log(`Update available: ${result.version}`);
      }
    });
  }, 5000);
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', (e) => { e.preventDefault(); });
