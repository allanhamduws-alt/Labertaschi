import { describe, it, expect } from 'vitest';
const { parseLine, isCallActive } = require('../call-detector-manager.js');

describe('CallDetectorManager.parseLine', () => {
  it('erkennt started', () => {
    expect(parseLine('{"message_type":"started"}')).toEqual({ kind: 'started' });
  });
  it('erkennt input_state mit Bundles', () => {
    expect(parseLine('{"message_type":"input_state","data":{"bundles":["net.whatsapp.WhatsApp"]}}'))
      .toEqual({ kind: 'input_state', bundles: ['net.whatsapp.WhatsApp'] });
  });
  it('input_state ohne data → leere Bundles', () => {
    expect(parseLine('{"message_type":"input_state"}')).toEqual({ kind: 'input_state', bundles: [] });
  });
  it('erkennt error', () => {
    expect(parseLine('{"message_type":"error","data":{"message":"x"}}')).toEqual({ kind: 'error', message: 'x' });
  });
  it('Müll/leer → ignore', () => {
    expect(parseLine('kein json').kind).toBe('ignore');
    expect(parseLine('').kind).toBe('ignore');
    expect(parseLine('{"message_type":"debug"}').kind).toBe('ignore');
  });
});

describe('CallDetectorManager.isCallActive', () => {
  it('fremde App am Mikro = Anruf', () => {
    expect(isCallActive(['net.whatsapp.WhatsApp'])).toBe(true);
    expect(isCallActive(['us.zoom.xos'])).toBe(true);
    expect(isCallActive(['com.apple.FaceTime'])).toBe(true); // FaceTime IST ein Anruf
  });
  it('nur Paply selbst am Mikro = kein Anruf', () => {
    expect(isCallActive(['com.paply.menubar.helper'])).toBe(false);
    expect(isCallActive(['com.paply.menubar.helper.Plugin'])).toBe(false);
    expect(isCallActive(['com.github.Electron.helper'])).toBe(false); // Dev-Modus
  });
  it('passive Apple-Sprach-Daemons zählen nicht als Anruf', () => {
    expect(isCallActive(['com.apple.corespeechd'])).toBe(false);
    expect(isCallActive(['com.apple.assistantd'])).toBe(false);
    expect(isCallActive(['com.apple.Siri.embedded'])).toBe(false);
  });
  it('leere Liste / leere Bundles = kein Anruf', () => {
    expect(isCallActive([])).toBe(false);
    expect(isCallActive([''])).toBe(false);
  });
  it('Paply + fremde App gleichzeitig = Anruf', () => {
    expect(isCallActive(['com.paply.menubar.helper', 'net.whatsapp.WhatsApp'])).toBe(true);
  });
});
