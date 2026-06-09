// TranscriptMerger — verschmilzt Mic- und System-Kanal-Segmente chronologisch.
// Kanal 'mic' → speaker 'me', Kanal 'system' → speaker 'other' — ABER ein bereits
// gesetztes speaker-Label (z.B. 'Sprecher 1' aus der Deepgram-Diarisierung) bleibt erhalten.
// Aufeinanderfolgende Segmente desselben Sprechers werden NICHT zusammengeführt (Wortgetreue, R7).
// CommonJS.

/**
 * Lautsprecher-Echo unterdrücken (Call-Modus ohne Kopfhörer): Spielt die Gegenstelle über
 * die Lautsprecher, nimmt das Mikrofon ihre Stimme akustisch mit auf → dieselben Worte landen
 * fälschlich als „Ich" auf dem Mic-Kanal UND sauber auf dem System-Kanal. Da die Gegenstelle
 * sauber auf dem System-Kanal liegt, werden Mic-Segmente, die ZEITLICH überwiegend mit
 * System-Segmenten überlappen, als Echo verworfen. Übrig bleiben die echten Mic-Äußerungen
 * (= wenn die Gegenstelle gerade NICHT spricht).
 * @param {{tStart:number,tEnd:number}[]} micSegs
 * @param {{tStart:number,tEnd:number}[]} systemSegs
 * @param {{minOverlapFrac?:number, pad?:number}} opts
 */
function suppressBleed(micSegs = [], systemSegs = [], { minOverlapFrac = 0.5, pad = 0.4 } = {}) {
  if (!systemSegs.length) return micSegs;
  return micSegs.filter((m) => {
    const dur = Math.max(0.01, m.tEnd - m.tStart);
    let overlap = 0;
    for (const s of systemSegs) {
      const lo = Math.max(m.tStart, s.tStart - pad);
      const hi = Math.min(m.tEnd, s.tEnd + pad);
      if (hi > lo) overlap += hi - lo;
    }
    return overlap / dur < minOverlapFrac; // behalten, wenn NICHT überwiegend Echo
  });
}

function mergeSegments(micSegs = [], systemSegs = []) {
  const tagged = [
    ...micSegs.map(s => ({ ...s, speaker: s.speaker || 'me', channel: 'mic' })),
    ...systemSegs.map(s => ({ ...s, speaker: s.speaker || 'other', channel: 'system' })),
  ];
  // Stabil sortieren: nach tStart; bei Gleichstand mic (0) vor system (1)
  return tagged
    .map((s, i) => ({ s, i, rank: s.channel === 'mic' ? 0 : 1 }))
    .sort((a, b) => (a.s.tStart - b.s.tStart) || (a.rank - b.rank) || (a.i - b.i))
    .map(({ s }) => ({ tStart: s.tStart, tEnd: s.tEnd, speaker: s.speaker, channel: s.channel, text: s.text }));
}

module.exports = { mergeSegments, suppressBleed };
