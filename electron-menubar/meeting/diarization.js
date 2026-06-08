// Sprecher-Diarisierung des System-Kanals über Deepgram (Phase 2). CommonJS.
// Wird beim Stop über die KOMPLETTE System-Audiodatei ausgeführt, damit die
// Sprecher-IDs über das ganze Meeting hinweg konsistent sind.
'use strict';

const fs = require('node:fs');

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

/**
 * Wandelt eine Deepgram-Antwort in sprecher-beschriftete System-Segmente um.
 * Bevorzugt results.utterances[]; Fallback auf wortweise Speaker-IDs.
 * @returns {{tStart:number,tEnd:number,speaker:string,channel:'system',text:string}[]}
 */
function parseDeepgram(json) {
  const r = json && json.results;
  if (!r) return [];

  if (Array.isArray(r.utterances) && r.utterances.length) {
    return r.utterances
      .map((u) => ({
        tStart: u.start,
        tEnd: u.end,
        speaker: 'Sprecher ' + ((u.speaker == null ? 0 : u.speaker) + 1),
        channel: 'system',
        text: (u.transcript || '').trim(),
      }))
      .filter((s) => s.text.length > 0);
  }

  // Fallback: aufeinanderfolgende Wörter desselben Sprechers zusammenfassen
  const words = (((r.channels || [])[0] || {}).alternatives || [])[0]?.words || [];
  const segs = [];
  let cur = null;
  for (const w of words) {
    const sp = w.speaker == null ? 0 : w.speaker;
    const word = w.punctuated_word || w.word || '';
    if (!cur || cur._sp !== sp) {
      if (cur) segs.push(cur);
      cur = { tStart: w.start, tEnd: w.end, speaker: 'Sprecher ' + (sp + 1), channel: 'system', text: word, _sp: sp };
    } else {
      cur.tEnd = w.end;
      cur.text += ' ' + word;
    }
  }
  if (cur) segs.push(cur);
  return segs
    .map(({ _sp, ...s }) => ({ ...s, text: s.text.trim() }))
    .filter((s) => s.text.length > 0);
}

/**
 * Diarisiert die WAV-Datei `audioPath` über Deepgram Nova-3.
 * @param {string} audioPath
 * @param {{ apiKey: string, language?: string, fetchImpl?: Function }} opts
 * @returns {Promise<object[]>} sprecher-beschriftete System-Segmente
 */
async function diarizeWithDeepgram(audioPath, { apiKey, language = 'de', fetchImpl } = {}) {
  if (!apiKey) throw new Error('Deepgram API-Key fehlt');
  const fetchFn = fetchImpl || globalThis.fetch;
  const audio = fs.readFileSync(audioPath);
  const params = new URLSearchParams({
    model: 'nova-3',
    diarize: 'true',
    utterances: 'true',
    smart_format: 'true',
    language,
  });
  const res = await fetchFn(`${DEEPGRAM_URL}?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/wav' },
    body: audio,
  });
  if (!res.ok) {
    const t = await (res.text ? res.text().catch(() => String(res.status)) : Promise.resolve(String(res.status)));
    throw new Error(`Deepgram HTTP ${res.status}: ${t}`);
  }
  const json = await res.json();
  return parseDeepgram(json);
}

module.exports = { parseDeepgram, diarizeWithDeepgram, DEEPGRAM_URL };
