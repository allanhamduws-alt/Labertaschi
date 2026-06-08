# Meeting-Recorder — Implementierungsplan (Phase 1)

> **Für ausführende Worker:** ERFORDERLICHER SUB-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`, um diesen Plan Task für Task umzusetzen. Steps nutzen Checkbox-Syntax (`- [ ]`) zur Nachverfolgung.

**Goal:** Paply um einen Meeting-/Telefonat-Recorder erweitern: Hotkey `Cmd+Shift+X` nimmt gleichzeitig Mikrofon (= „Ich") und macOS-System-Audio (= „Gegenstelle") auf, transkribiert near-live über Groq, speichert crash-sicher pro Session, erzeugt ein KI-Protokoll (4 Rubriken) und zeigt alles auf einer neuen Meetings-Seite.

**Architecture:** Der Electron-Main-Prozess orchestriert über einen `MeetingController` zwei Audioquellen — das Mikrofon (Web-Audio-PCM aus einem neuen Overlay-Fenster) und das System-Audio (`AudioTeeManager`, ein gebündeltes Swift-Binary nach Vorbild des `GlobeKeyManager`). Beide Ströme werden lückenlos in 30-s-WAV-Häppchen geschnitten, sofort auf Platte gesichert (crash-sicher, entkoppelt von der Transkription), einzeln an Groq Whisper geschickt und nach Zeitstempel zu einem sprecher-beschrifteten Transkript verschmolzen. Beim Stop erzeugt Groq Llama ein strukturiertes Protokoll. Die UI ist ein neuer Dashboard-Tab (Liste + Detail) plus ein kleines Always-on-top-Overlay (Mic-Icon + grüner Health-Punkt).

**Tech Stack:** Electron 33, React 19, Vite, TypeScript, Tailwind/shadcn, electron-store, Web Audio API (AudioWorklet), `audiotee` (npm) + Swift-Binary, Groq Whisper (`whisper-large-v3`) + Llama (`llama-3.3-70b-versatile`). Tests: **Vitest** (neu eingeführt) für reine Logik-Module.

**Referenz:** Spezifikation `docs/superpowers/specs/2026-06-08-meeting-recorder-design.md`. Exakte Code-Auszüge der bestehenden Integrationsstellen sind dort bzw. in den Task-Beschreibungen zitiert.

---

## Verbindliche Verträge (gelten für ALLE Tasks)

Alle neuen Main-seitigen Module sind **CommonJS** (`module.exports`, `require`) wie `electron-main.js`. Alle Pfade relativ zu `electron-menubar/`.

### Datenmodell (`src/types/meeting.d.ts`)
```typescript
export interface MeetingIndexEntry {
  id: string;            // `${startEpochMs}-${shortId}`
  startTime: string;     // ISO
  durationMs: number;
  title: string;         // auto aus Kurzzusammenfassung, editierbar
  speakerCount: number;
  preview: string;       // erste ~120 Zeichen des Transkripts
  hasSummary: boolean;
  favorite: boolean;
}
export interface MeetingSegment {
  tStart: number;        // Sekunden ab Sessionstart
  tEnd: number;
  speaker: 'me' | 'other' | string;  // Phase 2: 'other-1', ...
  channel: 'mic' | 'system';
  text: string;          // wortgetreu
}
export interface MeetingTranscript {
  segments: MeetingSegment[];
  language: string;
}
export interface MeetingTodo { text: string; verantwortlich: string | null; erledigt: boolean }
export interface MeetingSummary {
  kurzzusammenfassung: string;
  kernpunkte: string[];
  todos: MeetingTodo[];
  offeneFragen: string[];
  generatedAt: string;
  model: string;
}
export interface MeetingFull {
  index: MeetingIndexEntry;
  transcript: MeetingTranscript;
  summary: MeetingSummary | null;
  audio: { mic: string | null; system: string | null }; // absolute Pfade
}
```

### IPC-Kanäle (verbindliche Namen + Signaturen)
- **invoke** (renderer→main, Promise): `meeting:start` → `{id}` · `meeting:stop` → `{id}` · `meetings:list` → `MeetingIndexEntry[]` · `meetings:get` (id) → `MeetingFull|null` · `meetings:delete` (id) → `boolean` · `meetings:retranscribe` (id) → `boolean` · `meetings:regenerateSummary` (id) → `MeetingSummary|null` · `meetings:updateSpeakerName` (id, channel:'mic'|'system', name:string) → `boolean` · `meetings:toggleTodo` (id, todoIndex:number) → `boolean`
- **send** (renderer→main, fire-and-forget): `meeting:mic-chunk` (payload `{ seq:number, tOffset:number, wav:ArrayBuffer }`) · `meeting:mic-level` (rms:number 0..1)
- **events** (main→renderer via `.send`): `meeting:status` (`{ color:'green'|'yellow'|'red', reason:string, durationMs:number, micLevel:number, systemLevel:number }`) · `meeting:transcript-chunk` (`MeetingSegment[]`) · `meeting:started` (`{id}`) · `meeting:stopped` (`{id}`)

### Store-Defaults (Ergänzungen in `getStore()` defaults, electron-main.js:17–69)
```javascript
meetings: [],                          // MeetingIndexEntry[]
meetingHotkey: 'Command+Shift+X',      // in Settings änderbar
meetingSummaryModel: 'llama-3.3-70b-versatile',
```

### Groq-Parameter fürs Meeting (abweichend von der Diktat-Pipeline)
- STT: `model: 'whisper-large-v3'`, `response_format: 'verbose_json'`, `timestamp_granularities: ['segment']`, `language` aus Settings.
- Summary: `model` aus `meetingSummaryModel`, `response_format: { type: 'json_object' }`, `max_tokens: 2048`.

### Speicherlayout
```
<userData>/meetings/<id>/
  chunks/mic_000.wav, system_000.wav, ...   (crash-sicher, sofort geschrieben)
  audio_mic.wav, audio_system.wav            (beim Stop aus chunks konkateniert)
  transcript.json                            (MeetingTranscript)
  summary.json                               (MeetingSummary)
```
`<userData>` = `app.getPath('userData')` (= `~/Library/Application Support/paply-menubar`).

---

## Dateistruktur (neu / geändert)

**Neu (Main, CommonJS):**
- `audio/wav-encoder.js` — PCM↔WAV
- `audio/pcm-utils.js` — RMS, Downsampling, Int16-Konvertierung
- `meeting/chunk-accumulator.js` — sammelt PCM zu festen Zeitfenstern
- `meeting/transcript-merger.js` — verschmilzt zwei Kanäle chronologisch
- `meeting/meeting-store.js` — Index (electron-store) + Dateien (fs)
- `meeting/summary.js` — Prompt + robustes JSON-Parsing + Groq-Llama-Call
- `meeting/health-monitor.js` — Ampel-Logik (reine Funktion)
- `meeting/transcription-queue.js` — serielle Groq-Whisper-Verarbeitung mit Retry
- `meeting/meeting-controller.js` — Orchestrierung (start/stop, verdrahtet alles)
- `audio-tee-manager.js` — Child-Process-Wrapper fürs System-Audio (Vorbild: `globe-key-manager.js`)
- `scripts/build-audio-tee.js` — Binary-Build (Vorbild: `scripts/build-globe-listener.js`)
- `src/types/meeting.d.ts` — Datenmodell-Typen
- `src/meeting-overlay.html` + `src/apps/meeting-overlay/main.tsx` + `MeetingOverlay.tsx` + `mic-worklet.js` — Aufnahme-Overlay + Mic-PCM-Capture
- `src/apps/dashboard/views/MeetingsView.tsx` + `MeetingsList.tsx` + `MeetingDetail.tsx` — Meetings-Seite
- `vitest.config.ts` + `test/` — Test-Setup

**Geändert:**
- `electron-main.js` — Defaults, `registerHotkey()`, neuer Meeting-Hotkey, IPC-Handler, AudioTeeManager-Instanz, `createMeetingOverlayWindow()`, `will-quit`-Cleanup
- `preload.js` — neue Meeting-Methoden
- `src/types/electron.d.ts` — neue ElectronAPI-Signaturen
- `src/apps/dashboard/Dashboard.tsx` — NavItem + navItems + Render-Switch + Datenlade-Logik
- `src/apps/settings/SettingsApp.tsx` — Eingabefeld für Meeting-Hotkey
- `package.json` — Dependency `audiotee`, `extendInfo` (NSAudioCaptureUsageDescription), `extraResources`+`files` fürs Binary, `prebuild`/`compile:audio-tee`, `test`-Script
- `vite.config.ts` — neuer Entry `meeting-overlay`

---

## Meilenstein 0 — Fundament

### Task 0.1: Vitest einrichten

**Files:**
- Modify: `electron-menubar/package.json` (devDependencies + scripts)
- Create: `electron-menubar/vitest.config.ts`
- Create: `electron-menubar/test/smoke.test.js`

- [ ] **Step 1: Vitest installieren**

Run: `cd electron-menubar && npm i -D vitest`
Expected: `vitest` erscheint in devDependencies.

- [ ] **Step 2: `vitest.config.ts` anlegen**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js', 'audio/**/*.test.js', 'meeting/**/*.test.js'],
  },
});
```

- [ ] **Step 3: `test`-Script in package.json ergänzen**

In `"scripts"`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 4: Smoke-Test schreiben** (`test/smoke.test.js`)

```javascript
import { describe, it, expect } from 'vitest';
describe('smoke', () => {
  it('runs', () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd electron-menubar && npm test`
Expected: PASS, 1 Test grün.

- [ ] **Step 6: Commit**

```bash
git add electron-menubar/package.json electron-menubar/vitest.config.ts electron-menubar/test/smoke.test.js
git commit -m "test: Vitest-Setup für Meeting-Recorder-Logikmodule"
```

### Task 0.2: Datenmodell-Typen + Store-Defaults

**Files:**
- Create: `electron-menubar/src/types/meeting.d.ts` (Inhalt = Datenmodell-Block oben unter „Verbindliche Verträge")
- Modify: `electron-menubar/electron-main.js` (defaults in `getStore()`, nach Zeile 68 `favorites: []` → davor/danach ergänzen)

- [ ] **Step 1: `meeting.d.ts` mit dem Datenmodell aus den Verträgen anlegen** (exakt die Interfaces oben).

- [ ] **Step 2: Store-Defaults ergänzen** — in `getStore()` defaults-Objekt (electron-main.js:17) die drei Felder aus „Store-Defaults" oben einfügen (`meetings`, `meetingHotkey`, `meetingSummaryModel`).

- [ ] **Step 3: Verifizieren** — `cd electron-menubar && node -e "require('./electron-main.js')"` ist nicht sinnvoll (startet App); stattdessen Syntax-Check: `node --check electron-main.js`. Expected: keine Ausgabe (ok).

- [ ] **Step 4: Commit**

```bash
git add electron-menubar/src/types/meeting.d.ts electron-menubar/electron-main.js
git commit -m "feat(meeting): Datenmodell-Typen + Store-Defaults"
```

---

## Meilenstein 1 — Audio-Bausteine (reine Logik, TDD)

### Task 1.1: WAV-Encoder

**Files:**
- Create: `electron-menubar/audio/wav-encoder.js`
- Test: `electron-menubar/audio/wav-encoder.test.js`

Vertrag: `encodeWav(int16Buffer, { sampleRate, channels }) → Buffer` (RIFF/WAVE, 16-bit PCM). `concatWav(buffers[]) → Buffer` (mehrere reine PCM-Int16-Buffer zu einer WAV mit korrektem Header zusammenfügen).

- [ ] **Step 1: Failing test** (`wav-encoder.test.js`)

```javascript
import { describe, it, expect } from 'vitest';
import { encodeWav } from './wav-encoder.js';

describe('encodeWav', () => {
  it('schreibt einen 44-Byte-RIFF/WAVE-Header + PCM-Daten', () => {
    const pcm = Buffer.from(new Int16Array([0, 1000, -1000, 32767]).buffer);
    const wav = encodeWav(pcm, { sampleRate: 16000, channels: 1 });
    expect(wav.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.slice(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);     // sampleRate
    expect(wav.readUInt16LE(22)).toBe(1);          // channels
    expect(wav.readUInt16LE(34)).toBe(16);         // bitsPerSample
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.slice(44)).toEqual(pcm);
  });
});
```

- [ ] **Step 2: Test ausführen, FAIL erwarten** — Run: `npx vitest run audio/wav-encoder.test.js` → FAIL („encodeWav is not a function").

- [ ] **Step 3: Implementierung** (`wav-encoder.js`)

```javascript
// 16-bit PCM → WAV. CommonJS.
function encodeWav(pcmBuffer, { sampleRate = 16000, channels = 1 } = {}) {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function concatWav(pcmBuffers, opts) {
  return encodeWav(Buffer.concat(pcmBuffers), opts);
}

module.exports = { encodeWav, concatWav };
```

- [ ] **Step 4: Test ausführen, PASS erwarten** — Run: `npx vitest run audio/wav-encoder.test.js` → PASS.

- [ ] **Step 5: Commit** — `git add electron-menubar/audio/wav-encoder.* && git commit -m "feat(meeting): WAV-Encoder (TDD)"`

### Task 1.2: PCM-Utils (RMS + Downsampling + Float→Int16)

**Files:**
- Create: `electron-menubar/audio/pcm-utils.js`
- Test: `electron-menubar/audio/pcm-utils.test.js`

Vertrag: `floatTo16BitPCM(Float32Array) → Buffer` · `rms(int16Buffer) → number` (0..1) · `downsample(Float32Array, inRate, outRate) → Float32Array`.

- [ ] **Step 1: Failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { floatTo16BitPCM, rms, downsample } from './pcm-utils.js';

describe('pcm-utils', () => {
  it('floatTo16BitPCM klemmt und skaliert', () => {
    const buf = floatTo16BitPCM(new Float32Array([0, 1, -1, 2]));
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, 4);
    expect(i16[0]).toBe(0);
    expect(i16[1]).toBe(32767);
    expect(i16[2]).toBe(-32768);
    expect(i16[3]).toBe(32767); // geklemmt
  });
  it('rms von Stille ist 0, von Vollausschlag ~1', () => {
    expect(rms(floatTo16BitPCM(new Float32Array([0, 0, 0])))).toBeCloseTo(0, 5);
    expect(rms(floatTo16BitPCM(new Float32Array([1, -1, 1, -1])))).toBeCloseTo(1, 1);
  });
  it('downsample halbiert die Länge bei 2:1', () => {
    const out = downsample(new Float32Array([0, 0.5, 1, 0.5]), 32000, 16000);
    expect(out.length).toBe(2);
  });
});
```

- [ ] **Step 2: FAIL** — Run: `npx vitest run audio/pcm-utils.test.js`.

- [ ] **Step 3: Implementierung**

```javascript
function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return Buffer.from(out.buffer);
}

function rms(int16Buffer) {
  const i16 = new Int16Array(int16Buffer.buffer, int16Buffer.byteOffset, Math.floor(int16Buffer.length / 2));
  if (i16.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < i16.length; i++) { const v = i16[i] / 32768; sum += v * v; }
  return Math.sqrt(sum / i16.length);
}

function downsample(float32, inRate, outRate) {
  if (outRate >= inRate) return float32;
  const ratio = inRate / outRate;
  const newLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) out[i] = float32[Math.floor(i * ratio)];
  return out;
}

module.exports = { floatTo16BitPCM, rms, downsample };
```

- [ ] **Step 4: PASS** — Run: `npx vitest run audio/pcm-utils.test.js`.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): PCM-Utils (RMS/Downsample/Int16, TDD)"`

### Task 1.3: ChunkAccumulator

**Files:**
- Create: `electron-menubar/meeting/chunk-accumulator.js`
- Test: `electron-menubar/meeting/chunk-accumulator.test.js`

Vertrag: `new ChunkAccumulator({ sampleRate, windowSeconds, onChunk })`. `push(int16Buffer)` akkumuliert; sobald ≥ `windowSeconds` Samples vorliegen, ruft es `onChunk({ pcm: Buffer, seq, tOffset })` (tOffset = Sekunden seit Start) und behält den Rest. `flush()` gibt den letzten Teil-Chunk aus.

- [ ] **Step 1: Failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { ChunkAccumulator } from './chunk-accumulator.js';

describe('ChunkAccumulator', () => {
  it('emittiert volle Fenster und nummeriert sie', () => {
    const chunks = [];
    const acc = new ChunkAccumulator({ sampleRate: 100, windowSeconds: 1, onChunk: (c) => chunks.push(c) });
    const oneSec = Buffer.alloc(100 * 2); // 100 samples * 2 bytes
    acc.push(oneSec);
    acc.push(oneSec);
    expect(chunks.length).toBe(2);
    expect(chunks[0].seq).toBe(0);
    expect(chunks[0].tOffset).toBe(0);
    expect(chunks[1].seq).toBe(1);
    expect(chunks[1].tOffset).toBe(1);
  });
  it('flush gibt Restdaten aus', () => {
    const chunks = [];
    const acc = new ChunkAccumulator({ sampleRate: 100, windowSeconds: 1, onChunk: (c) => chunks.push(c) });
    acc.push(Buffer.alloc(50 * 2));
    expect(chunks.length).toBe(0);
    acc.flush();
    expect(chunks.length).toBe(1);
  });
});
```

- [ ] **Step 2: FAIL** — Run: `npx vitest run meeting/chunk-accumulator.test.js`.

- [ ] **Step 3: Implementierung**

```javascript
class ChunkAccumulator {
  constructor({ sampleRate, windowSeconds, onChunk }) {
    this.bytesPerWindow = sampleRate * windowSeconds * 2; // 16-bit
    this.windowSeconds = windowSeconds;
    this.onChunk = onChunk;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
  }
  push(int16Buffer) {
    this.buf = Buffer.concat([this.buf, int16Buffer]);
    while (this.buf.length >= this.bytesPerWindow) {
      const pcm = this.buf.subarray(0, this.bytesPerWindow);
      this.buf = this.buf.subarray(this.bytesPerWindow);
      this.onChunk({ pcm, seq: this.seq, tOffset: this.seq * this.windowSeconds });
      this.seq++;
    }
  }
  flush() {
    if (this.buf.length > 0) {
      this.onChunk({ pcm: this.buf, seq: this.seq, tOffset: this.seq * this.windowSeconds });
      this.buf = Buffer.alloc(0);
      this.seq++;
    }
  }
}
module.exports = { ChunkAccumulator };
```

- [ ] **Step 4: PASS** + **Step 5: Commit** — `git commit -am "feat(meeting): ChunkAccumulator (TDD)"`

### Task 1.4: TranscriptMerger

**Files:**
- Create: `electron-menubar/meeting/transcript-merger.js`
- Test: `electron-menubar/meeting/transcript-merger.test.js`

Vertrag: `mergeSegments(micSegs, systemSegs) → MeetingSegment[]`. Eingabe je Kanal: `[{ tStart, tEnd, text }]`. Ausgabe: chronologisch nach `tStart` sortiert, mit `speaker` ('me'/'other') und `channel` ('mic'/'system') gesetzt. Aufeinanderfolgende Segmente desselben Sprechers werden NICHT zusammengeführt (Wortgetreue, R7).

- [ ] **Step 1: Failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { mergeSegments } from './transcript-merger.js';

describe('mergeSegments', () => {
  it('verschmilzt zwei Kanäle chronologisch mit Sprecher-Labels', () => {
    const mic = [{ tStart: 0, tEnd: 2, text: 'Hallo' }, { tStart: 5, tEnd: 6, text: 'Ja genau' }];
    const sys = [{ tStart: 2, tEnd: 4, text: 'Guten Tag' }];
    const out = mergeSegments(mic, sys);
    expect(out.map(s => s.text)).toEqual(['Hallo', 'Guten Tag', 'Ja genau']);
    expect(out[0]).toMatchObject({ speaker: 'me', channel: 'mic' });
    expect(out[1]).toMatchObject({ speaker: 'other', channel: 'system' });
  });
  it('ist stabil bei gleichem tStart (mic vor system)', () => {
    const out = mergeSegments([{ tStart: 1, tEnd: 2, text: 'A' }], [{ tStart: 1, tEnd: 2, text: 'B' }]);
    expect(out.map(s => s.text)).toEqual(['A', 'B']);
  });
});
```

- [ ] **Step 2: FAIL** — Run: `npx vitest run meeting/transcript-merger.test.js`.

- [ ] **Step 3: Implementierung**

```javascript
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
```

- [ ] **Step 4: PASS** + **Step 5: Commit** — `git commit -am "feat(meeting): TranscriptMerger (TDD)"`

---

## Meilenstein 2 — System-Audio-Capture (AudioTee)

### Task 2.1: AudioTee-Dependency + Binary-Build + Bündelung

**Files:**
- Modify: `electron-menubar/package.json`
- Create: `electron-menubar/scripts/build-audio-tee.js`

Hinweis: Das npm-Paket `audiotee` liefert das Swift-Binary mit. Strategie: `build-audio-tee.js` lokalisiert das mitgelieferte Binary (`node_modules/audiotee/.../audiotee`) bzw. kompiliert aus Quelle und kopiert es nach `resources/bin/audiotee` — analog zu `scripts/build-globe-listener.js`.

- [ ] **Step 1: Dependency installieren** — Run: `cd electron-menubar && npm i audiotee`. Danach prüfen, wo das Binary liegt: `find node_modules/audiotee -type f -name 'audiotee*'` und Pfad notieren.

- [ ] **Step 2: `scripts/build-audio-tee.js` anlegen** (Vorbild `build-globe-listener.js`):

```javascript
#!/usr/bin/env node
// Stellt das AudioTee-Binary unter resources/bin/audiotee bereit (macOS-only).
const path = require('path');
const fs = require('fs');

const OUT_DIR = path.join(__dirname, '..', 'resources', 'bin');
const OUT = path.join(OUT_DIR, 'audiotee');

if (process.platform !== 'darwin') { console.log('[audiotee] Skip — nicht macOS'); process.exit(0); }

// Kandidaten-Pfade des von npm gelieferten Binaries (beim Step-1-Befund anpassen):
const candidates = [
  path.join(__dirname, '..', 'node_modules', 'audiotee', 'bin', 'audiotee'),
  path.join(__dirname, '..', 'node_modules', 'audiotee', 'audiotee'),
];
const src = candidates.find(p => fs.existsSync(p));
if (!src) { console.error('[audiotee] Binary nicht gefunden in node_modules/audiotee'); process.exit(1); }

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(src, OUT);
fs.chmodSync(OUT, 0o755);
console.log(`[audiotee] Bereitgestellt: ${OUT}`);
```

- [ ] **Step 3: package.json `build` erweitern** — in `build.mac.extraResources` einen Eintrag ergänzen (analog macos-globe-listener):
```json
{ "from": "resources/bin/audiotee", "to": "bin/audiotee" }
```
in `build.files` `"audio-tee-manager.js"`, `"audio/**/*"`, `"meeting/**/*"` ergänzen, und in `build.mac` `"extendInfo"` setzen:
```json
"extendInfo": {
  "NSAudioCaptureUsageDescription": "Paply nimmt das System-Audio auf, um Meetings und Telefonate zu transkribieren.",
  "NSMicrophoneUsageDescription": "Paply nimmt dein Mikrofon auf, um Gesprochenes zu transkribieren."
}
```

- [ ] **Step 4: prebuild-Hook erweitern** — in `scripts`: `"compile:audio-tee": "node scripts/build-audio-tee.js"` und `"prebuild": "npm run compile:globe && npm run compile:audio-tee"`.

- [ ] **Step 5: Build-Step ausführen** — Run: `cd electron-menubar && npm run compile:audio-tee`. Expected: „Bereitgestellt: …/resources/bin/audiotee" und Datei existiert.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "build(meeting): AudioTee-Binary bündeln + NSAudioCaptureUsageDescription"`

### Task 2.2: AudioTeeManager (Child-Process-Wrapper)

**Files:**
- Create: `electron-menubar/audio-tee-manager.js`
- Test: `electron-menubar/audio-tee-manager.test.js`

Vertrag (Vorbild `globe-key-manager.js`): `class AudioTeeManager extends EventEmitter`. `start({ sampleRate=16000, excludePid })` spawnt das Binary, liest **rohes PCM aus stdout** und emittiert `'pcm'` (Buffer, Int16 LE mono @ sampleRate). Weiter: `'log'`, `'error'`, `'started'`, `'stopped'`. `stop()` killt den Prozess. `_resolveBinary()` sucht dev- und packaged-Pfade wie beim GlobeKeyManager. Eine reine Hilfsfunktion `buildArgs(opts)` ist testbar.

> AudioTee-CLI-Flags beim Step-1-Befund verifizieren (`audiotee --help`). Annahme: `--sample-rate <n>`, `--exclude-process <pid>`, PCM nach stdout. `buildArgs` entsprechend anpassen.

- [ ] **Step 1: Failing test** (testet die reine Argument-Bildung, nicht den Spawn)

```javascript
import { describe, it, expect } from 'vitest';
const { buildArgs } = require('./audio-tee-manager.js');

describe('AudioTeeManager.buildArgs', () => {
  it('setzt Sample-Rate und Exclude-PID', () => {
    expect(buildArgs({ sampleRate: 16000, excludePid: 4242 }))
      .toEqual(['--sample-rate', '16000', '--exclude-process', '4242']);
  });
  it('ohne excludePid kein Exclude-Flag', () => {
    expect(buildArgs({ sampleRate: 16000 })).toEqual(['--sample-rate', '16000']);
  });
});
```

- [ ] **Step 2: FAIL** — Run: `npx vitest run audio-tee-manager.test.js`.

- [ ] **Step 3: Implementierung** — Datei nach Muster `globe-key-manager.js`. Kern:

```javascript
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const EventEmitter = require('node:events');

function buildArgs({ sampleRate = 16000, excludePid } = {}) {
  const args = ['--sample-rate', String(sampleRate)];
  if (excludePid) args.push('--exclude-process', String(excludePid));
  return args;
}

class AudioTeeManager extends EventEmitter {
  constructor() { super(); this.process = null; this.isSupported = process.platform === 'darwin'; }
  start(opts = {}) {
    if (!this.isSupported || this.process) return;
    const bin = this._resolveBinary();
    if (!bin) { this.emit('error', new Error('AudioTee-Binary nicht gefunden')); return; }
    try { fs.accessSync(bin, fs.constants.X_OK); } catch { try { fs.chmodSync(bin, 0o755); } catch {} }
    this.process = spawn(bin, buildArgs(opts), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.emit('started');
    this.process.stdout.on('data', (buf) => this.emit('pcm', buf));   // rohes PCM
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (d) => this.emit('log', d.trim()));
    this.process.on('error', (err) => { this.emit('error', err); this.process = null; });
    this.process.on('exit', () => { this.process = null; this.emit('stopped'); });
  }
  stop() { if (this.process) { this.process.kill(); this.process = null; } }
  get isRunning() { return this.process !== null; }
  _resolveBinary() {
    const candidates = [
      path.join(__dirname, 'resources', 'bin', 'audiotee'),
      ...(process.resourcesPath ? [
        path.join(process.resourcesPath, 'bin', 'audiotee'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'bin', 'audiotee'),
      ] : []),
    ];
    for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
    return null;
  }
}
module.exports = AudioTeeManager;
module.exports.buildArgs = buildArgs;
```

- [ ] **Step 4: PASS** — Run: `npx vitest run audio-tee-manager.test.js`.

- [ ] **Step 5: Manuelle Geräte-Verifikation** (kein Unit-Test): Run: `cd electron-menubar && node -e "const M=require('./audio-tee-manager');const m=new M();let n=0;m.on('pcm',b=>{n+=b.length;});m.on('log',l=>console.log('log',l));m.on('error',e=>console.log('err',e.message));m.start({sampleRate:16000});setTimeout(()=>{m.stop();console.log('PCM bytes:',n);},4000);"` — währenddessen Audio abspielen. Beim ersten Lauf erscheint ggf. der macOS-Berechtigungsdialog „Systemaudioaufnahme". Nach Erteilung: `PCM bytes` > 0.

- [ ] **Step 6: Commit** — `git add electron-menubar/audio-tee-manager.* && git commit -m "feat(meeting): AudioTeeManager (System-Audio via Core Audio Taps)"`

---

## Meilenstein 3 — Persistenz, Summary, Health (reine Logik, TDD)

### Task 3.1: MeetingStore

**Files:**
- Create: `electron-menubar/meeting/meeting-store.js`
- Test: `electron-menubar/meeting/meeting-store.test.js`

Vertrag: Factory `createMeetingStore({ baseDir, store })` (Dependency-Injection: `baseDir` = Meetings-Wurzel, `store` = electron-store-ähnliches Objekt mit `get/set`; im Test ein Fake). Methoden:
`create(startTime) → id` (legt Ordner + chunks/ an, Index-Eintrag) · `chunkPath(id, channel, seq) → string` · `saveTranscript(id, MeetingTranscript)` · `loadTranscript(id)` · `saveSummary(id, MeetingSummary)` · `finalizeIndex(id, { durationMs, title, speakerCount, preview, hasSummary })` · `list() → MeetingIndexEntry[]` · `get(id) → MeetingFull|null` · `remove(id) → boolean` · `updateSpeakerName(id, channel, name)` · `toggleTodo(id, idx)`.

- [ ] **Step 1: Failing test** (nutzt einen tmp-Ordner + Fake-Store)

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const { createMeetingStore } = require('./meeting-store.js');

function fakeStore() {
  const data = { meetings: [] };
  return { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

describe('MeetingStore', () => {
  let baseDir, store, ms;
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paply-meet-'));
    store = fakeStore();
    ms = createMeetingStore({ baseDir, store });
  });
  it('create legt Ordner + Index an', () => {
    const id = ms.create('2026-06-08T10:00:00.000Z');
    expect(fs.existsSync(path.join(baseDir, id, 'chunks'))).toBe(true);
    expect(ms.list().length).toBe(1);
    expect(ms.list()[0].id).toBe(id);
  });
  it('saveTranscript + get liefert Segmente', () => {
    const id = ms.create('2026-06-08T10:00:00.000Z');
    ms.saveTranscript(id, { segments: [{ tStart: 0, tEnd: 1, speaker: 'me', channel: 'mic', text: 'Hi' }], language: 'de' });
    expect(ms.get(id).transcript.segments[0].text).toBe('Hi');
  });
  it('toggleTodo schaltet erledigt um', () => {
    const id = ms.create('2026-06-08T10:00:00.000Z');
    ms.saveSummary(id, { kurzzusammenfassung: '', kernpunkte: [], todos: [{ text: 'X', verantwortlich: null, erledigt: false }], offeneFragen: [], generatedAt: '', model: '' });
    ms.toggleTodo(id, 0);
    expect(ms.get(id).summary.todos[0].erledigt).toBe(true);
  });
  it('remove löscht Ordner + Index', () => {
    const id = ms.create('2026-06-08T10:00:00.000Z');
    expect(ms.remove(id)).toBe(true);
    expect(ms.list().length).toBe(0);
    expect(fs.existsSync(path.join(baseDir, id))).toBe(false);
  });
});
```

- [ ] **Step 2: FAIL** — Run: `npx vitest run meeting/meeting-store.test.js`.

- [ ] **Step 3: Implementierung** — CommonJS, nutzt `fs`/`path`. `create` erzeugt `id = `${Date.parse(startTime)}-${Math.random().toString(36).slice(2,8)}``, Index-Eintrag mit Defaults (`title` = ISO-Datum, `speakerCount: 1`, `preview: ''`, `hasSummary: false`, `favorite: false`). Dateien: `transcript.json`, `summary.json` via `fs.writeFileSync(JSON.stringify)`. `get` liest beide (summary optional). `updateSpeakerName` ersetzt in `transcript.segments` alle `channel===channel`-Einträge: `speaker = name`. `finalizeIndex` mergt Felder in den Index-Eintrag und `store.set('meetings', ...)`.

- [ ] **Step 4: PASS** — Run: `npx vitest run meeting/meeting-store.test.js`.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): MeetingStore (Index+Dateien, TDD)"`

### Task 3.2: Summary (Prompt + Parsing + Groq-Call)

**Files:**
- Create: `electron-menubar/meeting/summary.js`
- Test: `electron-menubar/meeting/summary.test.js`

Vertrag: `getMeetingSummaryPrompt(transcriptText, language) → string` · `parseSummaryJson(raw) → MeetingSummary` (robust: greift JSON aus evtl. Markdown-Fences, füllt fehlende Felder mit Defaults) · `async generateMeetingSummary(transcriptText, { apiKey, model, language, fetchImpl }) → MeetingSummary` (Groq-Chat-Call, `fetchImpl` injizierbar fürs Testen).

- [ ] **Step 1: Failing test** (Prompt + Parsing + Call mit Fake-fetch)

```javascript
import { describe, it, expect } from 'vitest';
const { getMeetingSummaryPrompt, parseSummaryJson, generateMeetingSummary } = require('./summary.js');

describe('summary', () => {
  it('Prompt enthält die 4 Rubriken und das Transkript', () => {
    const p = getMeetingSummaryPrompt('Max: Hallo', 'de');
    expect(p).toContain('kurzzusammenfassung');
    expect(p).toContain('kernpunkte');
    expect(p).toContain('todos');
    expect(p).toContain('offeneFragen');
    expect(p).toContain('Max: Hallo');
  });
  it('parseSummaryJson liest JSON aus ```json-Fences', () => {
    const raw = '```json\n{"kurzzusammenfassung":"X","kernpunkte":["A"],"todos":[],"offeneFragen":[]}\n```';
    const s = parseSummaryJson(raw);
    expect(s.kurzzusammenfassung).toBe('X');
    expect(s.kernpunkte).toEqual(['A']);
    expect(Array.isArray(s.todos)).toBe(true);
  });
  it('generateMeetingSummary ruft Groq und parst', async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"kurzzusammenfassung":"Z","kernpunkte":[],"todos":[],"offeneFragen":[]}' } }] }) });
    const s = await generateMeetingSummary('T', { apiKey: 'k', model: 'llama-3.3-70b-versatile', language: 'de', fetchImpl: fakeFetch });
    expect(s.kurzzusammenfassung).toBe('Z');
    expect(s.model).toBe('llama-3.3-70b-versatile');
  });
});
```

- [ ] **Step 2: FAIL** — Run: `npx vitest run meeting/summary.test.js`.

- [ ] **Step 3: Implementierung** — `getMeetingSummaryPrompt` weist explizit an, NUR ein JSON-Objekt mit exakt diesen Keys (`kurzzusammenfassung` string, `kernpunkte` string[], `todos` `{text,verantwortlich,erledigt:false}`[], `offeneFragen` string[]) auf Deutsch zurückzugeben, Fakten/Namen/Zahlen beizubehalten, nicht zu erfinden. `parseSummaryJson` strippt ```-Fences, `JSON.parse`, füllt fehlende Felder mit `[]`/`''`. `generateMeetingSummary` postet an `GROQ_CHAT_URL` mit `response_format:{type:'json_object'}`, `messages:[{role:'system',...},{role:'user', content: prompt}]`, setzt `generatedAt = new Date().toISOString()`, `model`. Endpoint-Konstante hier lokal definieren: `const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';`. `fetchImpl` default `globalThis.fetch`.

- [ ] **Step 4: PASS** — Run: `npx vitest run meeting/summary.test.js`.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): KI-Protokoll-Prompt + Parsing + Groq-Call (TDD)"`

### Task 3.3: HealthMonitor

**Files:**
- Create: `electron-menubar/meeting/health-monitor.js`
- Test: `electron-menubar/meeting/health-monitor.test.js`

Vertrag: `evaluateHealth({ micWriteOk, systemProcessAlive, systemPermissionDenied, diskError, micLevel, systemLevel, secondsSinceSystemAudio }) → { color, reason }`. Regeln (Priorität): `diskError` → rot „Speicherproblem". `systemPermissionDenied` → rot „Systemaudio-Berechtigung fehlt". `!systemProcessAlive` → rot „System-Audio gestoppt". `!micWriteOk` → rot „Aufnahme wird nicht gesichert". `secondsSinceSystemAudio > 60` → gelb „System-Audio still". sonst → grün „Aufnahme läuft & wird gesichert".

- [ ] **Step 1: Failing test**

```javascript
import { describe, it, expect } from 'vitest';
const { evaluateHealth } = require('./health-monitor.js');

const base = { micWriteOk: true, systemProcessAlive: true, systemPermissionDenied: false, diskError: false, micLevel: 0.2, systemLevel: 0.2, secondsSinceSystemAudio: 0 };

describe('evaluateHealth', () => {
  it('grün im Normalfall', () => { expect(evaluateHealth(base).color).toBe('green'); });
  it('rot bei fehlender Systemaudio-Berechtigung', () => {
    expect(evaluateHealth({ ...base, systemPermissionDenied: true }).color).toBe('red');
  });
  it('rot wenn Mic nicht gesichert wird', () => {
    expect(evaluateHealth({ ...base, micWriteOk: false }).color).toBe('red');
  });
  it('gelb bei langer System-Stille', () => {
    expect(evaluateHealth({ ...base, secondsSinceSystemAudio: 90 }).color).toBe('yellow');
  });
});
```

- [ ] **Step 2: FAIL** + **Step 3: Implementierung** (Regelkaskade wie oben) + **Step 4: PASS** — Run: `npx vitest run meeting/health-monitor.test.js`.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): HealthMonitor-Ampellogik (TDD)"`

---

## Meilenstein 4 — Transkriptions-Queue (Groq Whisper)

### Task 4.1: TranscriptionQueue

**Files:**
- Create: `electron-menubar/meeting/transcription-queue.js`
- Test: `electron-menubar/meeting/transcription-queue.test.js`

Vertrag: `class TranscriptionQueue({ apiKey, language, fetchImpl })`. `enqueue({ channel, wavBuffer, tOffset })` reiht ein; serielle Abarbeitung; ruft Groq Whisper (`whisper-large-v3`, `verbose_json`, segment-Timestamps); für jedes Ergebnis-Segment wird `tOffset` aufaddiert; emittiert `'segments'` (`{ channel, segments:[{tStart,tEnd,text}] }`) und `'error'`. Retry mit Backoff (max 3) wie in `transcribeAudio`. `idle()` Promise resolved, wenn Queue leer. `parseVerbose(json, tOffset)` ist reine, testbare Funktion.

- [ ] **Step 1: Failing test** (parseVerbose + ein enqueue mit Fake-fetch)

```javascript
import { describe, it, expect } from 'vitest';
const { TranscriptionQueue, parseVerbose } = require('./transcription-queue.js');

describe('transcription-queue', () => {
  it('parseVerbose verschiebt Segment-Zeiten um tOffset', () => {
    const json = { segments: [{ start: 0, end: 1.5, text: ' Hallo' }, { start: 1.5, end: 2, text: ' Welt' }] };
    const segs = parseVerbose(json, 30);
    expect(segs).toEqual([{ tStart: 30, tEnd: 31.5, text: 'Hallo' }, { tStart: 31.5, tEnd: 32, text: 'Welt' }]);
  });
  it('enqueue transkribiert und emittiert segments', async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ segments: [{ start: 0, end: 1, text: 'Hi' }] }) });
    const q = new TranscriptionQueue({ apiKey: 'k', language: 'de', fetchImpl: fakeFetch });
    const got = [];
    q.on('segments', (e) => got.push(e));
    q.enqueue({ channel: 'mic', wavBuffer: Buffer.alloc(44), tOffset: 0 });
    await q.idle();
    expect(got[0].channel).toBe('mic');
    expect(got[0].segments[0].text).toBe('Hi');
  });
});
```

- [ ] **Step 2: FAIL** — Run: `npx vitest run meeting/transcription-queue.test.js`.

- [ ] **Step 3: Implementierung** — `EventEmitter`. POST an `GROQ_API_URL` mit `FormData` (`file` = `new Blob([wavBuffer], {type:'audio/wav'})`, name `chunk.wav`; `model`,`language`,`response_format='verbose_json'`,`timestamp_granularities[]='segment'`). `parseVerbose` mappt `segments[]` → `{tStart:start+tOffset, tEnd:end+tOffset, text:text.trim()}`, leere raus. Serielle Queue (`this.chain = this.chain.then(...)`), `idle()` gibt `this.chain` zurück.

- [ ] **Step 4: PASS** — Run: `npx vitest run meeting/transcription-queue.test.js`.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): TranscriptionQueue (Groq Whisper, TDD)"`

---

## Meilenstein 5 — Mic-Capture-Overlay (Renderer)

### Task 5.1: Overlay-Fenster + Vite-Entry + Bootstrap

**Files:**
- Create: `electron-menubar/src/meeting-overlay.html`
- Create: `electron-menubar/src/apps/meeting-overlay/main.tsx`
- Create: `electron-menubar/src/apps/meeting-overlay/MeetingOverlay.tsx` (Platzhalter, in 5.2 gefüllt)
- Modify: `electron-menubar/vite.config.ts`

- [ ] **Step 1: HTML-Template** (`meeting-overlay.html`) nach Vorbild `recording.html` (transparenter Body, `-webkit-app-region: drag`, `#root`, Script → `./apps/meeting-overlay/main.tsx`).

- [ ] **Step 2: `main.tsx`** nach Vorbild `apps/dashboard/main.tsx` (mountet `<MeetingOverlay/>`, importiert `../../globals.css`).

- [ ] **Step 3: `MeetingOverlay.tsx` Platzhalter** — `export function MeetingOverlay(){ return <div/> }`.

- [ ] **Step 4: Vite-Entry ergänzen** — in `vite.config.ts` `rollupOptions.input`:
```typescript
'meeting-overlay': path.resolve(__dirname, 'src/meeting-overlay.html'),
```

- [ ] **Step 5: Build verifizieren** — Run: `cd electron-menubar && npm run vite:build`. Expected: `renderer/meeting-overlay.html` existiert.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(meeting): Overlay-Fenster + Vite-Entry"`

### Task 5.2: MeetingOverlay-Komponente (Mic-Icon + grüner Punkt + Pegel)

**Files:**
- Modify: `electron-menubar/src/apps/meeting-overlay/MeetingOverlay.tsx`

Anforderung (Spec §4.8): sehr kleines Always-on-top-Icon — Mikrofon-Symbol + Pegelbalken (wie `RecordingWidget`, kleiner) + kleiner Gesundheitspunkt (grün/gelb/rot). Auf Hover ausklappbar: Dauer + Stop-Button. Bezieht Status über `onMeetingStatus`, Stop über `stopMeeting()`.

- [ ] **Step 1: Implementierung** — React-Komponente: hört `window.electronAPI.onMeetingStatus(cb)`, hält `{color, durationMs, micLevel, systemLevel, reason}` in State. Rendert ein `cn`-gestyltes kompaktes Pill (kleiner als `RecordingWidget`: `px-2 py-1 rounded-xl`), darin: Mic-Icon (lucide `Mic`), ein animierter Pegelbalken (Höhe aus `micLevel`/`systemLevel`), und ein `w-2 h-2 rounded-full` Punkt mit Farbe nach `color` (grün=`bg-green-500`, gelb=`bg-yellow-500`, rot=`bg-red-500`). Auf `hover` (State `expanded`) zusätzlich Dauer (`mm:ss` aus `durationMs`) + kleiner Stop-Button (`onClick={() => window.electronAPI.stopMeeting()}`). Bei `color==='red'` `reason` als Tooltip/Text zeigen.

- [ ] **Step 2: Build** — Run: `cd electron-menubar && npm run vite:build`. Expected: kein TS-Fehler. (Die neuen `electronAPI`-Methoden werden in Task 7.2 typisiert; bis dahin ggf. `// @ts-expect-error` an den Aufrufen oder Task 7.2 vorziehen.)

- [ ] **Step 3: Commit** — `git commit -am "feat(meeting): MeetingOverlay-UI (Mic-Icon + Health-Punkt + Pegel)"`

### Task 5.3: Mic-PCM-Capture via AudioWorklet

**Files:**
- Create: `electron-menubar/src/apps/meeting-overlay/mic-worklet.js` (AudioWorkletProcessor)
- Modify: `electron-menubar/src/apps/meeting-overlay/MeetingOverlay.tsx`
- Modify: `electron-menubar/vite.config.ts` (Worklet als statisches Asset/zusätzlicher Input falls nötig)

Begründung: MediaRecorder-WebM-Fragmente sind einzeln nicht dekodierbar; daher rohes PCM. Der Worklet liefert Float32-Frames; im Hauptthread → Downsample auf 16 kHz → Int16 → in ~1-s-Paketen + Pegel (RMS) an Main: aber das eigentliche 30-s-Schneiden macht der Main-Prozess (ChunkAccumulator). Der Renderer sendet kontinuierlich kleine PCM-Pakete via `meeting:mic-chunk`-**Rohpfad**. **Korrektur fürs einfache Modell:** Renderer sendet rohe Int16-PCM-Pakete (~1 s) als `meeting:mic-pcm` (ArrayBuffer) + `meeting:mic-level`; der Main-ChunkAccumulator bildet daraus 30-s-WAV. (Vertrag ergänzt: send `meeting:mic-pcm` (ArrayBuffer Int16@16k mono).)

- [ ] **Step 1: AudioWorkletProcessor** (`mic-worklet.js`)

```javascript
class MicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0)); // Float32Array @ context sampleRate
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
```

- [ ] **Step 2: Capture-Logik in MeetingOverlay** — bei `onMeetingStarted`: `getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true}})`, `AudioContext`, `audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url))`, `MediaStreamSource → AudioWorkletNode('mic-processor')`. Im `port.onmessage`: Float32 → `downsample(ctx.sampleRate→16000)` (gleiche Logik wie `pcm-utils`, hier im Renderer als kleine lokale Kopie) → Int16 → puffern bis ~1 s → `window.electronAPI.sendMicPcm(int16.buffer)` und `window.electronAPI.sendMicLevel(rms)`. Bei `onMeetingStopped`: Tracks/Context schließen.

- [ ] **Step 3: Manuelle Verifikation** — wird in Meilenstein 8 (End-to-End) geprüft. Hier nur Build: `npm run vite:build` ok.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(meeting): Mic-PCM-Capture via AudioWorklet im Overlay"`

---

## Meilenstein 6 — MeetingController (Orchestrierung im Main)

### Task 6.1: MeetingController

**Files:**
- Create: `electron-menubar/meeting/meeting-controller.js`
- Modify: `electron-main.js` (Instanziierung + Verdrahtung)

Vertrag: Factory `createMeetingController({ store, meetingStore, audioTee, getOverlayWindow, getMainWindow, fetchImpl })`. Methoden `start()`/`stop()`/`isActive()`. Verdrahtung:
- `start()`: neue `meetingStore.create(now)`-Session; Overlay-Fenster öffnen (`getOverlayWindow()`), `meeting:started` senden; `audioTee.start({sampleRate:16000, excludePid: process.pid})`; zwei `ChunkAccumulator` (mic, system, 30 s); zwei `TranscriptionQueue`-Instanzen oder eine geteilte; Health-Timer (1 s).
- Eingehendes System-PCM (`audioTee.on('pcm')`) → systemAccumulator.push; eingehendes Mic-PCM (über IPC `meeting:mic-pcm`, von electron-main an den Controller weitergereicht via `onMicPcm(buf)`-Methode) → micAccumulator.push.
- `onChunk(channel)`: WAV bauen (`encodeWav`), als `chunks/<channel>_<seq>.wav` schreiben (crash-sicher, vor Transkription), in TranscriptionQueue einreihen.
- Queue-`'segments'` → in laufende Transkript-Sammlung einsortieren, `mergeSegments` neu berechnen, `meeting:transcript-chunk` ans Overlay/Main senden, `meetingStore.saveTranscript` (throttled).
- Health-Timer: `evaluateHealth(...)` aus aktuellen Metriken (micWriteOk, audioTee.isRunning, letzter System-PCM-Zeitpunkt, letzter Schreibfehler, Pegel) → `meeting:status` senden.
- `stop()`: Accumulators `flush()`, `audioTee.stop()`, auf `queue.idle()` warten, finale `audio_mic.wav`/`audio_system.wav` aus chunks konkatenieren (`concatWav`), `meetingStore.saveTranscript` final, `meetingStore.finalizeIndex(...)` (durationMs, title aus erster Zusammenfassung später, preview aus erstem Segmenttext, speakerCount), dann `generateMeetingSummary(...)` → `meetingStore.saveSummary` → `finalizeIndex({hasSummary:true, title})`, `meeting:stopped` senden, Overlay schließen, Main-Window `meetings`-Liste aktualisieren lassen.

> Diese Klasse ist die Verdrahtung; sie wird über die bereits getesteten Module gebaut. Ein leichter Integrationstest mit Fakes ist sinnvoll (Step 1), die echte Geräte-Prüfung erfolgt in Meilenstein 8.

- [ ] **Step 1: Integrationstest mit Fakes** (`meeting/meeting-controller.test.js`) — Fake `audioTee` (EventEmitter), Fake `meetingStore` (in-memory + tmp), Fake `fetchImpl` (liefert ein Whisper-Segment und eine Summary), Fake Fenster (`{webContents:{send(){}}}`). Test: nach `start()`, Einspeisen von genügend System-PCM für ≥1 Chunk und `onMicPcm`, dann `stop()` → erwartet: `meetingStore.get(id).transcript.segments.length > 0`, `summary !== null`, `meeting:stopped` gesendet.

- [ ] **Step 2: FAIL** — Run: `npx vitest run meeting/meeting-controller.test.js`.

- [ ] **Step 3: Implementierung** der Factory wie im Vertrag.

- [ ] **Step 4: PASS** — Run: `npx vitest run meeting/meeting-controller.test.js`.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): MeetingController-Orchestrierung (TDD mit Fakes)"`

---

## Meilenstein 7 — Hotkey, Fenster, IPC, Settings

### Task 7.1: Meeting-Overlay-Fenster + AudioTee-Instanz + Hotkey im Main

**Files:**
- Modify: `electron-main.js`

- [ ] **Step 1: AudioTeeManager + Controller instanziieren** — oben bei den Manager-Imports (electron-main.js:25–28, nach GlobeKeyManager):
```javascript
const AudioTeeManager = require('./audio-tee-manager');
const audioTeeManager = new AudioTeeManager();
const { createMeetingController } = require('./meeting/meeting-controller');
const { createMeetingStore } = require('./meeting/meeting-store');
let meetingController = null; // lazy in setup, da getStore()/Pfade nötig
```

- [ ] **Step 2: `createMeetingOverlayWindow()`** — neue Funktion nach Vorbild `createRecordingWindow()` (electron-main.js:1076), aber lädt `renderer/meeting-overlay.html`, etwas größer (z. B. 180×56), Position oben-rechts. Hält Referenz `meetingOverlayWindow`.

- [ ] **Step 3: Controller initialisieren** — in der App-Setup-Phase (wo `getStore()` verfügbar ist, z. B. in `app.whenReady()`-Kette):
```javascript
const meetingStore = createMeetingStore({ baseDir: path.join(app.getPath('userData'), 'meetings'), store: getStore() });
meetingController = createMeetingController({
  store: getStore(), meetingStore, audioTee: audioTeeManager,
  getOverlayWindow: () => createMeetingOverlayWindow(),
  getMainWindow: () => mainWindow, fetchImpl: globalThis.fetch,
});
```

- [ ] **Step 4: Meeting-Hotkey registrieren** — in `registerHotkey()` (electron-main.js:1733), nach dem Smart-Paste/Recovery-Block:
```javascript
const meetingKey = getStore().get('meetingHotkey', 'Command+Shift+X');
try { globalShortcut.unregister(meetingKey); } catch {}
globalShortcut.register(meetingKey, () => {
  if (meetingController?.isActive()) meetingController.stop();
  else meetingController?.start();
});
```

- [ ] **Step 5: will-quit-Cleanup** (electron-main.js:2394) — `audioTeeManager.stop(); meetingController?.stop?.();` ergänzen.

- [ ] **Step 6: Verifizieren** — `node --check electron-main.js` ok. (End-to-End in M8.)

- [ ] **Step 7: Commit** — `git commit -am "feat(meeting): Overlay-Fenster, AudioTee-Instanz, Cmd+Shift+X-Hotkey"`

### Task 7.2: IPC-Handler + preload + Typen

**Files:**
- Modify: `electron-main.js` (IPC-Handler im Setup-Block ~2025)
- Modify: `preload.js`
- Modify: `src/types/electron.d.ts`

- [ ] **Step 1: IPC-Handler** (im `setupIpcHandlers`-Block) — alle Kanäle aus dem Vertrag „IPC-Kanäle":
```javascript
ipcMain.handle('meeting:start', () => meetingController?.start());
ipcMain.handle('meeting:stop', () => meetingController?.stop());
ipcMain.on('meeting:mic-pcm', (_e, buf) => meetingController?.onMicPcm(Buffer.from(buf)));
ipcMain.on('meeting:mic-level', (_e, lvl) => meetingController?.onMicLevel(lvl));
ipcMain.handle('meetings:list', () => meetingStore.list());
ipcMain.handle('meetings:get', (_e, id) => meetingStore.get(id));
ipcMain.handle('meetings:delete', (_e, id) => meetingStore.remove(id));
ipcMain.handle('meetings:retranscribe', (_e, id) => meetingController?.retranscribe(id));
ipcMain.handle('meetings:regenerateSummary', (_e, id) => meetingController?.regenerateSummary(id));
ipcMain.handle('meetings:updateSpeakerName', (_e, id, channel, name) => meetingStore.updateSpeakerName(id, channel, name));
ipcMain.handle('meetings:toggleTodo', (_e, id, idx) => meetingStore.toggleTodo(id, idx));
```
(`retranscribe`/`regenerateSummary` als Methoden am Controller ergänzen: liest chunks/ bzw. transcript.json neu und ruft Queue/Summary.)

- [ ] **Step 2: preload.js** — im `electronAPI`-Objekt ergänzen (Patterns aus brief_1):
```javascript
// Meetings
startMeeting: () => ipcRenderer.invoke('meeting:start'),
stopMeeting: () => ipcRenderer.invoke('meeting:stop'),
sendMicPcm: (buf) => ipcRenderer.send('meeting:mic-pcm', buf),
sendMicLevel: (lvl) => ipcRenderer.send('meeting:mic-level', lvl),
listMeetings: () => ipcRenderer.invoke('meetings:list'),
getMeeting: (id) => ipcRenderer.invoke('meetings:get', id),
deleteMeeting: (id) => ipcRenderer.invoke('meetings:delete', id),
retranscribeMeeting: (id) => ipcRenderer.invoke('meetings:retranscribe', id),
regenerateSummary: (id) => ipcRenderer.invoke('meetings:regenerateSummary', id),
updateSpeakerName: (id, channel, name) => ipcRenderer.invoke('meetings:updateSpeakerName', id, channel, name),
toggleMeetingTodo: (id, idx) => ipcRenderer.invoke('meetings:toggleTodo', id, idx),
onMeetingStatus: (cb) => ipcRenderer.on('meeting:status', (_e, s) => cb(s)),
onMeetingTranscriptChunk: (cb) => ipcRenderer.on('meeting:transcript-chunk', (_e, segs) => cb(segs)),
onMeetingStarted: (cb) => ipcRenderer.on('meeting:started', (_e, d) => cb(d)),
onMeetingStopped: (cb) => ipcRenderer.on('meeting:stopped', (_e, d) => cb(d)),
```

- [ ] **Step 3: electron.d.ts** — im `ElectronAPI`-Interface die Signaturen ergänzen (Rückgabetypen aus dem Vertrag; importiere die Meeting-Typen via `import type { MeetingIndexEntry, MeetingFull, MeetingSummary, MeetingSegment } from './meeting'`).

- [ ] **Step 4: Build** — Run: `cd electron-menubar && npm run vite:build` (TS muss durchlaufen) + `node --check electron-main.js` + `node --check preload.js`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(meeting): IPC-Handler + preload + Typen"`

### Task 7.3: Settings-UI für den Meeting-Hotkey

**Files:**
- Modify: `electron-menubar/src/apps/settings/SettingsApp.tsx`
- Modify: `electron-main.js` (`settings:get`/`settings:set` um `meetingHotkey`)

- [ ] **Step 1: settings:get/set erweitern** — in `settings:get` (electron-main.js:2027) `meetingHotkey: s.get('meetingHotkey')` ergänzen; in `settings:set` (2040) analog zum `shortcut`-Block: bei Änderung setzen + `registerHotkey()` aufrufen.

- [ ] **Step 2: Settings-Feld** — im Shortcuts-Tab von `SettingsApp.tsx` ein zweites Capture-Feld „Meeting-Recorder" nach dem bestehenden Hotkey-Feld (gleiche `keyEventToAccelerator`-Logik), speichert `meetingHotkey`. Bei Gleichheit mit `shortcut` Warnhinweis anzeigen.

- [ ] **Step 3: Build** — `npm run vite:build` ok; `node --check electron-main.js`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(meeting): Meeting-Hotkey in den Einstellungen"`

---

## Meilenstein 8 — Meetings-Seite (Dashboard-Tab) + End-to-End

### Task 8.1: Dashboard-Tab „Meetings" verdrahten

**Files:**
- Modify: `electron-menubar/src/apps/dashboard/Dashboard.tsx`

- [ ] **Step 1: NavItem-Union** (Dashboard.tsx:23) → `| 'meetings'` ergänzen.

- [ ] **Step 2: navItems-Eintrag** (Dashboard.tsx:169) — `{ id: 'meetings' as const, label: 'Meetings', icon: Headphones }` (lucide `Headphones` importieren).

- [ ] **Step 3: Render-Switch** (Dashboard.tsx:225) — ergänzen:
```tsx
{activeNav === 'meetings' && <MeetingsView />}
```
und `import { MeetingsView } from './views/MeetingsView';`.

- [ ] **Step 4: Build** — `npm run vite:build` ok (MeetingsView Platzhalter in 8.2).

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): Dashboard-Tab Meetings verdrahtet"`

### Task 8.2: MeetingsView + MeetingsList

**Files:**
- Create: `electron-menubar/src/apps/dashboard/views/MeetingsView.tsx`
- Create: `electron-menubar/src/apps/dashboard/views/MeetingsList.tsx`

`MeetingsView` hält `selectedId` (null = Liste, sonst Detail). Lädt `listMeetings()` im `useEffect` (Muster aus `HistoryApp.tsx:17`), hört `onMeetingStopped` → neu laden. Zeigt `MeetingsList` oder `MeetingDetail`.

- [ ] **Step 1: MeetingsList** — Zeilen-/Leistenansicht nach `HistoryApp`-Muster (Card + ScrollArea): pro `MeetingIndexEntry` eine Zeile mit Datum (`toLocaleString('de-DE')`), Dauer (`mm:ss`), `title`, `Badge` mit `speakerCount`, `preview` (line-clamp-2), Hover-Aktionen (öffnen → `onSelect(id)`, löschen → `deleteMeeting(id)`). Leerzustand „Noch keine Meetings".

- [ ] **Step 2: MeetingsView** — Datenladen + Umschalten Liste/Detail.

- [ ] **Step 3: Build** — `npm run vite:build` ok.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(meeting): Meetings-Liste (Leistenansicht)"`

### Task 8.3: MeetingDetail

**Files:**
- Create: `electron-menubar/src/apps/dashboard/views/MeetingDetail.tsx`

Lädt `getMeeting(id)`. Oben **Protokoll**: Kurzzusammenfassung, Kernpunkte (Liste), To-Dos (Checkbox → `toggleMeetingTodo(id, idx)`, optimistic update), Offene Fragen. Button „Protokoll neu erzeugen" → `regenerateSummary(id)`. Darunter **Transkript**: Segmente chronologisch, Sprecher-Label farbig (me=primary, other=accent), Sprecher umbenennbar (`updateSpeakerName(id, channel, name)`). Audio-`<audio>`-Elemente für `audio.mic`/`audio.system` (Pfade über `file://`). Button „Neu transkribieren" → `retranscribeMeeting(id)`. Zurück-Button → `onBack()`.

- [ ] **Step 1: Implementierung** wie Vertrag.

- [ ] **Step 2: Build** — `npm run vite:build` ok.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(meeting): Meeting-Detailseite (Protokoll + Transkript + To-Dos)"`

### Task 8.4: End-to-End-Verifikation (manuell, mit echtem Audio)

**Files:** keine (Verifikation)

- [ ] **Step 1: App starten** — Run: `cd electron-menubar && npm run dev`.
- [ ] **Step 2: Berechtigung** — `Cmd+Shift+X` drücken; beim ersten Mal Systemdialog „Systemaudioaufnahme" erteilen (ggf. App neu starten). Overlay erscheint, Punkt **grün**.
- [ ] **Step 3: Test-Call** — kurzes Gespräch (z. B. Sprachnachricht/FaceTime mit zweitem Gerät) ~1 min. Erwartung: nach ~30 s erste Segmente; Mic = „Ich", System = „Gegenstelle".
- [ ] **Step 4: Crash-Sicherheit** — während Aufnahme App hart beenden (`kill`); prüfen, dass `<userData>/meetings/<id>/chunks/` gefüllt ist.
- [ ] **Step 5: Stop** — `Cmd+Shift+X`; Session-Ordner vollständig (audio_*.wav, transcript.json, summary.json). Meeting erscheint im Dashboard-Tab „Meetings".
- [ ] **Step 6: Detail** — Zeile öffnen: Protokoll (4 Rubriken) + sprechergetrenntes Transkript; To-Do abhaken bleibt nach Neuladen erhalten; „Protokoll neu erzeugen" + „Neu transkribieren" funktionieren.
- [ ] **Step 7: Rot-Test** — Systemaudio-Berechtigung in den Systemeinstellungen entziehen → Overlay-Punkt **rot** mit Klartext.
- [ ] **Step 8: Commit** (Notizen/Fixes, falls nötig) — `git commit -am "test(meeting): End-to-End-Verifikation Phase 1"`

---

## Self-Review-Ergebnis (vom Autor durchgeführt)

- **Spec-Abdeckung:** R1 (7.1/7.3) · R2 (2.x/5.x/6.1) · R3 (1.4/6.1) · R4 (vorbereitet: `speaker`-Feld + `updateSpeakerName`, Provider-Hook bewusst Phase 2) · R5 (1.3/4.1/6.1) · R6 (2.2/3.3/6.1 + crash-sichere chunks) · R7 (4.1 wortgetreu, Polish ausgelagert) · R8/R9 (3.1/6.1) · R10 (3.2/8.3) · R11 (Groq durchgängig) · R12 (8.x). ✓
- **Platzhalter:** Knifflige/testbare Logik enthält vollständigen Code; Integrations-Tasks nennen exakte Datei:Zeile + Snippet. UI-Komponenten sind als Vertrag + Build-Gate beschrieben (manuelle Verifikation in 8.4), da kein Renderer-Testsetup existiert.
- **Typ-Konsistenz:** Kanal-Werte durchgängig `'mic'|'system'`, Sprecher `'me'|'other'`, IPC-Namen identisch in preload/main/Typen, `MeetingSegment`/`MeetingSummary` einheitlich.
- **Offene Abhängigkeit:** AudioTee-CLI-Flags + Binary-Pfad in `node_modules/audiotee` müssen bei Task 2.1/2.2 am echten Paket verifiziert und ggf. in `buildArgs`/`build-audio-tee.js` angepasst werden (im Plan markiert).
