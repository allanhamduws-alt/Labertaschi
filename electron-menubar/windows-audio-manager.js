'use strict';
// WindowsAudioManager — Pendant zu AudioTeeManager für die System-Audio-Aufnahme
// unter Windows. Bietet dieselbe EventEmitter-Schnittstelle (start/stop/isRunning,
// Events 'pcm'|'started'|'stopped'|'error'|'log'), damit der MeetingController
// plattform-agnostisch bleibt und unverändert weiterläuft.
//
// Anders als AudioTee (Subprozess im Main) läuft die Loopback-Aufnahme unter Windows
// im RENDERER (WebRTC/AudioWorklet gibt es nur dort): Das Meeting-Overlay greift den
// System-Mix via getDisplayMedia({ audio: true }) ab — der Display-Media-Handler im
// Main liefert audio:'loopback' — und schickt 16-bit-PCM per IPC. Dieser Manager
// empfängt die Chunks (onSystemPcm) und emittiert sie als 'pcm'. start()/stop()
// spiegeln nur den Laufzustand; die eigentliche Aufnahme startet/stoppt das Overlay
// über die vom Controller emittierten meeting:started/stopped-Events.
//
// macOS/Linux: isSupported=false → start() ist no-op (dort übernimmt AudioTeeManager).

const EventEmitter = require('node:events');

class WindowsAudioManager extends EventEmitter {
  constructor() {
    super();
    this.isSupported = process.platform === 'win32';
    this._running = false;
  }

  /** Vom Controller aufgerufen. opts (z.B. excludeProcesses) sind unter Windows irrelevant. */
  start() {
    if (!this.isSupported || this._running) return;
    this._running = true;
    this.emit('started');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    this.emit('stopped');
  }

  get isRunning() {
    return this._running;
  }

  /** Vom Main-IPC-Handler aufgerufen, wenn das Overlay einen System-PCM-Chunk schickt. */
  onSystemPcm(buf) {
    if (!this._running) return;
    this.emit('pcm', buf);
  }
}

module.exports = WindowsAudioManager;
