import { describe, it, expect } from 'vitest';
const WindowsAudioManager = require('../windows-audio-manager.js');

describe('WindowsAudioManager', () => {
  it('isSupported entspricht der Plattform', () => {
    const m = new WindowsAudioManager();
    expect(m.isSupported).toBe(process.platform === 'win32');
  });

  it('start/stop togglen isRunning und emittieren started/stopped', () => {
    const m = new WindowsAudioManager();
    m.isSupported = true; // Verhalten plattformunabhängig testen
    const events = [];
    m.on('started', () => events.push('started'));
    m.on('stopped', () => events.push('stopped'));
    expect(m.isRunning).toBe(false);
    m.start();
    expect(m.isRunning).toBe(true);
    m.start(); // doppelter Start ist no-op
    m.stop();
    expect(m.isRunning).toBe(false);
    expect(events).toEqual(['started', 'stopped']);
  });

  it('onSystemPcm emittiert pcm nur während running', () => {
    const m = new WindowsAudioManager();
    m.isSupported = true;
    const chunks = [];
    m.on('pcm', (b) => chunks.push(b));
    m.onSystemPcm(Buffer.from([1, 2])); // vor start → ignoriert
    m.start();
    m.onSystemPcm(Buffer.from([3, 4]));
    m.stop();
    m.onSystemPcm(Buffer.from([5, 6])); // nach stop → ignoriert
    expect(chunks.length).toBe(1);
    expect(Array.from(chunks[0])).toEqual([3, 4]);
  });

  it('start ist no-op wenn nicht unterstützt', () => {
    const m = new WindowsAudioManager();
    m.isSupported = false;
    m.start();
    expect(m.isRunning).toBe(false);
  });
});
