// TranscriptMerger — verschmilzt Mic- und System-Kanal-Segmente chronologisch.
// Kanal 'mic' → speaker 'me', Kanal 'system' → speaker 'other'.
// Aufeinanderfolgende Segmente desselben Sprechers werden NICHT zusammengeführt (Wortgetreue, R7).
// CommonJS.

function mergeSegments(micSegs = [], systemSegs = []) {
  const tagged = [
    ...micSegs.map(s => ({ ...s, speaker: 'me', channel: 'mic' })),
    ...systemSegs.map(s => ({ ...s, speaker: 'other', channel: 'system' })),
  ];
  // Stabil sortieren: nach tStart; bei Gleichstand mic (0) vor system (1)
  return tagged
    .map((s, i) => ({ s, i, rank: s.channel === 'mic' ? 0 : 1 }))
    .sort((a, b) => (a.s.tStart - b.s.tStart) || (a.rank - b.rank) || (a.i - b.i))
    .map(({ s }) => ({ tStart: s.tStart, tEnd: s.tEnd, speaker: s.speaker, channel: s.channel, text: s.text }));
}

module.exports = { mergeSegments };
