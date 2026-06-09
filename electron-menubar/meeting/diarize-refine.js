'use strict';
// LLM-Korrektur der Sprecher-Zuordnung (Groq Llama). Die akustische Diarisierung (Tonhöhe/
// Lautstärke) macht den ersten Schnitt; bei kurzen, ähnlichen Stimmen verrutscht aber gelegentlich
// EIN Segment. Diese Stufe gibt das Transkript mit den vorläufigen Sprecher-Labels an ein LLM und
// lässt es NUR die Zuordnung anhand des Gesprächsverlaufs korrigieren (Anrede „du", Frage→Antwort,
// inhaltliche Kohärenz). Der TEXT bleibt unangetastet; es werden KEINE neuen Sprecher erfunden.
// Konservativ: im Zweifel bleibt die akustische Zuordnung. Best effort — scheitert das LLM
// (z.B. Tageslimit), bleiben die akustischen Labels erhalten.

const { chatComplete } = require('./llm-client');

/** Baut den Korrektur-Prompt. Reine Funktion (testbar). */
function buildRefinePrompt(segments, speakers) {
  const lines = segments.map((s, i) => `${i}. [${s.speaker}] ${s.text}`).join('\n');
  return `Du bekommst ein Gesprächs-Transkript mit VORLÄUFIGEN, teils fehlerhaften Sprecher-Zuordnungen (akustisch geschätzt). Korrigiere AUSSCHLIESSLICH die Sprecher-Zuordnung anhand des Gesprächsverlaufs.

Regeln:
- Verwende NUR diese vorhandenen Sprecher: ${speakers.map((s) => `"${s}"`).join(', ')}. Erfinde keine neuen.
- Ändere NIEMALS den Text.
- Nutze Gesprächslogik: direkte Anrede mit „du", Frage→Antwort-Paare, inhaltliche Kohärenz. Beispiel: Wer „Ich möchte schlafen" sagt, ist NICHT derselbe, der danach „Wann willst du schlafen?" fragt.
- Ändere eine Zuordnung NUR, wenn der Verlauf sie klar widerlegt; im Zweifel die vorgegebene Zuordnung behalten.
- Antworte mit GENAU EINEM JSON-Objekt: {"speakers":[{"i":0,"speaker":"..."}, ...]} mit einem Eintrag pro Zeile (alle Zeilen 0..${segments.length - 1}).

Transkript:
${lines}`;
}

/** Parst die LLM-Antwort → Map index→speaker (nur erlaubte Sprecher). Reine Funktion. */
function parseRefineResponse(content, allowed) {
  let obj;
  try {
    // robust gegen ```json-Fences / Drumherum: erstes {...} herausziehen
    const m = content && content.match(/\{[\s\S]*\}/);
    obj = JSON.parse(m ? m[0] : content);
  } catch { return new Map(); }
  const arr = (obj && (obj.speakers || obj.assignments || obj.lines)) || [];
  const out = new Map();
  for (const e of Array.isArray(arr) ? arr : []) {
    if (e && typeof e.i === 'number' && typeof e.speaker === 'string' && allowed.has(e.speaker)) {
      out.set(e.i, e.speaker);
    }
  }
  return out;
}

/**
 * Korrigiert die Sprecher-Zuordnung per LLM (Groq/Gemini, Auto-Fallback). Gibt eine NEUE
 * Segmentliste zurück (Text identisch).
 * @param {{speaker:string,text:string,tStart?:number,tEnd?:number,channel?:string}[]} segments
 * @param {{apiKey?:string, groqApiKey?:string, geminiApiKey?:string, llmProvider?:string,
 *          model?:string, geminiModel?:string, fetchImpl?:Function, minSegments?:number, maxSegments?:number}} opts
 */
async function refineSpeakers(segments, opts = {}) {
  const { apiKey, groqApiKey, geminiApiKey, llmProvider, model, geminiModel, fetchImpl, minSegments = 3, maxSegments = 400 } = opts;
  if (!Array.isArray(segments) || segments.length < minSegments) return segments;
  if (segments.length > maxSegments) return segments; // sehr lange Meetings: kein LLM-Pass (Token/Kosten)
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
  if (speakers.length < 2) return segments; // nur ein Sprecher → nichts zu korrigieren
  const gKey = groqApiKey != null ? groqApiKey : apiKey; // Abwärtskompatibilität: apiKey = Groq-Key
  if (!gKey && !geminiApiKey) return segments; // kein LLM-Anbieter → akustische Labels behalten

  const { text } = await chatComplete({
    system: 'Du bist ein präziser Diarisierungs-Korrektor. Du gibst ausschließlich gültiges JSON zurück.',
    user: buildRefinePrompt(segments, speakers),
    jsonMode: true,
    maxTokens: 8192,
    temperature: 0,
    provider: llmProvider || 'auto',
    groqApiKey: gKey,
    groqModel: model || 'llama-3.3-70b-versatile',
    geminiApiKey,
    geminiModel,
    fetchImpl,
  });
  const allowed = new Set(speakers);
  const corrections = parseRefineResponse(text || '', allowed);
  if (corrections.size === 0) return segments;
  // Anwenden: NUR Sprecher ändern, Text + Zeiten unverändert.
  return segments.map((s, i) => (corrections.has(i) ? { ...s, speaker: corrections.get(i) } : s));
}

module.exports = { refineSpeakers, buildRefinePrompt, parseRefineResponse };
