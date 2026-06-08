// ChunkAccumulator — schneidet einen 16-bit-PCM-Strom in Transkriptions-Häppchen.
// Schneidet bevorzugt an einer Sprechpause (Stille) im Bereich [minBytes, maxBytes],
// damit nicht mitten im Wort/Satz getrennt wird; spätestens bei maxBytes hart (Fallback).
// tOffset = echte kumulierte Sekunden (Chunks dürfen variabel lang sein).
// Abwärtskompatibel: mit { windowSeconds } verhält er sich wie ein fester Schnitt.
'use strict';

const { rms } = require('../audio/pcm-utils');

class ChunkAccumulator {
  constructor({ sampleRate, windowSeconds, minSeconds, maxSeconds, silenceRms = 0.012, onChunk }) {
    this.sampleRate = sampleRate;
    const minS = minSeconds != null ? minSeconds : windowSeconds;
    const maxS = maxSeconds != null ? maxSeconds : windowSeconds;
    this.minBytes = Math.floor(minS * sampleRate) * 2;
    this.maxBytes = Math.floor(maxS * sampleRate) * 2;
    this.vad = this.maxBytes > this.minBytes; // VAD nur, wenn ein Spielraum existiert
    this.silenceRms = silenceRms;
    this.onChunk = onChunk;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
    this.emittedBytes = 0;
  }

  push(int16Buffer) {
    this.buf = Buffer.concat([this.buf, int16Buffer]);
    while (this.buf.length >= this.minBytes) {
      if (!this.vad) {
        this._emit(this.minBytes); // fester Schnitt (min == max)
        continue;
      }
      if (this.buf.length >= this.maxBytes) {
        // spätestens jetzt schneiden: Pause im [min,max] suchen, sonst hart bei max
        this._emit(this._findSilenceCut(this.minBytes, this.maxBytes) || this.maxBytes);
      } else {
        // zwischen min und aktueller Länge eine Pause suchen; sonst auf mehr Audio warten
        const cut = this._findSilenceCut(this.minBytes, this.buf.length);
        if (cut) this._emit(cut);
        else break;
      }
    }
  }

  // Sucht rückwärts (möglichst spät) ein leises ~200ms-Fenster zwischen from..to.
  // Liefert eine sample-ausgerichtete Schnittposition (Byte) oder 0.
  _findSilenceCut(fromBytes, toBytes) {
    const winBytes = Math.max(2, Math.floor(0.2 * this.sampleRate) * 2);
    for (let pos = toBytes - winBytes; pos >= fromBytes; pos -= winBytes) {
      const sub = this.buf.subarray(pos, pos + winBytes);
      if (rms(sub) < this.silenceRms) {
        let cut = pos + winBytes;
        cut -= cut % 2; // 2-Byte-Sample-Ausrichtung
        return cut;
      }
    }
    return 0;
  }

  _emit(cutAt) {
    const pcm = this.buf.subarray(0, cutAt);
    this.buf = this.buf.subarray(cutAt);
    this.onChunk({ pcm, seq: this.seq, tOffset: this.emittedBytes / 2 / this.sampleRate });
    this.emittedBytes += pcm.length;
    this.seq++;
  }

  flush() {
    if (this.buf.length > 0) {
      this.onChunk({ pcm: this.buf, seq: this.seq, tOffset: this.emittedBytes / 2 / this.sampleRate });
      this.emittedBytes += this.buf.length;
      this.buf = Buffer.alloc(0);
      this.seq++;
    }
  }
}

module.exports = { ChunkAccumulator };
