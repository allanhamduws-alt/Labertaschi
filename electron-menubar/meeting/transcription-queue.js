// TranscriptionQueue — serielle Groq-Whisper-Verarbeitung mit Retry. CommonJS.
'use strict';

const EventEmitter = require('node:events');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Wandelt Groq verbose_json-Antwort in MeetingSegment-ähnliche Objekte um.
 * @param {object} json  - Groq-Antwort mit `.segments[]`
 * @param {number} tOffset - Sekunden ab Sessionstart für diesen Chunk
 * @returns {{ tStart:number, tEnd:number, text:string }[]}
 */
function parseVerbose(json, tOffset) {
  if (!json || !Array.isArray(json.segments)) return [];
  return json.segments
    .map((s) => ({
      tStart: s.start + tOffset,
      tEnd: s.end + tOffset,
      text: s.text.trim(),
    }))
    .filter((s) => s.text.length > 0);
}

/**
 * Serielle Transkriptions-Queue.
 * Ereignisse: 'segments' ({ channel, segments }) · 'error' (Error)
 */
class TranscriptionQueue extends EventEmitter {
  /**
   * @param {{ apiKey: string, language: string, fetchImpl?: Function,
   *           getPrompt?: (channel: 'mic'|'system') => string }} opts
   * getPrompt liefert (zur Ausführungszeit, NICHT zur enqueue-Zeit) den bisherigen
   * Transkript-Kontext des Kanals als Whisper-`prompt` — gibt Groq Kontext über
   * Chunk-Grenzen hinweg, damit angeschnittene Wörter/Sätze korrekt verstanden werden.
   */
  constructor({ apiKey, language, fetchImpl, getPrompt } = {}) {
    super();
    this.apiKey = apiKey;
    this.language = language || 'de';
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.getPrompt = typeof getPrompt === 'function' ? getPrompt : null;
    /** @type {Promise<void>} Serielle Kette */
    this.chain = Promise.resolve();
  }

  /**
   * Reiht einen WAV-Buffer zur Transkription ein.
   * @param {{ channel: 'mic'|'system', wavBuffer: Buffer, tOffset: number }} item
   */
  enqueue({ channel, wavBuffer, tOffset }) {
    // .catch hält die Kette am Leben: ein unerwarteter Wurf (außerhalb des
    // Retry-try/catch, z.B. in emit()) darf nachfolgende Jobs nicht blockieren
    // und idle() nicht dauerhaft rejecten.
    this.chain = this.chain
      .then(() => this._transcribe({ channel, wavBuffer, tOffset }))
      .catch((err) => { this.emit('error', err); });
  }

  /**
   * Wartet, bis alle eingereihten Jobs abgearbeitet sind.
   * @returns {Promise<void>}
   */
  idle() {
    return this.chain;
  }

  /**
   * Führt einen Transkriptions-Aufruf mit Retry (max 3) durch.
   * @private
   */
  async _transcribe({ channel, wavBuffer, tOffset }) {
    const MAX_RETRIES = 3;
    let lastError;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponentieller Backoff: 500ms, 1000ms
        await _sleep(500 * attempt);
      }
      try {
        const segments = await this._callGroq({ channel, wavBuffer, tOffset });
        this.emit('segments', { channel, segments });
        return;
      } catch (err) {
        lastError = err;
      }
    }

    this.emit('error', lastError);
  }

  /**
   * POST an Groq Whisper, gibt geparste Segmente zurück.
   * @private
   */
  async _callGroq({ channel, wavBuffer, tOffset }) {
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'chunk.wav');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', this.language);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');
    // Kontext-Kontinuität: bisheriger Transkript-Text des Kanals als prompt
    // (Whisper-Limit ~224 Tokens → konservativ auf 800 Zeichen begrenzt).
    const prompt = this.getPrompt ? this.getPrompt(channel) : null;
    if (prompt) formData.append('prompt', String(prompt).slice(-800));

    const res = await this.fetchImpl(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status));
      throw new Error(`Groq Whisper HTTP ${res.status}: ${text}`);
    }

    const json = await res.json();
    return parseVerbose(json, tOffset);
  }
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { TranscriptionQueue, parseVerbose, GROQ_API_URL };
