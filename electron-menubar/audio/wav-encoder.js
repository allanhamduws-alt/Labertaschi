// 16-bit PCM <-> WAV. CommonJS.
'use strict';

const fs = require('node:fs');

/** Baut einen 44-Byte-RIFF/WAVE-Header für `dataLength` Bytes PCM. */
function wavHeader(dataLength, { sampleRate = 16000, channels = 1 } = {}) {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/** 16-bit-PCM-Buffer -> komplette WAV (Header + Daten). */
function encodeWav(pcmBuffer, opts) {
  return Buffer.concat([wavHeader(pcmBuffer.length, opts), pcmBuffer]);
}

/** Mehrere reine PCM-Buffer zu einer WAV zusammenfügen. */
function concatWav(pcmBuffers, opts) {
  return encodeWav(Buffer.concat(pcmBuffers), opts);
}

/**
 * Fügt mehrere WAV-DATEIEN (gleiches Format) zu einer einzigen WAV zusammen –
 * streaming, mit konstantem Speicherbedarf (jeweils nur eine Datei im RAM).
 * Ideal für sehr lange Meetings: keine RAM-Akkumulation aller Audiodaten.
 * Erwartet Standard-44-Byte-WAV-Header in den Eingabedateien (PCM ab Byte 44).
 * @returns {number} Gesamt-PCM-Bytegröße
 */
function concatWavFiles(inputWavPaths, outPath, { sampleRate = 16000, channels = 1 } = {}) {
  // 1) Header mit Platzhalter-Größe schreiben
  fs.writeFileSync(outPath, wavHeader(0, { sampleRate, channels }));
  // 2) PCM jeder Quelldatei (ohne deren Header) anhängen
  let dataLength = 0;
  for (const p of inputWavPaths) {
    const buf = fs.readFileSync(p);
    if (buf.length <= 44) continue; // leer/kaputt -> überspringen
    const pcm = buf.subarray(44);
    fs.appendFileSync(outPath, pcm);
    dataLength += pcm.length;
  }
  // 3) Größenfelder im Header nachtragen (RIFF @4, data @40)
  const fd = fs.openSync(outPath, 'r+');
  try {
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(36 + dataLength, 0);
    fs.writeSync(fd, sizeBuf, 0, 4, 4);
    sizeBuf.writeUInt32LE(dataLength, 0);
    fs.writeSync(fd, sizeBuf, 0, 4, 40);
  } finally {
    fs.closeSync(fd);
  }
  return dataLength;
}

module.exports = { wavHeader, encodeWav, concatWav, concatWavFiles };
