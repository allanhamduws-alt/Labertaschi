// Meeting-Summary: Prompt-Erstellung, JSON-Parsing und Groq-Llama-Call. CommonJS.

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Erzeugt den System-Prompt für die Protokoll-Generierung.
 * @param {string} transcriptText - Das vollständige Transkript als Text
 * @param {string} language - Sprache (z.B. 'de')
 * @returns {string}
 */
function getMeetingSummaryPrompt(transcriptText, language) {
  return `Du bist ein präziser Meeting-Protokollant. Analysiere das folgende Gesprächstranskript und erstelle ein strukturiertes Protokoll.

Antworte NUR mit einem validen JSON-Objekt (kein Markdown, keine Erklärungen) mit exakt diesen Keys:
- "kurzzusammenfassung": string — eine prägnante Zusammenfassung des Gesprächs (2–4 Sätze)
- "kernpunkte": string[] — die wichtigsten besprochenen Punkte, Entscheidungen und Ergebnisse
- "todos": Array von Objekten mit { "text": string, "verantwortlich": string|null, "erledigt": false } — alle genannten Aufgaben, Folgemaßnahmen und Vereinbarungen
- "offeneFragen": string[] — ungeklärte Fragen und Themen, die noch beantwortet werden müssen

Behalte alle Fakten, Namen und Zahlen exakt bei. Erfinde nichts. Sprache: ${language || 'de'}.

Transkript:
${transcriptText}`;
}

/**
 * Parst das rohe JSON aus der Groq-Antwort.
 * Entfernt ggf. Markdown-Fences (```json ... ```).
 * Füllt fehlende Felder mit Defaults.
 * @param {string} raw
 * @returns {object}
 */
function parseSummaryJson(raw) {
  let text = raw.trim();

  // Markdown-Fences entfernen (```json ... ``` oder ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fallback: leeres Objekt
    parsed = {};
  }

  return {
    kurzzusammenfassung: typeof parsed.kurzzusammenfassung === 'string' ? parsed.kurzzusammenfassung : '',
    kernpunkte: Array.isArray(parsed.kernpunkte) ? parsed.kernpunkte : [],
    todos: Array.isArray(parsed.todos) ? parsed.todos : [],
    offeneFragen: Array.isArray(parsed.offeneFragen) ? parsed.offeneFragen : [],
    generatedAt: parsed.generatedAt || '',
    model: parsed.model || '',
  };
}

/**
 * Sendet das Transkript an Groq Llama und gibt ein MeetingSummary zurück.
 * @param {string} transcriptText
 * @param {{ apiKey: string, model: string, language: string, fetchImpl?: Function }} opts
 * @returns {Promise<object>} MeetingSummary
 */
async function generateMeetingSummary(transcriptText, { apiKey, model, language, fetchImpl } = {}) {
  const fetch = fetchImpl || globalThis.fetch;
  const prompt = getMeetingSummaryPrompt(transcriptText, language || 'de');

  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      max_tokens: 2048,
      messages: [
        { role: 'system', content: 'Du bist ein präziser Meeting-Protokollant. Antworte immer mit einem validen JSON-Objekt.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Groq Summary-Call fehlgeschlagen: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '{}';

  const summary = parseSummaryJson(content);
  summary.generatedAt = new Date().toISOString();
  summary.model = model || 'llama-3.3-70b-versatile';

  return summary;
}

module.exports = { getMeetingSummaryPrompt, parseSummaryJson, generateMeetingSummary, GROQ_CHAT_URL };
