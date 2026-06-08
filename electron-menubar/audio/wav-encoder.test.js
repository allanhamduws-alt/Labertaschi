import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { encodeWav, concatWav, concatWavFiles } from './wav-encoder.js';

describe('encodeWav', () => {
  it('schreibt einen 44-Byte-RIFF/WAVE-Header + PCM-Daten', () => {
    const pcm = Buffer.from(new Int16Array([0, 1000, -1000, 32767]).buffer);
    const wav = encodeWav(pcm, { sampleRate: 16000, channels: 1 });
    expect(wav.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.slice(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000); // sampleRate
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt16LE(34)).toBe(16); // bitsPerSample
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.slice(44)).toEqual(pcm);
  });
});

describe('concatWavFiles (streaming)', () => {
  it('fügt mehrere WAV-Dateien zu einer korrekten WAV zusammen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-wav-'));
    const pcmA = Buffer.from(new Int16Array([1, 2, 3]).buffer);
    const pcmB = Buffer.from(new Int16Array([4, 5]).buffer);
    const a = path.join(dir, 'a.wav');
    const b = path.join(dir, 'b.wav');
    const out = path.join(dir, 'out.wav');
    fs.writeFileSync(a, encodeWav(pcmA, { sampleRate: 16000, channels: 1 }));
    fs.writeFileSync(b, encodeWav(pcmB, { sampleRate: 16000, channels: 1 }));

    const dataLen = concatWavFiles([a, b], out, { sampleRate: 16000, channels: 1 });

    const result = fs.readFileSync(out);
    expect(result.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(result.slice(8, 12).toString('ascii')).toBe('WAVE');
    expect(dataLen).toBe(pcmA.length + pcmB.length);
    expect(result.readUInt32LE(40)).toBe(pcmA.length + pcmB.length); // data size
    expect(result.readUInt32LE(4)).toBe(36 + pcmA.length + pcmB.length); // RIFF size
    expect(result.length).toBe(44 + pcmA.length + pcmB.length);
    // PCM-Inhalt = A gefolgt von B (Streaming-Konkatenation, identisch zu concatWav)
    expect(result.slice(44)).toEqual(Buffer.concat([pcmA, pcmB]));
    // gleiches Ergebnis wie die In-Memory-Variante
    expect(result).toEqual(concatWav([pcmA, pcmB], { sampleRate: 16000, channels: 1 }));
  });

  it('überspringt leere/kaputte Dateien (<= 44 Byte)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-wav2-'));
    const pcmA = Buffer.from(new Int16Array([7, 8]).buffer);
    const a = path.join(dir, 'a.wav');
    const empty = path.join(dir, 'empty.wav');
    const out = path.join(dir, 'out.wav');
    fs.writeFileSync(a, encodeWav(pcmA, {}));
    fs.writeFileSync(empty, Buffer.alloc(20)); // kaputt
    const dataLen = concatWavFiles([empty, a], out, {});
    expect(dataLen).toBe(pcmA.length);
    expect(fs.readFileSync(out).slice(44)).toEqual(pcmA);
  });
});
