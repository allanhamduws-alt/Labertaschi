/**
 * CallDetectorManager — verwaltet den gebündelten macos-call-detector-Swift-Subprozess.
 * Vorbild: audio-tee-manager.js. Nur macOS; no-op auf anderen Plattformen.
 *
 * Der Swift-Helfer meldet auf stdout (JSON-Zeilen), WELCHE Prozesse gerade das Mikrofon nutzen.
 * Dieser Manager entscheidet daraus (reine Funktion `isCallActive`, testbar), ob ein ANDERER
 * Prozess als Paply das Mikro nutzt = sehr wahrscheinlich ein Anruf auf diesem Mac. Er emittiert
 * 'call-state' (bool) bei jedem Zustandswechsel.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const EventEmitter = require('node:events');

// Paply selbst (Hauptprozess + Helper wie com.paply.menubar.helper[.Plugin]) wird ausgeschlossen.
const DEFAULT_EXCLUDE_PREFIXES = ['com.paply.menubar', 'com.github.Electron'];
// Apple-Daemons, die passiv „mithören" (Siri/Diktat/VoiceOver) — KEINE Anruf-Apps. FaceTime
// (com.apple.FaceTime) ist bewusst NICHT hier, das ist ein echter Anruf.
const DEFAULT_DENYLIST = [
  'com.apple.corespeechd', 'com.apple.CoreSpeech', 'com.apple.assistantd',
  'com.apple.Siri', 'com.apple.siri', 'com.apple.accessibility.heard',
  'systemsoundserverd', 'com.apple.audio.SandboxHelper',
];

/** Klassifiziert eine stdout-Zeile des Detektors. Reine Funktion (testbar). */
function parseLine(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return { kind: 'ignore' };
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return { kind: 'ignore' }; }
  switch (msg.message_type) {
    case 'started': return { kind: 'started' };
    case 'input_state': return { kind: 'input_state', bundles: (msg.data && msg.data.bundles) || [] };
    case 'error': return { kind: 'error', message: (msg.data && msg.data.message) || 'call-detector error' };
    default: return { kind: 'ignore' };
  }
}

/**
 * Entscheidet, ob die Mic-Nutzer-Liste einen Anruf bedeutet: ein Bundle, das WEDER zu Paply
 * gehört (excludePrefixes) NOCH ein passiver Apple-Sprach-Daemon (denylist) ist. Reine Funktion.
 */
function isCallActive(bundles = [], { excludePrefixes = DEFAULT_EXCLUDE_PREFIXES, denylist = DEFAULT_DENYLIST } = {}) {
  return bundles.some((b) => {
    if (!b) return false;
    if (excludePrefixes.some((p) => b.startsWith(p))) return false;
    if (denylist.some((d) => b === d || b.startsWith(d + '.'))) return false;
    return true; // fremder Mic-Nutzer → Anruf
  });
}

class CallDetectorManager extends EventEmitter {
  constructor({ excludePrefixes, denylist } = {}) {
    super();
    this.process = null;
    this.isSupported = process.platform === 'darwin';
    this.excludePrefixes = excludePrefixes || DEFAULT_EXCLUDE_PREFIXES;
    this.denylist = denylist || DEFAULT_DENYLIST;
    this._lastActive = false;
  }

  start() {
    if (!this.isSupported || this.process) return;
    const bin = this._resolveBinary();
    if (!bin) { this.emit('error', new Error('call-detector-Binary nicht gefunden — npm run compile:call-detector')); return; }
    try { fs.accessSync(bin, fs.constants.X_OK); } catch { try { fs.chmodSync(bin, 0o755); } catch { /* best effort */ } }

    this._lastActive = false;
    this.process = spawn(bin, ['--interval', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });

    let buf = '';
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed.kind === 'input_state') {
          const active = isCallActive(parsed.bundles, { excludePrefixes: this.excludePrefixes, denylist: this.denylist });
          if (active !== this._lastActive) { this._lastActive = active; this.emit('call-state', active); }
        } else if (parsed.kind === 'error') {
          this.emit('error', new Error(parsed.message));
        }
      }
    });

    this.process.on('error', (err) => { this.emit('error', err); this.process = null; });
    this.process.on('exit', () => { this.process = null; });
  }

  stop() {
    if (this.process) { this.process.kill('SIGTERM'); this.process = null; }
    this._lastActive = false;
  }

  get isRunning() { return this.process !== null; }

  _resolveBinary() {
    const candidates = [
      path.join(__dirname, 'resources', 'bin', 'macos-call-detector'),
      ...(process.resourcesPath
        ? [
            path.join(process.resourcesPath, 'bin', 'macos-call-detector'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'bin', 'macos-call-detector'),
          ]
        : []),
    ];
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) return c; } catch { /* weiter */ }
    }
    return null;
  }
}

module.exports = CallDetectorManager;
module.exports.parseLine = parseLine;
module.exports.isCallActive = isCallActive;
module.exports.DEFAULT_EXCLUDE_PREFIXES = DEFAULT_EXCLUDE_PREFIXES;
module.exports.DEFAULT_DENYLIST = DEFAULT_DENYLIST;
