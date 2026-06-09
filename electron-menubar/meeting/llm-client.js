'use strict';
// Gemeinsamer LLM-Client für Meeting-Aufgaben (Protokoll + Sprecher-Korrektur). Unterstützt
// ZWEI Anbieter — Groq (schnell) und Google Gemini (großzügigeres Free-Tier) — mit Auto-Fallback:
// 'auto' (Default) probiert Groq zuerst und fällt bei Limit/Fehler/fehlendem Key auf Gemini zurück,
// damit das Protokoll auch dann zustande kommt, wenn Groqs Tageslimit erschöpft ist. 'groq'/'gemini'
// erzwingen einen Anbieter. Gibt { text, model } zurück. Bei 429 hat der Fehler code='rate_limit'.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGroq({ system, user, jsonMode, maxTokens, temperature, apiKey, model, fetchImpl }) {
  const fetch = fetchImpl || globalThis.fetch;
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    const e = new Error(`Groq HTTP ${res.status}`);
    if (res.status === 429) e.code = 'rate_limit';
    throw e;
  }
  const data = await res.json();
  return { text: (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '', model };
}

async function callGemini({ system, user, jsonMode, maxTokens, temperature, apiKey, model, fetchImpl }) {
  const fetch = fetchImpl || globalThis.fetch;
  const url = `${GEMINI_BASE}/${model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = new Error(`Gemini HTTP ${res.status}`);
    if (res.status === 429) e.code = 'rate_limit';
    throw e;
  }
  const data = await res.json();
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return { text: parts.map((p) => (p && p.text) || '').join(''), model };
}

/**
 * Führt eine Chat-Completion aus — provider-agnostisch, mit Fallback.
 * @param {{
 *   system?:string, user:string, jsonMode?:boolean, maxTokens?:number, temperature?:number,
 *   provider?:'auto'|'groq'|'gemini',
 *   groqApiKey?:string, groqModel?:string, geminiApiKey?:string, geminiModel?:string,
 *   fetchImpl?:Function
 * }} opts
 * @returns {Promise<{text:string, model:string}>}
 */
async function chatComplete({
  system, user, jsonMode = false, maxTokens = 2048, temperature = 0,
  provider = 'auto',
  groqApiKey, groqModel = 'llama-3.3-70b-versatile',
  geminiApiKey, geminiModel = 'gemini-2.5-flash',
  fetchImpl,
} = {}) {
  const order = provider === 'groq' ? ['groq'] : provider === 'gemini' ? ['gemini'] : ['groq', 'gemini'];
  let lastErr = null;
  for (const p of order) {
    if (p === 'groq' && !groqApiKey) continue;
    if (p === 'gemini' && !geminiApiKey) continue;
    try {
      if (p === 'groq') return await callGroq({ system, user, jsonMode, maxTokens, temperature, apiKey: groqApiKey, model: groqModel, fetchImpl });
      return await callGemini({ system, user, jsonMode, maxTokens, temperature, apiKey: geminiApiKey, model: geminiModel, fetchImpl });
    } catch (e) {
      lastErr = e; // im 'auto'-Modus: nächsten Anbieter probieren (Groq-Limit → Gemini)
    }
  }
  throw lastErr || new Error('Kein LLM-Anbieter verfügbar (kein Groq- oder Gemini-Key gesetzt)');
}

module.exports = { chatComplete, callGroq, callGemini, GROQ_URL, GEMINI_BASE };
