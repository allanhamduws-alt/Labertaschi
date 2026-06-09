# Vereinheitlichtes Meeting-Audio — Implementierungsplan

> **Für Umsetzer:** TDD pro Task. Reine Funktionen zuerst mit Test absichern. Häufige Commits.
> Spec: `docs/superpowers/specs/2026-06-09-unified-meeting-audio-design.md`

**Goal:** Den „Call/In-Person"-Toggle abschaffen; eine einheitliche Audio-Pipeline + Auto-Anruf-Erkennung,
die S1–S5 sauber abdeckt.

**Architektur:** Immer beide Quellen aufnehmen. Mikro immer diarisieren (lautester = „Ich"). System-Kanal
nur als „Gegenstelle" werten, wenn ein Anruf erkannt wird (anderer Prozess nutzt Mikro) bzw. der Kanal echtes
Sprach-Signal hat. Zeit-genaue Echo-Unterdrückung. Nativer Swift-Helfer für die Anruf-Erkennung (macOS).

**Tech Stack:** Node/CommonJS (meeting/*), React/TS (overlay/settings), Swift (CoreAudio process taps), Vitest.

---

## WS1 — Vereinheitlichte Pipeline + Labeling (Toggle-Logik raus)

Höchster Wert, niedrigstes Risiko. Behebt S3/S4/S5 strukturell. Reine JS, voll testbar.

### Task 1.1: `mergeSegments` — Sprecher-Labels vereinheitlichen

**Files:** `meeting/transcript-merger.js`, `meeting/transcript-merger.test.js`

- [ ] Test: vor-gelabelte Segmente (`speaker:'me'`, `'Sprecher 2'`, `'other'`, `'Gegenstelle 2'`) behalten ihr Label; unlabeled mic→`'me'`, unlabeled system→`'other'`. Reihenfolge chronologisch stabil (mic vor system bei Gleichstand).
- [ ] Impl: Verhalten ist heute schon fast korrekt (Default mic→me, system→other). Nur sicherstellen, dass beliebige Labels durchgereicht werden (kein Hardcode auf me/other). Keine Zusammenführung aufeinanderfolgender gleicher Sprecher (Wortgetreue R7).

### Task 1.2: zeit-genaue Echo-Unterdrückung `suppressBleed`

**Files:** `meeting/transcript-merger.js`, `.test.js`

- [ ] Test: Mic-Segment, das überwiegend (>50 %, mit Pad) mit einem System-Segment überlappt, wird verworfen; nicht-überlappende Mic-Segmente bleiben. Bei leerem System-Array bleiben alle Mic-Segmente.
- [ ] Impl: bestehende `suppressBleed`-Logik (Überlappungsanteil) beibehalten als robusten Default. Parameter `minOverlapFrac=0.5`, `pad=0.4` bleiben. (Kreuzkorrelations-Align ist optionale Ausbaustufe in WS2; v1 nutzt die getestete Überlappungs-Variante.)

### Task 1.3: Controller `stop()` — Modus-Branch entfernen, einheitliche Pipeline

**Files:** `meeting/meeting-controller.js`, `.test.js`

- [ ] Test (call): mic-Segs + sys-Segs vorhanden, `callActive=true` → sys wird als Gegenstelle gemerged, mic-Echo gefiltert; mic diarisiert.
- [ ] Test (inperson/handy): mic-Segs vorhanden, sys leer → **nur** Mikro, diarisiert, **nie** pauschal alles „Ich".
- [ ] Test (kein Regress): sys hat Signal aber `callActive=false` (Musik) → sys-Segs werden **verworfen** (nicht als Gegenstelle).
- [ ] Impl: `sessionMeetingMode` entfernen. Neue Logik:
  ```js
  const systemIsRemote = callActive || systemHasSpeech(sysSegs, /*fallback*/);
  let micForMerge = micSegs;
  let sysForMerge = systemIsRemote ? sysSegs : [];
  if (systemIsRemote) micForMerge = suppressBleed(micSegs, sysSegs);
  if (sessionDiarization) {
    if (micSegs.length) micForMerge = diarizeLocal(<micForMerge>, micPcm, { sampleRate, channel: 'mic' });
    if (systemIsRemote && sysSegs.length) sysForMerge = diarizeLocal(sysForMerge, sysPcm, { sampleRate, channel: 'system' });
  }
  const merged = mergeSegments(micForMerge, sysForMerge);
  ```
  `diarizationInfo.diarizationSpeakers` = distinkte Sprecher im Merge. PCM beider Kanäle aus den finalen WAVs lesen (wie heute für `targetChannel`).

### Task 1.4: Controller `_onSegments` (Live) — denselben einheitlichen Pfad

**Files:** `meeting/meeting-controller.js`, `.test.js`

- [ ] Test: Live-Merge nutzt `systemIsRemote` (callActive) statt `sessionMeetingMode`.
- [ ] Impl: `_onSegments` Merge auf `systemIsRemote ? mergeSegments(suppressBleed(micSegs,sysSegs), sysSegs) : mergeSegments(micSegs, [])`. Live wird (noch) nicht diarisiert (zu teuer/instabil pro Chunk) — Diarisierung erst beim Stop, wie heute.

### Task 1.5: `retranscribe` — denselben Pfad

**Files:** `meeting/meeting-controller.js`, `.test.js`

- [ ] Impl: beim Neu-Transkribieren dieselbe einheitliche Logik; `callActive` ist hier nicht live verfügbar → `systemHasSpeech`-Heuristik auf die System-Segs/PCM anwenden. Mic immer diarisieren (channel:'mic'), System bei Signal (channel:'system').

---

## WS2 — Sprecher-Trennung: Merkmale + „Ich"-Erkennung

Behebt die FALSCH-Zuordnung in S4 und das Verschmelzen in S2.

### Task 2.1: RMS/Lautstärke je Segment

**Files:** `meeting/diarize-local.js`, `.test.js`

- [ ] Test: `segmentLoudness(pcm)` liefert höheren Wert für lauten als für leisen Abschnitt; 0 für Stille.
- [ ] Impl: Median-RMS über stimmhafte Frames (vorhandene Frame-Schleife wiederverwenden).

### Task 2.2: Klangfarbe / Telefon-Indikator je Segment

**Files:** `meeting/diarize-local.js`, `.test.js`

- [ ] Test: `segmentBrightness(pcm,sr)` (Anteil Energie > ~3.4 kHz / Gesamt) ist klein für bandbegrenztes (Telefon-)Signal, größer für breitbandiges Nah-Signal.
- [ ] Impl: pro stimmhaftem Frame Power-Spektrum (FFT vorhanden), Verhältnis Hochband/Gesamt; Median über Frames.

### Task 2.3: `diarizeLocal` — Merkmalsvektor + „lautester = Ich" + Kanal-Labels

**Files:** `meeting/diarize-local.js`, `.test.js`

- [ ] Test (Labeling mic): zwei Cluster, der mit höherer mittlerer Lautstärke → `'me'`, der andere → `'Sprecher 2'`. Ein Cluster → `'me'`.
- [ ] Test (Labeling system): `channel:'system'` → erstes Cluster `'other'`, weitere `'Gegenstelle 2'`.
- [ ] Test (kein Über-Split): ein einziger Sprecher (enge Tonhöhe, ähnliche Lautstärke/Klangfarbe) bleibt **ein** Cluster.
- [ ] Test (S4-Fall): Nah-laut-breitband-Segmente vs. fern-leise-bandbegrenzte Segmente → **zwei** Cluster, das laute = `'me'`.
- [ ] Impl:
  - Primär weiterhin Tonhöhen-Gap-Clustering (kalibriert, kein Über-Split). Octave-Fold beibehalten.
  - **Sekundäres Merkmal** zum Trennen, wenn Tonhöhe NICHT trennt, aber Lautstärke+Klangfarbe konsistent eine zweite Gruppe zeigen (z. B. klar bandbegrenzt+leise = Telefon): erlaubter Zusatz-Split. Konservativ; per Schwellen, in WS5 an echten Aufnahmen kalibriert.
  - **Label-Zuordnung:** `channel:'mic'` (Default) → Cluster mit höchster Median-Lautstärke = `'me'`, restliche nach erstem Auftreten `'Sprecher 2'..`. `channel:'system'` → erstes Auftreten `'other'`, dann `'Gegenstelle 2'..`.
  - Bestehende Tests auf die neuen Labels anpassen (Labels sind unsere eigenen).

---

## WS3 — macOS Anruf-Auto-Erkennung (nativer Swift-Helfer)

Liefert `callActive` + die Overlay-Anzeige. Composeable: WS1 funktioniert auch ohne (Fallback).

### Task 3.1: Swift-Helfer `macos-call-detector.swift`

**Files:** `resources/bin/macos-call-detector.swift` (NEU)

- [ ] Impl: CoreAudio. `kAudioObjectSystemObject` → `kAudioHardwarePropertyProcessObjectList` (AudioObjectID[]). Pro Prozess: `kAudioProcessPropertyPID`, `kAudioProcessPropertyIsRunningInput` (Bool). Argument `--exclude-pid <n>` (eigene App). Poll alle ~1000 ms; bei Zustandswechsel JSON-Zeile auf stdout:
  `{"message_type":"call_state","data":{"active":true,"pids":[123]}}` (active = ein anderer als exclude-pid hat IsRunningInput==true). `setbuf(stdout,nil)`. Bei API-Fehler: einmal `{"message_type":"error",...}` und aktiv=false (Fallback greift).
- [ ] Manuell verifizieren (auf diesem Mac): `swiftc` kompilieren, starten, prüfen dass es die Prozessliste liest und sinnvolle `call_state` liefert (z. B. FaceTime/Photo Booth öffnen → active:true).

### Task 3.2: Build-Script + Bundling

**Files:** `scripts/build-call-detector.js` (NEU), `package.json`

- [ ] Impl: analog `scripts/build-globe-listener.js` — `swiftc -O macos-call-detector.swift -o resources/bin/macos-call-detector`, übersprungen auf Nicht-macOS. `compile:bin` um `compile:call-detector` erweitern. electron-builder `extraResources`/`files` + `!*.swift` ergänzen.

### Task 3.3: `CallDetectorManager`

**Files:** `call-detector-manager.js` (NEU), `test/call-detector-manager.test.js` (NEU)

- [ ] Test (rein): `parseLine('{"message_type":"call_state","data":{"active":true}}')` → `{kind:'call_state', active:true}`; Müll → `{kind:'ignore'}`.
- [ ] Impl: Vorbild `audio-tee-manager.js`. EventEmitter, `start({excludePid})`, `stop()`, `isRunning`. Emit `'call-state'` (bool) bei Wechsel. macOS-only (`isSupported`); no-op sonst. Binary-Resolve wie AudioTee (resources/bin + resourcesPath).

### Task 3.4: Controller-Verdrahtung + Overlay-Event

**Files:** `meeting/meeting-controller.js`, `.test.js`, `electron-main.js`, `preload.js`

- [ ] Test: `onCallState(true)` setzt `callActive=true`; Stop/Start resettet. Health-/Status-Emit enthält `callActive`.
- [ ] Impl: Controller bekommt `callDetector` als Dependency (injizierbar). `start()` ruft `callDetector.start({excludePid})`, subscribt `'call-state'` → setzt `callActive`, emittiert `'meeting:call-state'` ans Overlay. `stop()` stoppt + entkoppelt. `getStatus()` liefert `callActive`. electron-main: `CallDetectorManager` instanziieren, in Controller injizieren; preload: `onMeetingCallState`-Bridge.

---

## WS4 — Bedienoberfläche

### Task 4.1: Overlay — Toggle raus, Anruf-Indikator rein

**Files:** `src/apps/meeting-overlay/MeetingOverlay.tsx`

- [ ] Impl: `meetingMode`-State + Toggle-Button entfernen. Neuer State `callActive` via `onMeetingCallState`. Pill: Mic · Health · (📞-Indikator + „Anruf" nur wenn `callActive`) · Dauer · Stop. `micConstraints`: Default EC aus; bei `callActive` per `applyConstraints` EC an (best effort). `setMeetingMode`-Aufruf entfernen.

### Task 4.2: Einstellungen — Power-Option „System-Audio"

**Files:** `src/apps/settings/SettingsApp.tsx`, `src/types/electron.d.ts`, `electron-main.js` (Defaults)

- [ ] Impl: Settings-Feld `systemAudioMode: 'auto'|'always'|'never'` (Default `'auto'`). Select mit Erklärtext. Controller liest es: `'always'` → System immer als Remote; `'never'` → System nie; `'auto'` → callActive/Heuristik.

### Task 4.3: Typen + IPC aufräumen

**Files:** `src/types/electron.d.ts`, `src/types/meeting.d.ts`, `preload.js`, `electron-main.js`

- [ ] Impl: `meetingMode` aus `getMeetingStatus`/`onMeetingStarted`/IPC entfernen; `setMeetingMode`-IPC entfernen. `onMeetingCallState` + `systemAudioMode` ergänzen. `MeetingIndexEntry` ggf. `callDetected?:boolean` für die Liste.

---

## WS5 — Validierung gegen echte Aufnahmen + Release

### Task 5.1: Pipeline-Validierung (keepAudio)

- [ ] Allans echte Aufnahmen (S2 Raum, S3 Laptop-Call, S4 Handy-Call) durch die neue Pipeline jagen (`PAPLY_KEEP_AUDIO`), Sprecher-Zuordnung prüfen. Schwellen aus WS2.3 (Sekundär-Split, „Ich"-Lautstärke) hier kalibrieren.
- [ ] Detector live gegen einen echten Anruf prüfen (WhatsApp/FaceTime auf dem Mac).

### Task 5.2: Voller Testlauf + Lint + Build

- [ ] `npm test` grün; `npm run vite:build`; `npm run compile:bin` (Swift kompiliert). Keine Toggle-/`meetingMode`-Referenzen mehr (`grep`).

### Task 5.3: Finishing

- [ ] superpowers:finishing-a-development-branch — Merge nach main / Version-Bump / Release nach Allans Freigabe.

---

## Sequenz & Risiko

1. **WS1** (Pipeline vereinheitlichen) — sofort, behebt die strukturellen Fehler, voll testbar.
2. **WS2** (Diarisierungs-Merkmale) — behebt S4-Zuordnung; an echten Daten kalibrieren.
3. **WS4** (UI) — Toggle raus, Indikator (zeigt zunächst Fallback-Heuristik-Status).
4. **WS3** (nativer Detektor) — verfeinert + speist die Live-Anzeige; riskantester Teil zuletzt,
   blockiert die Kern-Fixes nicht (Fallback-Heuristik trägt das Modell).
5. **WS5** — Validierung + Release.
