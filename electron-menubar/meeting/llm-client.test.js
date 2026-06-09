import { describe, it, expect } from 'vitest';
const { chatComplete, callGemini } = require('./llm-client.js');

// Fake-fetch, das je nach Ziel-URL eine Groq- oder Gemini-Antwort (oder einen Status) liefert.
function makeFetch({ groq, gemini } = {}) {
  return async (url) => {
    const isGemini = String(url).includes('generativelanguage.googleapis.com');
    const spec = isGemini ? gemini : groq;
    if (!spec) return { ok: false, status: 500 };
    if (spec.status && spec.status !== 200) return { ok: false, status: spec.status };
    if (isGemini) {
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: spec.text }] } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: spec.text } }] }) };
  };
}

describe('callGemini', () => {
  it('liest candidates[0].content.parts[].text', async () => {
    const r = await callGemini({ user: 'hi', apiKey: 'k', model: 'gemini-2.0-flash', fetchImpl: makeFetch({ gemini: { text: 'hallo' } }) });
    expect(r.text).toBe('hallo');
    expect(r.model).toBe('gemini-2.0-flash');
  });
});

describe('chatComplete Anbieter-Routing', () => {
  it('auto: nutzt Groq, wenn Groq-Key da ist und antwortet', async () => {
    const r = await chatComplete({ user: 'x', provider: 'auto', groqApiKey: 'g', geminiApiKey: 'gem', fetchImpl: makeFetch({ groq: { text: 'GROQ' }, gemini: { text: 'GEM' } }) });
    expect(r.text).toBe('GROQ');
  });

  it('auto: fällt bei Groq-429 auf Gemini zurück', async () => {
    const r = await chatComplete({ user: 'x', provider: 'auto', groqApiKey: 'g', geminiApiKey: 'gem', fetchImpl: makeFetch({ groq: { status: 429 }, gemini: { text: 'GEM' } }) });
    expect(r.text).toBe('GEM');
  });

  it('auto: nutzt Gemini, wenn nur Gemini-Key gesetzt ist', async () => {
    const r = await chatComplete({ user: 'x', provider: 'auto', geminiApiKey: 'gem', fetchImpl: makeFetch({ gemini: { text: 'GEM' } }) });
    expect(r.text).toBe('GEM');
  });

  it('gemini: erzwingt Gemini auch bei vorhandenem Groq-Key', async () => {
    const r = await chatComplete({ user: 'x', provider: 'gemini', groqApiKey: 'g', geminiApiKey: 'gem', fetchImpl: makeFetch({ groq: { text: 'GROQ' }, gemini: { text: 'GEM' } }) });
    expect(r.text).toBe('GEM');
  });

  it('ohne Keys → Fehler', async () => {
    await expect(chatComplete({ user: 'x', provider: 'auto' })).rejects.toThrow(/Kein LLM-Anbieter/);
  });

  it('auto: nur Groq-Key + 429 + kein Gemini → rate_limit', async () => {
    await expect(chatComplete({ user: 'x', provider: 'auto', groqApiKey: 'g', fetchImpl: makeFetch({ groq: { status: 429 } }) }))
      .rejects.toMatchObject({ code: 'rate_limit' });
  });
});
