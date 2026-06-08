import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
const { buildOpusArgs, buildDecodeArgs, compressToOpus, decodeToWav, DEFAULT_BITRATE_K } = require('./audio-compress.js');

describe('buildOpusArgs', () => {
  it('baut libopus-Argumente mit Default-Bitrate (mono, voip)', () => {
    const a = buildOpusArgs('in.wav', 'out.opus');
    expect(a).toContain('-i'); expect(a).toContain('in.wav'); expect(a).toContain('out.opus');
    expect(a).toContain('libopus');
    expect(a).toContain(`${DEFAULT_BITRATE_K}k`);
    expect(a).toContain('voip');
    expect(a[a.length - 1]).toBe('out.opus');
  });
  it('respektiert eine eigene Bitrate', () => {
    expect(buildOpusArgs('i', 'o', { bitrateK: 24 })).toContain('24k');
  });
});

describe('buildDecodeArgs', () => {
  it('dekodiert nach 16 kHz mono pcm_s16le', () => {
    const a = buildDecodeArgs('in.opus', 'out.wav');
    expect(a).toContain('pcm_s16le');
    expect(a.join(' ')).toContain('-ar 16000');
    expect(a.join(' ')).toContain('-ac 1');
  });
});

function fakeSpawn(exitCode, { throwOnSpawn = false } = {}) {
  return () => {
    if (throwOnSpawn) throw new Error('ENOENT');
    const p = new EventEmitter();
    p.stderr = new EventEmitter();
    queueMicrotask(() => p.emit('exit', exitCode));
    return p;
  };
}

describe('compressToOpus / decodeToWav (Wrapper)', () => {
  it('resolved true bei Exit-Code 0', async () => {
    expect(await compressToOpus('i', 'o', { ffmpegPath: 'ffmpeg', spawnImpl: fakeSpawn(0) })).toBe(true);
  });
  it('resolved false bei Exit-Code != 0', async () => {
    expect(await decodeToWav('i', 'o', { ffmpegPath: 'ffmpeg', spawnImpl: fakeSpawn(1) })).toBe(false);
  });
  it('resolved false (wirft nicht), wenn spawn fehlschlägt', async () => {
    expect(await compressToOpus('i', 'o', { ffmpegPath: 'x', spawnImpl: fakeSpawn(0, { throwOnSpawn: true }) })).toBe(false);
  });
});
