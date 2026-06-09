// Meeting-Summary: Prompt-Erstellung, JSON-Parsing und LLM-Call (Groq/Gemini). CommonJS.

const { chatComplete } = require('./llm-client');
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
 * Sendet das Transkript an das LLM (Groq oder Gemini, mit Auto-Fallback) und gibt ein
 * MeetingSummary zurück. Bei erschöpftem Groq-Tageslimit übernimmt automatisch Gemini (falls Key).
 * @param {string} transcriptText
 * @param {{ apiKey?:string, groqApiKey?:string, geminiApiKey?:string, llmProvider?:string,
 *           model?:string, geminiModel?:string, language?:string, fetchImpl?:Function }} opts
 * @returns {Promise<object>} MeetingSummary
 */
async function generateMeetingSummary(transcriptText, opts = {}) {
  const { apiKey, groqApiKey, geminiApiKey, llmProvider, model, geminiModel, language, fetchImpl } = opts;
  const prompt = getMeetingSummaryPrompt(transcriptText, language || 'de');

  // chatComplete wirft bei 429 (alle Anbieter erschöpft) einen Fehler mit code='rate_limit' —
  // die UI zeigt dann eine verständliche Meldung statt still „kein Protokoll".
  const { text, model: usedModel } = await chatComplete({
    system: 'Du bist ein präziser Meeting-Protokollant. Antworte immer mit einem validen JSON-Objekt.',
    user: prompt,
    jsonMode: true,
    maxTokens: 2048,
    temperature: 0,
    provider: llmProvider || 'auto',
    groqApiKey: groqApiKey != null ? groqApiKey : apiKey, // Abwärtskompatibilität: apiKey = Groq-Key
    groqModel: model || 'llama-3.3-70b-versatile',
    geminiApiKey,
    geminiModel,
    fetchImpl,
  });

  const summary = parseSummaryJson(text || '{}');
  summary.generatedAt = new Date().toISOString();
  summary.model = usedModel || model || 'llama-3.3-70b-versatile';

  return summary;
}

module.exports = { getMeetingSummaryPrompt, parseSummaryJson, generateMeetingSummary, GROQ_CHAT_URL };
