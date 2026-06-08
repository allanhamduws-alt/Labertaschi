import { describe, it, expect } from 'vitest';
const { getMeetingSummaryPrompt, parseSummaryJson, generateMeetingSummary } = require('./summary.js');

describe('summary', () => {
  it('Prompt enthält die 4 Rubriken und das Transkript', () => {
    const p = getMeetingSummaryPrompt('Max: Hallo', 'de');
    expect(p).toContain('kurzzusammenfassung');
    expect(p).toContain('kernpunkte');
    expect(p).toContain('todos');
    expect(p).toContain('offeneFragen');
    expect(p).toContain('Max: Hallo');
  });
  it('parseSummaryJson liest JSON aus ```json-Fences', () => {
    const raw = '```json\n{"kurzzusammenfassung":"X","kernpunkte":["A"],"todos":[],"offeneFragen":[]}\n```';
    const s = parseSummaryJson(raw);
    expect(s.kurzzusammenfassung).toBe('X');
    expect(s.kernpunkte).toEqual(['A']);
    expect(Array.isArray(s.todos)).toBe(true);
  });
  it('generateMeetingSummary ruft Groq und parst', async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"kurzzusammenfassung":"Z","kernpunkte":[],"todos":[],"offeneFragen":[]}' } }] }) });
    const s = await generateMeetingSummary('T', { apiKey: 'k', model: 'llama-3.3-70b-versatile', language: 'de', fetchImpl: fakeFetch });
    expect(s.kurzzusammenfassung).toBe('Z');
    expect(s.model).toBe('llama-3.3-70b-versatile');
  });
});
