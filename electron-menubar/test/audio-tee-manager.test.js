import { describe, it, expect } from 'vitest';
const { buildArgs, parseLogLine } = require('../audio-tee-manager.js');

describe('AudioTeeManager.buildArgs', () => {
  it('setzt Sample-Rate und Exclude-Prozesse (Plural-Flag)', () => {
    expect(buildArgs({ sampleRate: 16000, excludeProcesses: [4242] })).toEqual([
      '--sample-rate', '16000', '--exclude-processes', '4242',
    ]);
  });
  it('rechnet chunkDurationMs in Sekunden um', () => {
    expect(buildArgs({ chunkDurationMs: 200 })).toEqual(['--chunk-duration', '0.2']);
  });
  it('ohne Optionen leeres Array', () => {
    expect(buildArgs()).toEqual([]);
  });
});

describe('AudioTeeManager.parseLogLine', () => {
  it('erkennt stream_start/stop', () => {
    expect(parseLogLine('{"message_type":"stream_start"}').kind).toBe('started');
    expect(parseLogLine('{"message_type":"stream_stop"}').kind).toBe('stopped');
  });
  it('erkennt Fehler mit Nachricht', () => {
    const r = parseLogLine('{"message_type":"error","data":{"message":"Permission denied"}}');
    expect(r.kind).toBe('error');
    expect(r.message).toBe('Permission denied');
  });
  it('erkennt Logzeilen', () => {
    const r = parseLogLine('{"message_type":"info","data":{"message":"x"}}');
    expect(r.kind).toBe('log');
    expect(r.level).toBe('info');
  });
  it('ignoriert ungültiges JSON und Leerzeilen', () => {
    expect(parseLogLine('nicht json').kind).toBe('ignore');
    expect(parseLogLine('   ').kind).toBe('ignore');
  });
});
