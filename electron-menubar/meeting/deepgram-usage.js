'use strict';
// Deepgram-Usage- & Kostenberechnung. Reine Funktionen (testbar), keine I/O.
//
// Preise: öffentliche Deepgram Pay-as-you-go-Liste (Stand Juni 2026).
//   nova-3 monolingual (en):   $0.0077/min
//   nova-3 multilingual (de…): $0.0092/min   ← paply sendet language=de → multilingual
//   Diarization-Add-on:        $0.0020/min   (ZUSÄTZLICH zur STT-Minute, nicht inkl.)
// Als Konstante gehalten — Deepgram kann Preise ändern; im Zweifel gegen das eigene
// Deepgram-Dashboard verifizieren. Wir zählen lokal, weil die App die gesendeten
// Audio-Sekunden exakt kennt (zuverlässiger als die nachgelagerte Usage-API, die
// einen billing-fähigen Admin-Key bräuchte).

const DEEPGRAM_RATES = {
  baseMonolingualPerMin: 0.0077,
  baseMultilingualPerMin: 0.0092,
  diarizePerMin: 0.0020,
};

const WAV_HEADER_BYTES = 44;

/**
 * Audiolänge (Sekunden) aus der WAV-Dateigröße: (size-44)/(channels*bytesPerSample*sampleRate).
 * @param {number} fileSizeBytes
 * @param {{sampleRate?:number, channels?:number, bytesPerSample?:number}} [opts]
 */
function wavDurationSeconds(fileSizeBytes, { sampleRate = 16000, channels = 1, bytesPerSample = 2 } = {}) {
  const dataBytes = Math.max(0, (fileSizeBytes || 0) - WAV_HEADER_BYTES);
  const bytesPerSecond = channels * bytesPerSample * sampleRate;
  if (bytesPerSecond <= 0) return 0;
  return dataBytes / bytesPerSecond;
}

/**
 * Geschätzte Deepgram-Kosten (USD) für `seconds` Audio.
 * @param {number} seconds
 * @param {{multilingual?:boolean, diarize?:boolean}} [opts]
 */
function estimateDeepgramCostUsd(seconds, { multilingual = true, diarize = true } = {}) {
  const s = Math.max(0, seconds || 0);
  const base = multilingual ? DEEPGRAM_RATES.baseMultilingualPerMin : DEEPGRAM_RATES.baseMonolingualPerMin;
  const perMin = base + (diarize ? DEEPGRAM_RATES.diarizePerMin : 0);
  return (s / 60) * perMin;
}

/** 'YYYY-MM' aus einem Date. */
function monthKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Leerer Usage-Zustand. */
function emptyUsage() {
  return { totalSeconds: 0, totalCostUsd: 0, totalRequests: 0, perMonth: {} };
}

/**
 * Akkumuliert einen Diarization-Call in den Usage-Zustand (immutabel — prev bleibt unverändert).
 * @param {object|null} prev
 * @param {{ seconds?:number, costUsd?:number, requests?:number, month:string }} entry
 */
function accumulateUsage(prev, { seconds = 0, costUsd = 0, requests = 1, month }) {
  const base = prev && typeof prev === 'object' ? prev : emptyUsage();
  const perMonth = { ...(base.perMonth || {}) };
  const cur = perMonth[month] || { seconds: 0, costUsd: 0, requests: 0 };
  perMonth[month] = {
    seconds: (cur.seconds || 0) + seconds,
    costUsd: (cur.costUsd || 0) + costUsd,
    requests: (cur.requests || 0) + requests,
  };
  return {
    totalSeconds: (base.totalSeconds || 0) + seconds,
    totalCostUsd: (base.totalCostUsd || 0) + costUsd,
    totalRequests: (base.totalRequests || 0) + requests,
    perMonth,
  };
}

module.exports = {
  DEEPGRAM_RATES,
  WAV_HEADER_BYTES,
  wavDurationSeconds,
  estimateDeepgramCostUsd,
  monthKey,
  emptyUsage,
  accumulateUsage,
};
