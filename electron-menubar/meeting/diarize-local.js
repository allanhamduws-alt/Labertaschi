'use strict';
// Lokale Sprecher-Diarisierung OHNE Cloud. Pro Transkript-Segment wird ein akustischer
// Merkmalsvektor berechnet (Grundton/Pitch + MFCC-Mittel = Klangfarbe), danach werden die
// Segmente agglomerativ in N Sprecher geclustert. Funktioniert bei EINEM Mikrofon (mehrere
// Personen am selben Mikro) — genau der Fall, an dem Deepgrams kanalbasierte Diarisierung
// scheitert (alle Stimmen teilen denselben Kanal-Fingerabdruck → 1 Sprecher).
// Reines JavaScript: kein ML-Modell, keine native Dependency, keine API-Kosten.

// ----------------------------- FFT (iterativ, radix-2) -----------------------------
// In-place; Länge muss Zweierpotenz sein. re/im sind Float64Array.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const xr = re[b] * cwr - im[b] * cwi;
        const xi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
}

// ----------------------------- Mel/MFCC -----------------------------
function hzToMel(f) { return 2595 * Math.log10(1 + f / 700); }
function melToHz(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

// Dreiecks-Mel-Filterbank: gibt für jeden Filter die FFT-Bin-Gewichte.
function melFilterbank(numFilters, fftSize, sampleRate, fLow = 80, fHigh) {
  fHigh = fHigh || sampleRate / 2;
  const bins = fftSize / 2 + 1;
  const melLow = hzToMel(fLow), melHigh = hzToMel(fHigh);
  const points = new Array(numFilters + 2);
  for (let i = 0; i < points.length; i++) {
    const mel = melLow + ((melHigh - melLow) * i) / (numFilters + 1);
    points[i] = Math.floor(((fftSize + 1) * melToHz(mel)) / sampleRate);
  }
  const fb = [];
  for (let m = 1; m <= numFilters; m++) {
    const filt = new Float64Array(bins);
    const l = points[m - 1], c = points[m], r = points[m + 1];
    for (let k = l; k < c; k++) if (c > l) filt[k] = (k - l) / (c - l);
    for (let k = c; k < r; k++) if (r > c) filt[k] = (r - k) / (r - c);
    fb.push(filt);
  }
  return fb;
}

// DCT-II der Log-Mel-Energien → erste numCoeffs Cepstral-Koeffizienten.
function dct(input, numCoeffs) {
  const N = input.length;
  const out = new Float64Array(numCoeffs);
  for (let k = 0; k < numCoeffs; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += input[n] * Math.cos((Math.PI * k * (2 * n + 1)) / (2 * N));
    out[k] = s;
  }
  return out;
}

// ----------------------------- Frame-Features -----------------------------
const FRAME_MS = 25, HOP_MS = 10, FFT_SIZE = 512, NUM_MEL = 26, NUM_MFCC = 13;

// Pitch (Grundfrequenz) eines Frames per Autokorrelation, 70–350 Hz. 0 = stimmlos.
function framePitch(frame, sampleRate) {
  let mean = 0; for (let i = 0; i < frame.length; i++) mean += frame[i];
  mean /= frame.length;
  let energy = 0; for (let i = 0; i < frame.length; i++) energy += (frame[i] - mean) ** 2;
  if (Math.sqrt(energy / frame.length) < 120) return 0; // zu leise → stimmlos
  const lo = Math.floor(sampleRate / 350), hi = Math.floor(sampleRate / 70);
  let best = 0, bestVal = 0;
  for (let lag = lo; lag <= hi && lag < frame.length; lag++) {
    let s = 0;
    for (let i = lag; i < frame.length; i++) s += (frame[i] - mean) * (frame[i - lag] - mean);
    if (s > bestVal) { bestVal = s; best = lag; }
  }
  return best > 0 ? sampleRate / best : 0;
}

// MFCC eines Frames (Hamming → FFT → Power → Mel → log → DCT).
function frameMFCC(frame, sampleRate, fb) {
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
  const len = Math.min(frame.length, FFT_SIZE);
  for (let i = 0; i < len; i++) {
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (len - 1)); // Hamming
    re[i] = frame[i] * w;
  }
  fft(re, im);
  const bins = FFT_SIZE / 2 + 1;
  const power = new Float64Array(bins);
  for (let k = 0; k < bins; k++) power[k] = (re[k] * re[k] + im[k] * im[k]) / FFT_SIZE;
  const logMel = new Float64Array(fb.length);
  for (let m = 0; m < fb.length; m++) {
    let e = 0; const filt = fb[m];
    for (let k = 0; k < bins; k++) e += power[k] * filt[k];
    logMel[m] = Math.log(e + 1e-10);
  }
  return dct(logMel, NUM_MFCC);
}

/**
 * Merkmalsvektor eines Audio-Abschnitts: [medianPitch, mfcc1..12-Mittel] über stimmhafte Frames.
 * @param {Int16Array} pcm  16-bit-PCM-Abschnitt (ein Kanal)
 * @returns {{pitch:number, mfcc:number[], voiced:number, frames:number}|null}
 */
function segmentFeatures(pcm, sampleRate) {
  const frameLen = Math.floor((FRAME_MS * sampleRate) / 1000);
  const hop = Math.floor((HOP_MS * sampleRate) / 1000);
  if (pcm.length < frameLen) return null;
  const fb = melFilterbank(NUM_MEL, FFT_SIZE, sampleRate);
  const pitches = [];
  const mfccSum = new Float64Array(NUM_MFCC);
  let voiced = 0, total = 0;
  const buf = new Float64Array(frameLen);
  for (let off = 0; off + frameLen <= pcm.length; off += hop) {
    for (let i = 0; i < frameLen; i++) buf[i] = pcm[off + i];
    total++;
    const p = framePitch(buf, sampleRate);
    if (p > 0) {
      pitches.push(p);
      const c = frameMFCC(buf, sampleRate, fb);
      for (let k = 0; k < NUM_MFCC; k++) mfccSum[k] += c[k];
      voiced++;
    }
  }
  if (voiced < 2) return null; // zu wenig stimmhaftes Material → unbrauchbar
  pitches.sort((a, b) => a - b);
  const medPitch = pitches[Math.floor(pitches.length / 2)];
  const mfcc = []; for (let k = 1; k < NUM_MFCC; k++) mfcc.push(mfccSum[k] / voiced); // c0 (Energie) weglassen
  return { pitch: medPitch, mfcc, voiced, frames: total };
}

// ----------------------------- Pitch je Segment (schnell, ohne MFCC) -----------------------------
// Median-Grundton eines Audio-Abschnitts über stimmhafte Frames. MFCC (segmentFeatures) bleibt
// fürs Spätere im Modul, wird aber fürs Clustering v1 nicht gebraucht (Pitch ist der starke,
// stabile, sprecher-diskriminative Hinweis; MFCC verrauschte die Distanzen und über-splittete).
function segmentPitch(pcm, sampleRate) {
  const frameLen = Math.floor((FRAME_MS * sampleRate) / 1000);
  const hop = Math.floor((HOP_MS * sampleRate) / 1000);
  if (pcm.length < frameLen) return null;
  const pitches = [];
  const buf = new Float64Array(frameLen);
  for (let off = 0; off + frameLen <= pcm.length; off += hop) {
    for (let i = 0; i < frameLen; i++) buf[i] = pcm[off + i];
    const p = framePitch(buf, sampleRate);
    if (p > 0) pitches.push(p);
  }
  if (pitches.length < 3) return null; // zu wenig stimmhaftes Material
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)]; // robuster Median
}

// Lautstärke (RMS) eines Audio-Abschnitts (Hilfsfunktion/Diagnose). Wird fürs Sprecher-Labeling
// NICHT mehr genutzt: die Auto-Lautstärke (AGC) nivelliert die Lautstärke, daher ist „wer zuerst
// spricht = Ich" zuverlässiger (s. labelClusters).
function segmentRms(pcm) {
  if (!pcm || pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

// HINWEIS (empirisch, 2026-06-09): Klangfarbe/„Telefon-Helligkeit" und ein RMS-„Sekundär-Split"
// wurden als Trenn-Merkmale verworfen (Höhen fehlen real; Einzelsprecher-Lautstärke schwankt ~3×).
// „Lautester = Ich" wurde ebenfalls verworfen: seit das Mikro mit Auto-Lautstärke (AGC) aufnimmt
// (gute Transkription), ist die Lautstärke nivelliert. Robust: Tonhöhe (Clustering) für die Trennung
// + „wer zuerst spricht = Ich" fürs Labeling. Eine LLM-Stufe (diarize-refine) korrigiert danach.

// ----------------------------- Pitch-Lücken-Clustering -----------------------------
// Sortiert die Segment-Tonhöhen und trennt an „großen" Lücken in zusammenhängende
// Sprecher-Cluster. Eine Lücke gilt als Sprecherwechsel, wenn sie relativ (Verhältnis zur
// tieferen Tonhöhe) UND absolut groß genug ist. Tonhöhe ist logarithmisch wahrgenommen →
// Verhältnis-Kriterium. Ein einzelner Sprecher (enge Tonhöhe, kleine Lücken) wird NICHT
// gesplittet; klar verschiedene Stimmen (M/F, Erwachsener/Kind) sauber getrennt.
// Empirisch an echten Aufnahmen kalibriert: altcii (Lücke 0.29) → 2; zepez3 (0.034) → 1.
function pitchClusters(pitchOfFeat, { gapRatio = 0.14, gapAbs = 12, maxSpeakers = 6 } = {}) {
  const idx = pitchOfFeat.map((p, i) => i).sort((a, b) => pitchOfFeat[a] - pitchOfFeat[b]);
  // Kandidaten-Grenzen mit ihrer „Stärke" (relative Lücke) sammeln
  const boundaries = []; // { afterRank, ratio }
  for (let r = 1; r < idx.length; r++) {
    const lo = pitchOfFeat[idx[r - 1]], hi = pitchOfFeat[idx[r]];
    const gap = hi - lo, ratio = gap / lo;
    if (gap >= gapAbs && ratio >= gapRatio) boundaries.push({ afterRank: r, ratio });
  }
  // maxSpeakers-1 stärkste Grenzen behalten
  boundaries.sort((a, b) => b.ratio - a.ratio);
  const keep = boundaries.slice(0, Math.max(0, maxSpeakers - 1)).map((b) => b.afterRank).sort((a, b) => a - b);
  // Cluster-ID je (pitch-sortiertem) Rang
  const clusterOfRank = new Array(idx.length);
  let c = 0;
  for (let r = 0; r < idx.length; r++) { if (keep.includes(r)) c++; clusterOfRank[r] = c; }
  // zurück auf Feature-Index
  const clusterOfFeat = new Array(idx.length);
  for (let r = 0; r < idx.length; r++) clusterOfFeat[idx[r]] = clusterOfRank[r];
  return clusterOfFeat; // 0..K-1, nach Tonhöhe geordnet
}

// Cluster-IDs → Sprecher-Labels, kanal-abhängig. Sortierung nach erstem zeitlichen Auftreten.
// - Mikrofon ('mic'): WER ZUERST SPRICHT = „Ich" (= 'me'). Der Nutzer startet die Aufnahme und
//   spricht praktisch immer zuerst („sag mal was…") → robuster als Lautstärke (die von der
//   Auto-Lautstärke/AGC nivelliert wird) und per Umbenennen + LLM-Korrektur nachjustierbar.
//   Übrige nach Auftreten 'Sprecher 2','Sprecher 3',… (Leute im Raum / ferner Partner).
// - System ('system'): die Gegenstelle(n) — erster Cluster 'other' (= „Gegenstelle"),
//   weitere 'Gegenstelle 2','Gegenstelle 3',…
function labelClusters(clusterIds, clusterFirstIdx, channel) {
  const byAppearance = [...clusterIds].sort((a, b) => clusterFirstIdx.get(a) - clusterFirstIdx.get(b));
  const labelOf = new Map();
  const meLabel = channel === 'system' ? 'other' : 'me';
  const restPrefix = channel === 'system' ? 'Gegenstelle ' : 'Sprecher ';
  byAppearance.forEach((cl, i) => labelOf.set(cl, i === 0 ? meLabel : restPrefix + (i + 1)));
  return labelOf;
}

/**
 * Diarisiert bereits transkribierte Segmente EINES Kanals lokal (ohne Cloud).
 * Gibt eine Kopie der Segmente mit zugewiesenem `speaker` zurück (Labels je Kanal, s. labelClusters).
 * Segmente ohne brauchbare Tonhöhe erben den Cluster des zeitlich nächsten brauchbaren Segments.
 * @param {{tStart:number,tEnd:number,text:string}[]} segments
 * @param {Int16Array} pcm  voller PCM des Kanals (16-bit mono)
 * @param {{sampleRate?:number, gapRatio?:number, gapAbs?:number, maxSpeakers?:number, channel?:'mic'|'system'}} opts
 */
function diarizeLocal(segments, pcm, { sampleRate = 16000, gapRatio = 0.14, gapAbs = 12, maxSpeakers = 6, channel = 'mic' } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const soloLabel = channel === 'system' ? 'other' : 'me';
  const pitchOfFeat = [];
  const idxOfFeat = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const a = Math.max(0, Math.floor(s.tStart * sampleRate));
    const b = Math.min(pcm.length, Math.floor(s.tEnd * sampleRate));
    if (b - a < Math.floor(0.25 * sampleRate)) continue; // <250ms → überspringen (unzuverlässig)
    const slice = pcm.subarray(a, b);
    const p = segmentPitch(slice, sampleRate);
    if (p) { pitchOfFeat.push(p); idxOfFeat.push(i); }
  }
  const out = segments.map((s) => ({ ...s }));
  if (pitchOfFeat.length <= 1) { out.forEach((s) => { s.speaker = soloLabel; }); return out; }

  // Oktavfehler-Korrektur: die Autokorrelation pickt gelegentlich die halbe Periode →
  // doppelte (verdreifachte) Frequenz, was Schein-Sprecher erzeugt. Echte Sprecher mit
  // substanziellem Anteil verschieben den Median, sind also KEINE extremen Ausreißer; nur
  // vereinzelte Fehler liegen > 1.7× Median und werden in die Grundoktave zurückgefaltet.
  const sorted = [...pitchOfFeat].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const folded = pitchOfFeat.map((p) => { let q = p; while (q > 1.7 * med) q /= 2; return q; });

  const clusterOfFeat = pitchClusters(folded, { gapRatio, gapAbs, maxSpeakers });

  // Roh-Cluster je Segment; Lücken (kein Pitch) erben den Cluster des zeitlich nächsten Segments.
  const segCluster = new Array(segments.length).fill(null);
  for (let k = 0; k < idxOfFeat.length; k++) segCluster[idxOfFeat[k]] = clusterOfFeat[k];
  for (let i = 0; i < segments.length; i++) {
    if (segCluster[i] != null) continue;
    let best = null, bestDist = Infinity;
    const mid = (segments[i].tStart + segments[i].tEnd) / 2;
    for (let j = 0; j < segments.length; j++) {
      if (segCluster[j] == null) continue;
      const dd = Math.abs(mid - (segments[j].tStart + segments[j].tEnd) / 2);
      if (dd < bestDist) { bestDist = dd; best = segCluster[j]; }
    }
    segCluster[i] = best != null ? best : clusterOfFeat[0];
  }

  // Pro Cluster: erstes zeitliches Auftreten merken (für „wer zuerst spricht = Ich").
  const clusterFirstIdx = new Map();
  for (let k = 0; k < clusterOfFeat.length; k++) {
    const cl = clusterOfFeat[k];
    const segIdx = idxOfFeat[k];
    if (!clusterFirstIdx.has(cl) || segIdx < clusterFirstIdx.get(cl)) clusterFirstIdx.set(cl, segIdx);
  }
  const clusterIds = [...clusterFirstIdx.keys()];
  const labelOf = labelClusters(clusterIds, clusterFirstIdx, channel);
  out.forEach((s, i) => { s.speaker = labelOf.get(segCluster[i]) || soloLabel; });
  return out;
}

module.exports = { diarizeLocal, segmentPitch, segmentRms, pitchClusters, labelClusters, segmentFeatures, fft, melFilterbank, framePitch, frameMFCC };
