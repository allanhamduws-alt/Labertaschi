'use strict';
// Audio-Kompression (WAV -> Opus) für Meeting-Aufnahmen. Das Transkript ist die
// Hauptsache; Audio dient nur dem gelegentlichen Nachhören -> aggressive, kleine
// Opus-Dateien (~25× kleiner als WAV). Nutzt das gebündelte ffmpeg (ffmpeg-static),
// fällt auf System-ffmpeg zurück. Schlägt die Kompression fehl, bleibt die WAV erhalten.

const { spawn } = require('node:child_process');

const DEFAULT_BITRATE_K = 16; // 16 kbit/s Mono-Opus (VoIP) — sehr klein, für Sprache gut verständlich

/** ffmpeg-Argumente: WAV -> Opus (Ogg-Container). Reine Funktion (testbar). */
function buildOpusArgs(input, output, { bitrateK = DEFAULT_BITRATE_K } = {}) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-c:a', 'libopus', '-b:a', `${bitrateK}k`, '-application', 'voip', '-ac', '1',
    output,
  ];
}

/** ffmpeg-Argumente: beliebiges Audio -> 16 kHz mono 16-bit WAV (für Re-Diarize/Re-Transkription). */
function buildDecodeArgs(input, output, { sampleRate = 16000 } = {}) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-ar', String(sampleRate), '-ac', '1', '-c:a', 'pcm_s16le',
    output,
  ];
}

/** ffmpeg-Pfad: gebündelt (ffmpeg-static, asar-unpacked) bevorzugt, sonst System-ffmpeg. */
function resolveFfmpeg() {
  try {
    const p = require('ffmpeg-static');
    if (p && typeof p === 'string') return p.replace('app.asar', 'app.asar.unpacked');
  } catch { /* nicht installiert -> System-ffmpeg */ }
  return 'ffmpeg';
}

/** Führt ffmpeg aus; resolved true bei Exit-Code 0, sonst false (wirft nie). */
function runFfmpeg(args, { ffmpegPath, spawnImpl } = {}) {
  const bin = ffmpegPath || resolveFfmpeg();
  const sp = spawnImpl || spawn;
  return new Promise((resolve) => {
    let proc;
    try {
      proc = sp(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve(false);
      return;
    }
    if (proc.stderr) proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

/** Komprimiert eine WAV-Datei nach Opus. @returns {Promise<boolean>} */
async function compressToOpus(input, output, opts = {}) {
  return runFfmpeg(buildOpusArgs(input, output, opts), opts);
}

/** Dekodiert beliebiges Audio (z.B. Opus) zu 16 kHz mono WAV. @returns {Promise<boolean>} */
async function decodeToWav(input, output, opts = {}) {
  return runFfmpeg(buildDecodeArgs(input, output, opts), opts);
}

module.exports = {
  DEFAULT_BITRATE_K,
  buildOpusArgs,
  buildDecodeArgs,
  resolveFfmpeg,
  compressToOpus,
  decodeToWav,
};
