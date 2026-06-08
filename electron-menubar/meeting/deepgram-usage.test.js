import { describe, it, expect } from 'vitest';
const {
  DEEPGRAM_RATES,
  wavDurationSeconds,
  estimateDeepgramCostUsd,
  monthKey,
  emptyUsage,
  accumulateUsage,
} = require('./deepgram-usage.js');

describe('wavDurationSeconds', () => {
  it('berechnet 1 s aus 16 kHz mono 16-bit (44 + 32000 Bytes)', () => {
    expect(wavDurationSeconds(44 + 32000)).toBeCloseTo(1.0, 6);
  });
  it('reiner Header (44 Bytes) → 0 s', () => {
    expect(wavDurationSeconds(44)).toBe(0);
  });
  it('kleiner als Header → 0 s (kein negativer Wert)', () => {
    expect(wavDurationSeconds(10)).toBe(0);
    expect(wavDurationSeconds(0)).toBe(0);
  });
  it('respektiert abweichende Sample-Rate', () => {
    expect(wavDurationSeconds(44 + 16000, { sampleRate: 8000 })).toBeCloseTo(1.0, 6);
  });
});

describe('estimateDeepgramCostUsd', () => {
  it('60 s multilingual + Diarization = (0.0092 + 0.0020) USD', () => {
    expect(estimateDeepgramCostUsd(60, { multilingual: true, diarize: true }))
      .toBeCloseTo(DEEPGRAM_RATES.baseMultilingualPerMin + DEEPGRAM_RATES.diarizePerMin, 6);
  });
  it('60 s monolingual ohne Diarization = 0.0077 USD', () => {
    expect(estimateDeepgramCostUsd(60, { multilingual: false, diarize: false }))
      .toBeCloseTo(DEEPGRAM_RATES.baseMonolingualPerMin, 6);
  });
  it('0 s → 0 USD; negative Sekunden → 0', () => {
    expect(estimateDeepgramCostUsd(0)).toBe(0);
    expect(estimateDeepgramCostUsd(-5)).toBe(0);
  });
  it('skaliert linear (120 s = doppelt 60 s)', () => {
    const a = estimateDeepgramCostUsd(60);
    const b = estimateDeepgramCostUsd(120);
    expect(b).toBeCloseTo(a * 2, 9);
  });
});

describe('monthKey', () => {
  it("formatiert als 'YYYY-MM' mit führender Null", () => {
    expect(monthKey(new Date(2026, 5, 8))).toBe('2026-06');
    expect(monthKey(new Date(2026, 11, 31))).toBe('2026-12');
  });
});

describe('accumulateUsage', () => {
  it('startet von null und summiert Total + perMonth', () => {
    const u = accumulateUsage(null, { seconds: 120, costUsd: 0.0224, month: '2026-06' });
    expect(u.totalSeconds).toBe(120);
    expect(u.totalRequests).toBe(1);
    expect(u.totalCostUsd).toBeCloseTo(0.0224, 6);
    expect(u.perMonth['2026-06']).toEqual({ seconds: 120, costUsd: 0.0224, requests: 1 });
  });

  it('akkumuliert mehrere Calls im selben Monat', () => {
    let u = accumulateUsage(emptyUsage(), { seconds: 60, costUsd: 0.0112, month: '2026-06' });
    u = accumulateUsage(u, { seconds: 60, costUsd: 0.0112, month: '2026-06' });
    expect(u.totalSeconds).toBe(120);
    expect(u.totalRequests).toBe(2);
    expect(u.perMonth['2026-06'].requests).toBe(2);
  });

  it('trennt verschiedene Monate', () => {
    let u = accumulateUsage(null, { seconds: 60, costUsd: 0.01, month: '2026-06' });
    u = accumulateUsage(u, { seconds: 30, costUsd: 0.005, month: '2026-07' });
    expect(Object.keys(u.perMonth).sort()).toEqual(['2026-06', '2026-07']);
    expect(u.totalSeconds).toBe(90);
  });

  it('lässt prev unverändert (immutabel)', () => {
    const prev = emptyUsage();
    accumulateUsage(prev, { seconds: 60, costUsd: 0.01, month: '2026-06' });
    expect(prev.totalSeconds).toBe(0);
    expect(prev.perMonth).toEqual({});
  });
});
