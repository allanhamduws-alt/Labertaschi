'use strict';
// LLM-Korrektur der Sprecher-Zuordnung (Groq Llama). Die akustische Diarisierung (Tonhöhe/
// Lautstärke) macht den ersten Schnitt; bei kurzen, ähnlichen Stimmen verrutscht aber gelegentlich
// EIN Segment. Diese Stufe gibt das Transkript mit den vorläufigen Sprecher-Labels an ein LLM und
// lässt es NUR die Zuordnung anhand des Gesprächsverlaufs korrigieren (Anrede „du", Frage→Antwort,
// inhaltliche Kohärenz). Der TEXT bleibt unangetastet; es werden KEINE neuen Sprecher erfunden.
// Konservativ: im Zweifel bleibt die akustische Zuordnung. Best effort — scheitert das LLM
// (z.B. Tageslimit), bleiben die akustischen Labels erhalten.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

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
 * Korrigiert die Sprecher-Zuordnung per LLM. Gibt eine NEUE Segmentliste zurück (Text identisch).
 * @param {{speaker:string,text:string,tStart?:number,tEnd?:number,channel?:string}[]} segments
 * @param {{apiKey:string, model?:string, fetchImpl?:Function, minSegments?:number}} opts
 */
async function refineSpeakers(segments, { apiKey, model = 'llama-3.3-70b-versatile', fetchImpl, minSegments = 3, maxSegments = 400 } = {}) {
  if (!Array.isArray(segments) || segments.length < minSegments) return segments;
  if (segments.length > maxSegments) return segments; // sehr lange Meetings: kein LLM-Pass (Token/Kosten)
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
  if (speakers.length < 2) return segments; // nur ein Sprecher → nichts zu korrigieren
  if (!apiKey) return segments;
  const fetchFn = fetchImpl || globalThis.fetch;

  const res = await fetchFn(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Du bist ein präziser Diarisierungs-Korrektor. Du gibst ausschließlich gültiges JSON zurück.' },
        { role: 'user', content: buildRefinePrompt(segments, speakers) },
      ],
    }),
  });
  if (!res.ok) {
    const err = new Error(`Groq refine HTTP ${res.status}`);
    if (res.status === 429) err.code = 'rate_limit';
    throw err;
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const allowed = new Set(speakers);
  const corrections = parseRefineResponse(content || '', allowed);
  if (corrections.size === 0) return segments;
  // Anwenden: NUR Sprecher ändern, Text + Zeiten unverändert.
  return segments.map((s, i) => (corrections.has(i) ? { ...s, speaker: corrections.get(i) } : s));
}

module.exports = { refineSpeakers, buildRefinePrompt, parseRefineResponse };
