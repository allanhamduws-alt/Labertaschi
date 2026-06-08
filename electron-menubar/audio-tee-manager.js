/**
 * AudioTeeManager — verwaltet den gebündelten AudioTee-Swift-Binary-Subprozess
 * für die macOS-System-Audio-Aufnahme (Core Audio Process Taps, macOS >= 14.2).
 * Vorbild: globe-key-manager.js. Nur macOS; no-op auf anderen Plattformen.
 *
 * stdout des Binaries = rohes PCM (16-bit signed int LE, mono, bei gesetzter
 * sampleRate) → Event 'pcm' (Buffer).
 * stderr = newline-getrennte JSON-Logzeilen mit message_type:
 *   stream_start → 'started' · stream_stop → 'stopped' · error → 'error'
 *   info|debug   → 'log'
 *
 * CLI-Flags (verifiziert gegen audiotee@0.0.7 dist/index.js):
 *   --sample-rate <n> · --chunk-duration <sekunden> · --mute
 *   --include-processes <pid...> · --exclude-processes <pid...>
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const EventEmitter = require('node:events');

/** Baut die CLI-Argumente. Reine Funktion (testbar). */
function buildArgs({ sampleRate, chunkDurationMs, mute, includeProcesses, excludeProcesses } = {}) {
  const args = [];
  if (sampleRate !== undefined) args.push('--sample-rate', String(sampleRate));
  if (chunkDurationMs !== undefined) args.push('--chunk-duration', String(chunkDurationMs / 1000));
  if (mute) args.push('--mute');
  if (includeProcesses && includeProcesses.length > 0) {
    args.push('--include-processes', ...includeProcesses.map(String));
  }
  if (excludeProcesses && excludeProcesses.length > 0) {
    args.push('--exclude-processes', ...excludeProcesses.map(String));
  }
  return args;
}

/**
 * Klassifiziert eine einzelne stderr-Zeile. Reine Funktion (testbar).
 * @returns {{ kind: 'started'|'stopped'|'error'|'log'|'ignore', message?: string, level?: string, data?: object }}
 */
function parseLogLine(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return { kind: 'ignore' };
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return { kind: 'ignore' };
  }
  switch (msg.message_type) {
    case 'stream_start':
      return { kind: 'started' };
    case 'stream_stop':
      return { kind: 'stopped' };
    case 'error':
      return { kind: 'error', message: (msg.data && msg.data.message) || 'AudioTee error' };
    case 'info':
    case 'debug':
      return { kind: 'log', level: msg.message_type, data: msg.data };
    default:
      return { kind: 'ignore' };
  }
}

class AudioTeeManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isSupported = process.platform === 'darwin';
  }

  /** @param {{sampleRate?:number, chunkDurationMs?:number, excludeProcesses?:number[]}} opts */
  start(opts = {}) {
    if (!this.isSupported || this.process) return;

    const bin = this._resolveBinary();
    if (!bin) {
      this.emit('error', new Error('AudioTee-Binary nicht gefunden — npm run compile:audio-tee ausführen'));
      return;
    }
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      try { fs.chmodSync(bin, 0o755); } catch (err) {
        this.emit('error', new Error(`AudioTee-Binary nicht ausführbar: ${err.message}`));
        return;
      }
    }

    this.process = spawn(bin, buildArgs(opts), { stdio: ['ignore', 'pipe', 'pipe'] });

    // stdout = rohes PCM
    this.process.stdout.on('data', (buf) => this.emit('pcm', buf));

    // stderr = JSON-Logzeilen (zeilengepuffert)
    let stderrBuf = '';
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop(); // Rest (unvollständige Zeile) behalten
      for (const line of lines) {
        const parsed = parseLogLine(line);
        if (parsed.kind === 'started') this.emit('started');
        else if (parsed.kind === 'stopped') this.emit('stopped');
        else if (parsed.kind === 'error') this.emit('error', new Error(parsed.message));
        else if (parsed.kind === 'log') this.emit('log', parsed.level, parsed.data);
      }
    });

    this.process.on('error', (err) => { this.emit('error', err); this.process = null; });
    this.process.on('exit', () => { this.process = null; this.emit('stopped'); });
  }

  stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  get isRunning() {
    return this.process !== null;
  }

  _resolveBinary() {
    const candidates = [
      // Entwicklung: bereitgestellt durch scripts/build-audio-tee.js
      path.join(__dirname, 'resources', 'bin', 'audiotee'),
      // Verpackte App: extraResources
      ...(process.resourcesPath
        ? [
            path.join(process.resourcesPath, 'bin', 'audiotee'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'bin', 'audiotee'),
          ]
        : []),
      // Fallback: das von npm gelieferte Binary
      path.join(__dirname, 'node_modules', 'audiotee', 'bin', 'audiotee'),
    ];
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) return c; } catch { /* weiter */ }
    }
    return null;
  }
}

module.exports = AudioTeeManager;
module.exports.buildArgs = buildArgs;
module.exports.parseLogLine = parseLogLine;
