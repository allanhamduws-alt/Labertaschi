import { describe, it, expect } from 'vitest';
const { diarizeLocal, segmentPitch, pitchClusters } = require('./diarize-local.js');

const SR = 16000;
// Sinus-Ton als 16-bit-PCM (deterministisch, bekannte Grundfrequenz).
function tone(freq, seconds, amp = 8000) {
  const n = Math.floor(seconds * SR);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / SR));
  return a;
}
function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Int16Array(total);
  let off = 0; for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

describe('pitchClusters (reine Funktion)', () => {
  it('trennt zwei klar verschiedene Tonhöhen-Gruppen', () => {
    const c = pitchClusters([100, 102, 105, 150, 155, 160]);
    expect(new Set(c).size).toBe(2);
    // tiefe und hohe Gruppe je eigener Cluster
    expect(c[0]).toBe(c[1]); expect(c[1]).toBe(c[2]);
    expect(c[3]).toBe(c[4]); expect(c[4]).toBe(c[5]);
    expect(c[0]).not.toBe(c[3]);
  });
  it('lässt eine enge Tonhöhen-Verteilung als EINEN Sprecher (kein Über-Split)', () => {
    expect(new Set(pitchClusters([107, 108, 110, 113, 116, 118, 121, 124])).size).toBe(1);
  });
  it('respektiert maxSpeakers', () => {
    const c = pitchClusters([80, 120, 170, 230], { maxSpeakers: 2 });
    expect(new Set(c).size).toBeLessThanOrEqual(2);
  });
});

describe('segmentPitch', () => {
  it('erkennt die Grundfrequenz eines Sinus (~120 Hz)', () => {
    const p = segmentPitch(tone(120, 0.6), SR);
    expect(p).toBeGreaterThan(110);
    expect(p).toBeLessThan(130);
  });
  it('erkennt eine höhere Stimme (~200 Hz)', () => {
    const p = segmentPitch(tone(200, 0.6), SR);
    expect(p).toBeGreaterThan(185);
    expect(p).toBeLessThan(215);
  });
});

describe('diarizeLocal', () => {
  it('trennt zwei verschiedene Stimmen in 2 Sprecher (Single-Mikro-Fall)', () => {
    const pcm = concat(tone(120, 1), tone(200, 1), tone(120, 1));
    const segs = [
      { tStart: 0, tEnd: 1, text: 'tief eins' },
      { tStart: 1, tEnd: 2, text: 'hoch' },
      { tStart: 2, tEnd: 3, text: 'tief zwei' },
    ];
    const r = diarizeLocal(segs, pcm, { sampleRate: SR });
    expect(new Set(r.map((s) => s.speaker)).size).toBe(2);
    expect(r[0].speaker).toBe(r[2].speaker);     // beide tiefen Segmente = selber Sprecher
    expect(r[0].speaker).not.toBe(r[1].speaker);  // tief != hoch
    expect(r.map((s) => s.text)).toEqual(['tief eins', 'hoch', 'tief zwei']); // TEXT bleibt erhalten
  });

  it('lässt einen einzelnen Sprecher als 1 Sprecher (kein fälschliches Splitten)', () => {
    const pcm = concat(tone(118, 1), tone(122, 1), tone(115, 1));
    const segs = [
      { tStart: 0, tEnd: 1, text: 'a' }, { tStart: 1, tEnd: 2, text: 'b' }, { tStart: 2, tEnd: 3, text: 'c' },
    ];
    expect(new Set(diarizeLocal(segs, pcm, { sampleRate: SR }).map((s) => s.speaker)).size).toBe(1);
  });

  it('faltet Oktavfehler-Ausreißer zurück (kein Schein-Sprecher)', () => {
    // vier tiefe Segmente + ein einzelner Ausreißer bei doppelter Frequenz (Oktavfehler)
    const pcm = concat(tone(120, 1), tone(120, 1), tone(240, 1), tone(120, 1), tone(120, 1));
    const segs = [0, 1, 2, 3, 4].map((i) => ({ tStart: i, tEnd: i + 1, text: 's' + i }));
    expect(new Set(diarizeLocal(segs, pcm, { sampleRate: SR }).map((s) => s.speaker)).size).toBe(1);
  });

  it('leeres/kein Audio → ein Sprecher, robust', () => {
    expect(diarizeLocal([], new Int16Array(0), { sampleRate: SR })).toEqual([]);
    const r = diarizeLocal([{ tStart: 0, tEnd: 1, text: 'x' }], new Int16Array(10), { sampleRate: SR });
    expect(r[0].speaker).toBe('me'); // einzelner Mikro-Sprecher = „Ich"
  });

  it('labelt den ZUERST sprechenden Mikro-Cluster als „Ich" (unabhängig von der Lautstärke)', () => {
    // hohe Stimme zuerst (auch leiser), tiefe danach → wer zuerst spricht = „Ich"
    const pcm = concat(tone(200, 1, 4000), tone(120, 1, 12000));
    const segs = [
      { tStart: 0, tEnd: 1, text: 'zuerst' },
      { tStart: 1, tEnd: 2, text: 'danach' },
    ];
    const r = diarizeLocal(segs, pcm, { sampleRate: SR, channel: 'mic' });
    expect(r[0].speaker).toBe('me');          // wer zuerst spricht = Ich
    expect(r[1].speaker).toBe('Sprecher 2');
  });

  it('labelt den System-Kanal als Gegenstelle(n)', () => {
    const pcm = concat(tone(120, 1), tone(200, 1));
    const segs = [
      { tStart: 0, tEnd: 1, text: 'gegenstelle a' },
      { tStart: 1, tEnd: 2, text: 'gegenstelle b' },
    ];
    const r = diarizeLocal(segs, pcm, { sampleRate: SR, channel: 'system' });
    const labels = new Set(r.map((s) => s.speaker));
    expect(labels.has('other')).toBe(true);        // erste Gegenstelle
    expect(labels.has('Gegenstelle 2')).toBe(true); // zweite Gegenstelle
    expect(labels.has('me')).toBe(false);           // nie „Ich" auf dem System-Kanal
  });

  it('einzelner System-Sprecher = „Gegenstelle" (other)', () => {
    const pcm = concat(tone(118, 1), tone(121, 1));
    const segs = [{ tStart: 0, tEnd: 1, text: 'a' }, { tStart: 1, tEnd: 2, text: 'b' }];
    const r = diarizeLocal(segs, pcm, { sampleRate: SR, channel: 'system' });
    expect(new Set(r.map((s) => s.speaker))).toEqual(new Set(['other']));
  });
});
