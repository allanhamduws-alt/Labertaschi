import { describe, it, expect } from 'vitest';
const { evaluateHealth } = require('./health-monitor.js');

const base = { micWriteOk: true, systemProcessAlive: true, systemPermissionDenied: false, diskError: false, micLevel: 0.2, systemLevel: 0.2, secondsSinceSystemAudio: 0 };

describe('evaluateHealth', () => {
  it('grün im Normalfall', () => { expect(evaluateHealth(base).color).toBe('green'); });
  it('rot bei fehlender Systemaudio-Berechtigung', () => {
    expect(evaluateHealth({ ...base, systemPermissionDenied: true }).color).toBe('red');
  });
  it('rot wenn Mic nicht gesichert wird', () => {
    expect(evaluateHealth({ ...base, micWriteOk: false }).color).toBe('red');
  });
  it('gelb bei langer System-Stille', () => {
    expect(evaluateHealth({ ...base, secondsSinceSystemAudio: 90 }).color).toBe('yellow');
  });
});
