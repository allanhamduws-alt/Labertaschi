# Windows-System-Audio + Deepgram-Usage + Settings-Parität — Design & Plan

**Datum:** 2026-06-08
**Branch:** `feature/windows-and-deepgram-usage`
**Aufbauend auf:** [Meeting-Recorder-Design](./2026-06-08-meeting-recorder-design.md)

## Ziel

Drei zusammenhängende Verbesserungen am Meeting-Recorder (v1.8.0 → v1.9.0):

1. **Settings-Parität:** Die eingebettete Dashboard-Einstellungsansicht (`Dashboard.tsx`) zeigt 5 Felder nicht, die das separate Settings-Fenster (`SettingsApp.tsx`) bereits hat. Beide UIs sollen auf demselben Stand bleiben.
2. **Deepgram-Sichtbarkeit & Kostenzähler:** Pro Meeting sichtbar machen, ob/wie viel Deepgram genutzt wurde, plus eine globale Verbrauchsübersicht. Zusätzlich ein Pro-Session-Schalter, um Diarization bei 1:1-Gesprächen wegzulassen.
3. **Windows-System-Audio:** Den System-Mitschnitt (heute macOS-only via AudioTee) auf Windows ermöglichen, damit der Meeting-Recorder dort vollständig funktioniert — inkl. Mehr-Sprecher-Trennung.

## Architektur-Entscheidungen

### Settings-Parität
- Beide UIs schreiben denselben `electron-store` über die generischen IPC-Calls `settings:get`/`settings:set`. Die Divergenz ist rein UI-seitig.
- **Fix:** Dashboard-`SettingsView` um `deepgramApiKey`, `diarizationEnabled`, `meetingHotkey`, `copyToClipboard`, `language` ergänzen.
- **Drift-Schutz:** `settings-sync.test.js` liest beide TSX-Quellen und prüft, dass jeder kanonische Settings-Key in **beiden** referenziert wird. Schlägt fehl, sobald eine künftige Änderung nur eine UI anfasst.

### Deepgram-Usage (lokaler Zähler)
- Echtes Restguthaben per Deepgram-API ist **nicht praktikabel**: die Dollar-Endpoints (`/balances`, `/billing/breakdown`) brauchen einen `billing:read`-Admin-Key → in einer Desktop-App ein Sicherheitsrisiko, plus Tages-Latenz.
- **Stattdessen lokal zählen:** Die App kennt die gesendeten Audio-Sekunden exakt (WAV-Header). Reines, getestetes Modul `meeting/deepgram-usage.js`:
  - `wavDurationSeconds(size, {sampleRate})` — Dauer aus Dateigröße.
  - `estimateDeepgramCostUsd(seconds, {multilingual, diarize})` — nova-3: $0.0092/min (multilingual, de) bzw. $0.0077/min (en) + $0.0020/min Diarization-Add-on.
  - `accumulateUsage(prev, {seconds, costUsd, month})` — immutabler globaler Zähler `{ totalSeconds, totalCostUsd, totalRequests, perMonth }`.
- Inkrement nur bei **erfolgreicher** Diarisierung im `MeetingController.stop()`.
- Pro-Meeting-Felder im Index: `diarizationUsed`, `diarizationSeconds`, `diarizationCostUsd`, `diarizationSpeakers` → Badge in `MeetingDetail`.
- **Pro-Session-Override:** Der Controller snapshottet `diarizationEnabled` beim Start (`sessionDiarization`); ein Overlay-Toggle (`meeting:set-diarization`) überschreibt nur die laufende Aufnahme, nicht den globalen Default.

### Windows-System-Audio (Loopback)
- Electron 33.4.11 unterstützt nativen System-Loopback auf Windows via `session.setDisplayMediaRequestHandler((req, cb) => cb({ video: <screen>, audio: 'loopback' }))` + `getDisplayMedia({audio:true, video:true})`. **Kein natives Modul, keine Treiber, kein node-gyp.** Der Video-Track muss angefordert, dann sofort verworfen werden (Windows wirft sonst `NotSupportedError`).
- Loopback läuft im **Renderer** (WebRTC/AudioWorklet gibt es nur dort). Das Overlay greift den System-Mix ab → AudioWorklet → 16-bit-PCM → IPC `meeting:system-pcm` (genau die Mic-Pipeline, gespiegelt).
- **`windows-audio-manager.js`** bietet dieselbe EventEmitter-Schnittstelle wie `AudioTeeManager` (`start`/`stop`/`isRunning`, Events `pcm`/`started`/`stopped`/`error`/`log`). Er empfängt das PCM aus dem Renderer und emittiert `pcm`. Der `MeetingController` bleibt **unverändert** — er bekommt plattformabhängig den passenden Manager (`isMac ? audioTeeManager : windowsAudioManager`).
- Diarisierung ist quellen-agnostisch (Cloud, über fertige `audio_system.wav`) → Sprechertrennung läuft auf Windows identisch zu macOS.
- macOS bleibt komplett unberührt (kein Loopback-Pfad, kein Display-Media-Handler).

## Komponenten / Dateien

| Datei | Änderung |
|-------|----------|
| `meeting/deepgram-usage.js` (neu) | Kosten-/Usage-Reinfunktionen + Tests |
| `windows-audio-manager.js` (neu) | Loopback-PCM-Empfänger, AudioTee-kompatibel + Test |
| `meeting/meeting-controller.js` | sessionDiarization, Usage-Tracking, getStatus/started-Payload |
| `meeting/meeting-store.js` | Index-Defaults um Diarization-Felder ergänzt |
| `electron-main.js` | Manager-Auswahl, Display-Media-Handler (Win), IPC: system-pcm / set-diarization / deepgram-usage, Store-Default `deepgramUsage` |
| `preload.js`, `src/types/electron.d.ts`, `src/types/meeting.d.ts` | neue IPC-/Typ-Oberfläche |
| `src/apps/meeting-overlay/MeetingOverlay.tsx` | Loopback-Capture (Win) + Diarization-Toggle (ausgeklappt) |
| `src/components/DeepgramUsageCard.tsx` (neu) | gemeinsame Verbrauchsübersicht für beide Settings-UIs |
| `src/apps/dashboard/Dashboard.tsx` | SettingsView-Parität + Usage-Card + Footer-Version |
| `src/apps/settings/SettingsApp.tsx` | Usage-Card |
| `settings-sync.test.js` (neu) | Parität-Guard |
| `package.json` | v1.9.0, `windows-audio-manager.js` in `build.files` |

## Bekannte Grenzen / Test-Vorbehalt

- Der **Windows-Loopback-Pfad ist auf macOS nicht ausführbar** und wird in dieser Session nur per Code-Review verifiziert, nicht zur Laufzeit. Verifikation: Windows-`.exe` aus GitHub Actions auf einem echten Windows-Rechner. Risiko-Punkte für den Test: (a) `getDisplayMedia` ohne Picker liefert tatsächlich Loopback-Audio; (b) der verworfene Video-Track verursacht keine Probleme; (c) User-Gesture-Anforderung im Overlay.
- Kostenzahlen sind Schätzwerte auf Basis der öffentlichen Preisliste — gegen das echte Deepgram-Dashboard verifizierbar.
