# Meeting-Recorder für Paply — Design-Spezifikation

- **Datum:** 2026-06-08
- **Status:** Entwurf zur Freigabe
- **Branch:** `feature/meeting-recorder`
- **Betroffene App:** `electron-menubar/` (Electron 33 + React 19 + Vite + Tailwind/shadcn)

---

## 1. Ziel & Motivation

Paply transkribiert heute Diktate: Hotkey drücken → ins Mikrofon sprechen → Text wird eingefügt.

Dieses Feature erweitert Paply um einen **Meeting-/Telefonat-Recorder**: Der Nutzer drückt einen
*eigenen* Hotkey während eines Gesprächs am Mac — in **beliebiger App** (WhatsApp, FaceTime,
Browser-Calls, Telefon übers Mac). Die App nimmt dann **gleichzeitig Mikrofon (= der Nutzer) und
System-Audio (= Gegenstelle)** auf, transkribiert das gesamte Gespräch, trennt die Sprecher,
fasst es per KI in ein Protokoll mit To-Dos zusammen und zeigt alles in einer neuen
**„Meetings"-Seite** (Liste → Detailansicht).

## 2. Anforderungen (aus der Abstimmung mit dem Nutzer)

| # | Anforderung | Quelle |
|---|---|---|
| R1 | Eigener globaler Hotkey **`Cmd+Shift+X`** (Toggle: Start/Stop), in Settings änderbar | Nutzer |
| R2 | Gleichzeitige Aufnahme von **Mikrofon** und **System-Audio**, app-unabhängig | Nutzer |
| R3 | Sprechertrennung **„Ich" vs. „Gegenstelle"** (Phase 1) | Nutzer |
| R4 | **Mehrere Remote-Sprecher** einzeln trennen (Phase 2 — Groq kann das nicht) | Nutzer |
| R5 | **Near-Live-Transkript**: ~alle 30–60 s ein neues Stück sichtbar, kein echtes Streaming nötig | Nutzer |
| R6 | **Grüner Health-Indikator** während Aufnahme; Aufnahme darf **nie verloren** gehen; Fehler klar sichtbar | Nutzer |
| R7 | Live-Transkript **wortgetreu**, nur minimales Säubern, **keine inhaltliche Umformulierung** | Nutzer |
| R8 | Bei Stop **automatisch lokal speichern**, **ein Ordner pro Session** | Nutzer |
| R9 | **Audio behalten** (nachhörbar, neu transkribierbar) | Nutzer |
| R10 | KI-Protokoll mit 4 Rubriken: **Kurzzusammenfassung, Entscheidungen & Kernpunkte, To-Dos, Offene Fragen** | Nutzer |
| R11 | **Groq für alles** (STT + Protokoll). Lokal nur als *Zusatz-Feature*, nie als Groq-Ersatz | Nutzer |
| R12 | Neue **„Meetings"-Seite**: Zeilen-/Leistenansicht → Klick → Detailansicht | Nutzer |

**Nicht-Ziele (bewusst ausgeklammert):**
- Echtzeit-Captions sekundengenau (R5 ist „near-live", nicht „live").
- Windows-Support des System-Audio-Mitschnitts (Phase 1 ist macOS; AudioTee ist macOS-only).
- Lokaler Offline-Modus zur *Kostenersparnis* (ausdrücklich nicht gewünscht — Groq bleibt Standard).

## 3. Architektur-Überblick

```
            ┌─────────────────────────── Electron Main-Prozess ───────────────────────────┐
 Cmd+Shift+X│                                                                              │
 (Toggle) ─▶│  MeetingController                                                           │
            │   ├─ startMeeting() / stopMeeting()                                          │
            │   ├─ MicCapture        (bestehende getUserMedia/MediaRecorder-Pipeline)      │
            │   │     └─ 30-s-Chunks ─▶ ChunkStore (sofort auf Platte)                     │
            │   ├─ SystemAudioCapture (AudioTee-Child-Process, PCM via stdout)             │
            │   │     └─ 30-s-Chunks ─▶ ChunkStore (sofort auf Platte)                     │
            │   ├─ HealthMonitor     (Pegel-/Schreib-/Transkriptions-Checks → grün/gelb/rot)│
            │   ├─ TranscriptionQueue                                                       │
            │   │     └─ je Chunk ─▶ Groq Whisper (verbose_json) ─▶ Segmente               │
            │   ├─ TranscriptMerger  (Mic+System nach Zeitstempel verschmelzen)            │
            │   │     └─ [Phase-2-Hook: DiarizationProvider für System-Kanal]              │
            │   └─ MeetingStore      (Ordner pro Session + Index in electron-store)        │
            │                                                                              │
            │  bei Stop ─▶ SummaryGenerator ─▶ Groq Llama ─▶ Protokoll (JSON, 4 Rubriken)  │
            └──────────────────────────────────────────────────────────────────────────────┘
                         ▲ IPC                                   │ IPC (Live-Updates + CRUD)
                         │                                       ▼
            ┌─ Renderer ─┴───────────────────────────────────────────────────────────────┐
            │  MeetingOverlay (grüner Status, Dauer, Pegel, Stop)                          │
            │  Dashboard-Tab „Meetings" → MeetingsList → MeetingDetail                     │
            └──────────────────────────────────────────────────────────────────────────────┘
```

## 4. Komponenten im Detail

### 4.1 Hotkey & Steuerung
- Neuer Eintrag `meetingHotkey` in den Store-Defaults, Standard `Command+Shift+X`.
- Registrierung in `registerHotkey()` (electron-main.js ~Z. 1733) parallel zum bestehenden Diktat-Hotkey.
- **Toggle-Logik** (nicht Push-to-Talk): erster Druck → `startMeeting()`, zweiter Druck → `stopMeeting()`.
- Settings-UI (`SettingsApp.tsx`, Shortcuts-Tab) bekommt ein zweites Capture-Feld „Meeting-Recorder".
- Konfliktprüfung: Wenn `meetingHotkey === mainHotkey`, Warnung in der UI.

### 4.2 Audio-Aufnahme — zwei getrennte Kanäle (R2, R3)
**Mikrofon (= „Ich"):** bestehende Pipeline (`getUserMedia` + `MediaRecorder`, WebM/Opus). Wird im
Meeting-Modus auf **30-s-Chunks** (`MediaRecorder.start(30000)` bzw. `timeslice`) gestellt.

**System-Audio (= „Gegenstelle"):** über **AudioTee**
- npm-Paket `audiotee` (Node-Wrapper) + gebündeltes Swift-Binary `audiotee`.
- Bündelung **exakt wie der vorhandene `macos-globe-listener`**: via electron-builder
  `build.mac.extraResources`, Auflösung zur Laufzeit über `process.resourcesPath`.
- Konfiguration: `sampleRate: 16000` (→ 16-bit PCM, Whisper-freundlich, kleine Dateien),
  `chunkDurationMs` passend zur 30-s-Häppchen-Logik, `excludeProcesses: [Paply-PID]` (App nimmt
  sich nie selbst auf).
- PCM-Stream wird zu 30-s-WAV/FLAC-Chunks geschrieben.

**Begründung der Wahl** (statt getDisplayMedia-Loopback oder BlackHole): AudioTee ist MIT-lizenziert,
braucht **kein virtuelles Audiogerät**, keinen Admin-Install, keinen roten Screen-Recording-Balken,
und liefert Mic & System als **zwei unabhängige Streams** (Voraussetzung für saubere Trennung).
getDisplayMedia-Loopback ist auf macOS 26 / Electron 33 unzuverlässig (stille/„ended" Tracks);
BlackHole ist GPL-3.0 + manuelles Multi-Output-Setup. → AudioTee ist die einzige „just works"-Option.

### 4.3 Crash-Sicherheit & Health-Indikator (R6) — Kernfeature gegen „alles umsonst"
**Prinzip: Aufnahme ≠ Transkription.** Audio wird *immer zuerst* lokal gesichert; Transkription ist
ein nachgelagerter, jederzeit wiederholbarer Schritt.

- Jeder 30-s-Chunk (Mic + System) wird **sofort nach Entstehung** in den Session-Ordner geschrieben,
  *bevor* er zur Transkription geht. Stürzt die App ab → die Chunks liegen vollständig auf Platte und
  können beim Neustart zu einer Session rekonstruiert + neu transkribiert werden (Recovery,
  analog zum bestehenden 24-h-Audio-Backup).
- **HealthMonitor** prüft im Sekundentakt und speist einen Ampel-Status:
  - **Mic-Pegel** vorhanden? (RMS > Schwelle über Zeitfenster)
  - **System-Audio-Pegel** vorhanden / AudioTee-Prozess lebt? (wichtig wegen des bekannten
    Core-Audio-Tap-„Zero-Buffer"-Bugs bei Langläufern → **Watchdog**: bei längerer Stille trotz
    laufendem Prozess automatisch Tap/Aggregate-Device neu aufbauen).
  - **Chunk-Schreiben** erfolgreich? (Datei existiert, Größe > 0)
  - **Transkriptions-Queue** ohne dauerhafte Fehler?
- Statusfarben:
  - **Grün** = Aufnahme läuft und wird sicher gesichert (Normalzustand, Ziel: dauerhaft grün).
  - **Gelb** = unkritische Warnung (z. B. System-Kanal still — evtl. spricht niemand; Transkription
    eines Chunks fehlgeschlagen, wird erneut versucht — Audio ist sicher).
  - **Rot** = kritisches Problem (System-Audio-**Berechtigung fehlt**, Platte voll, Aufnahme gestoppt).
    Immer mit **Klartext-Hinweis + Aktion** (z. B. Deep-Link zu *Systemeinstellungen → Datenschutz →
    Bildschirm- & Systemaudioaufnahme → „Nur Systemaudioaufnahme"*).
- Anzeige an **zwei Stellen**: Menubar-Tray-Icon (Farbpunkt) + im **MeetingOverlay** (kleines
  Mikrofon-Icon mit Pegelbalken + grünem Punkt, §4.8).

### 4.4 Near-Live-Transkription (R5, R7)
- Jeder fertige Chunk wird in die **TranscriptionQueue** gelegt und an **Groq Whisper** geschickt:
  - Modell: `whisper-large-v3` (bessere deutsche Genauigkeit als das `-turbo` der Diktat-Pipeline;
    Meeting-Genauigkeit > Latenz).
  - `response_format: 'verbose_json'`, `timestamp_granularities: ['segment','word']` → Zeitstempel
    (Pflicht fürs zeitliche Verschmelzen der beiden Kanäle).
  - `language: 'de'` (aus Settings, wie heute).
- Ergebnis-Segmente erscheinen **sofort** im laufenden Transkript des Overlays/der Detail-View,
  beschriftet nach Kanal: Mic → **„Ich"**, System → **„Gegenstelle"**.
- **Wortgetreu (R7):** Die Live-Anzeige zeigt den **rohen Whisper-Text**. Optionales, sehr
  zurückhaltendes „Light-Polish" (nur Satzzeichen/Groß-Klein/offensichtliche Erkennungsfehler) per
  Groq-Llama mit striktem Prompt: *„Ändere KEINE Wortwahl, formuliere NICHT um, korrigiere nur
  Interpunktion und eindeutige Erkennungsfehler."* Standard: aus bzw. minimal. Inhaltliche
  Verdichtung passiert ausschließlich im Protokoll (4.6), nie im Transkript.
- **Chunking gegen Groq-Limits:** 30-s-Chunks (16 kHz mono) liegen weit unter dem 25-MB-Limit;
  lange Meetings sind dadurch automatisch abgedeckt — kein nachträgliches Splitten großer Dateien nötig.

### 4.5 Verschmelzung & Diarisierungs-Schnittstelle (R3, R4)
- **TranscriptMerger** ordnet alle Segmente beider Kanäle **chronologisch nach Zeitstempel** zu einem
  einzigen Gesprächsprotokoll: `[{ tStart, tEnd, speaker, text }]`.
- **Phase 1:** `speaker` ergibt sich aus dem Kanal — Mic = `me`, System = `other`. 100 % zuverlässig,
  keine KI.
- **Phase-2-Hook:** Der Merger ruft einen optionalen `DiarizationProvider` auf, der für den
  *System-Kanal* feinere Sprecher-Labels (`other-1`, `other-2`, …) liefert. Interface:
  ```ts
  interface DiarizationProvider {
    diarize(audioPath: string, words: Word[]): Promise<SpeakerSegment[]>; // [] = nicht verfügbar
  }
  ```
  Implementierungen (Phase 2, austauschbar): `DeepgramProvider` (Cloud, empfohlen — Groq-first/Kosten
  egal) **oder** `PyannoteProvider` (lokal). In Phase 1 nicht gesetzt → reine Kanal-Trennung.

### 4.6 KI-Protokoll (R10) — nach Stop, jederzeit neu generierbar
- **SummaryGenerator** schickt das vollständige, verschmolzene, sprecher-beschriftete Transkript an
  **Groq Llama** (`llama-3.3-70b-versatile`, bereits integriert; 131 k Kontext fasst ~1-h-Meeting in
  einem Call). Alternative `openai/gpt-oss-120b` (günstiger).
- Prompt erzwingt **strukturiertes JSON** mit exakt vier Feldern:
  ```json
  {
    "kurzzusammenfassung": "…",
    "kernpunkte": ["…"],
    "todos": [{ "text": "…", "verantwortlich": "…|null", "erledigt": false }],
    "offeneFragen": ["…"]
  }
  ```
- Auf Deutsch. Läuft automatisch bei Stop und ist per Button **„Protokoll neu erzeugen"** wiederholbar
  (z. B. nach Sprecher-Umbenennung oder Neu-Transkription).

### 4.7 Persistenz (R8, R9)
**Hybrid: Index in electron-store, Inhalte als Dateien.**
```
~/Library/Application Support/paply-menubar/
├── config.json                         (bestehend; + neuer Index 'meetings')
└── meetings/
    └── <id>/                            (ein Ordner pro Session; id = Zeitstempel-uuid)
        ├── audio_mic.webm
        ├── audio_system.wav
        ├── chunks/                      (Roh-Chunks für Recovery, nach Finalisierung optional aufräumbar)
        ├── transcript.json              (verschmolzene Segmente)
        └── summary.json                 (KI-Protokoll, 4 Rubriken)
```
- **Index** in electron-store unter `meetings: MeetingIndexEntry[]` (id, Start, Dauer, Titel,
  Sprecherzahl, Vorschau) → schnelles Auflisten ohne große Dateien zu laden.
- Datenmodell siehe §5.
- **Aufbewahrung:** Audio + Transkript + Protokoll bleiben dauerhaft (R9). Die bestehende
  90-Tage-Bereinigung der Diktat-History gilt **nicht** für Meetings (eigener Store-Key).

### 4.8 UI — neue „Meetings"-Seite (R12)
- **Integration:** Neuer Tab **„Meetings"** im bestehenden Dashboard (`Dashboard.tsx`, `activeNav`),
  *kein* zusätzliches Fenster (vermeidet Fenster-Wildwuchs, folgt dem Tab-Muster).
- **MeetingsList** (Zeilen-/Leistenansicht): pro Meeting eine Zeile mit Datum/Uhrzeit, Dauer, Titel
  (auto aus Kurzzusammenfassung), Sprecheranzahl, Vorschautext, Aktionen (öffnen/löschen). Mit
  Suche/Filter (wie `HistoryApp.tsx`). Wiederverwendung der shadcn-Komponenten (Card, Badge, Input,
  ScrollArea).
- **MeetingDetail** (Klick auf Zeile → View-Wechsel im selben Fenster):
  - Oben: **KI-Protokoll** — die 4 Rubriken; **To-Dos abhakbar** (Checkbox, persistiert).
  - Darunter: **vollständiges, sprechergetrenntes Transkript** (zwei Spalten / farbige Sprecher-Labels
    „Ich" vs. „Gegenstelle"), Sprecher umbenennbar.
  - **Audio-Wiedergabe** (Mic/System bzw. Mix), Button „Protokoll neu erzeugen", „Neu transkribieren".
- **MeetingOverlay** während Aufnahme: bewusst **sehr kleines, unauffälliges** Always-on-top-Icon —
  ein **Mikrofon-Symbol mit live Pegel-/Sprechbalken** (wie bei Publi, nur deutlich kleiner als das
  140×52-px-`RecordingWidget`) plus ein **kleiner grüner Gesundheitspunkt** (grün = läuft & wird
  sicher gesichert; gelb/rot bei Problem). Es soll die Bildschirmarbeit nicht stören. Auf
  Hover/Klick **ausklappbar** zu Dauer, Pegel beider Kanäle, Stop-Button und optional dem
  mitlaufenden Transkript.

## 5. Datenmodell

```ts
// Index (in electron-store, schlank)
interface MeetingIndexEntry {
  id: string;            // `${startEpoch}-${shortUuid}`
  startTime: string;     // ISO
  durationMs: number;
  title: string;         // auto aus Kurzzusammenfassung, editierbar
  speakerCount: number;
  preview: string;       // erste ~120 Zeichen
  hasSummary: boolean;
  favorite: boolean;
}

// Vollrecord (in meetings/<id>/transcript.json + summary.json)
interface MeetingTranscript {
  segments: Array<{
    tStart: number;      // s relativ zum Start
    tEnd: number;
    speaker: 'me' | 'other' | string;  // Phase 2: 'other-1', …
    channel: 'mic' | 'system';
    text: string;        // wortgetreu (R7)
    words?: Array<{ w: string; t: number }>;
  }>;
  language: string;
}

interface MeetingSummary {
  kurzzusammenfassung: string;
  kernpunkte: string[];
  todos: Array<{ text: string; verantwortlich: string | null; erledigt: boolean }>;
  offeneFragen: string[];
  generatedAt: string;
  model: string;
}
```

## 6. IPC-API (neue Handler in `electron-main.js` + `preload.js` + `electron.d.ts`)

| Kanal | Zweck |
|---|---|
| `meeting:start` / `meeting:stop` | Aufnahme steuern (auch vom Hotkey ausgelöst) |
| `meeting:status` (Event) | Live-Health (grün/gelb/rot + Detail) ans Overlay |
| `meeting:transcript-chunk` (Event) | Neue transkribierte Segmente live an die UI |
| `meetings:list` | Index laden |
| `meetings:get(id)` | Vollrecord (Transkript + Protokoll) |
| `meetings:delete(id)` | Meeting + Ordner löschen |
| `meetings:retranscribe(id)` | Aus gespeicherten Chunks neu transkribieren |
| `meetings:regenerateSummary(id)` | KI-Protokoll neu erzeugen |
| `meetings:updateSpeakerName(id, …)` | Sprecher umbenennen |
| `meetings:toggleTodo(id, todoIdx)` | To-Do abhaken |

## 7. Bündelung, Berechtigungen, Signierung
- **AudioTee-Binary** via `build.mac.extraResources` (wie `macos-globe-listener`); Build-Step
  analog `scripts/build-globe-listener.js`.
- **Entitlements** (`entitlements.mac.plist`): `com.apple.security.cs.disable-library-validation`,
  `com.apple.security.device.audio-input`, `com.apple.security.cs.allow-jit` — **alle bereits
  vorhanden**.
- **Info.plist:** `NSAudioCaptureUsageDescription` (**NEU**, Pflicht für System-Audio-Tap) +
  bestehendes `NSMicrophoneUsageDescription`.
- Das ad-hoc-signierte Binary **erbt** beim electron-builder-Sign die Developer-ID-Signatur der
  App; Notarisierung läuft über das vorhandene `scripts/notarize.js`.
- **Onboarding:** Da es keine öffentliche API zum Vorab-Prüfen der „Nur Systemaudioaufnahme"-
  Berechtigung gibt → beim ersten Meeting Tap starten, **Null-Energie auf dem System-Kanal
  erkennen** und den Nutzer per Dialog + Deep-Link zu den Systemeinstellungen führen (ggf. Neustart-Hinweis).

## 8. Fehlerbehandlung & Edge Cases
- **System-Audio-Berechtigung fehlt:** Rot + Klartext + Deep-Link; Mic-Mitschnitt läuft trotzdem weiter.
- **Langläufer-Zero-Buffer-Bug:** Watchdog baut AudioTee-Tap automatisch neu auf; Lücke wird im
  Transkript markiert.
- **Groq-Transkription schlägt fehl:** Retry mit Backoff (wie bestehende Pipeline); Chunk bleibt
  gesichert, Status gelb statt rot.
- **Echo (Lautsprecher statt Kopfhörer):** Gegenstelle kann ins Mic bluten → Onboarding-Hinweis
  „Kopfhörer empfohlen"; spätere Option für simple Echo-Unterdrückung offen gelassen.
- **Sehr lange Meetings:** durch 30-s-Chunking inhärent abgedeckt (kein 25-MB-Problem).

## 9. Phasierung

| Bereich | Phase 1 (diese Umsetzung) | Phase 2 (später) |
|---|---|---|
| Hotkey, 2-Kanal-Aufnahme (AudioTee), Crash-Sicherung | ✅ | |
| Health-Indikator (grün/gelb/rot) + Watchdog | ✅ | |
| Near-Live-Transkript (Groq, wortgetreu) | ✅ | |
| Sprecher „Ich vs. Gegenstelle" | ✅ | |
| KI-Protokoll (4 Rubriken, To-Dos) | ✅ | |
| Meetings-Liste + Detailseite + Overlay | ✅ | |
| Diarisierungs-Schnittstelle (Hook) | ✅ vorbereitet | |
| **Mehrere Remote-Sprecher einzeln** | — | ✅ (Provider: **Deepgram** empfohlen, alt. pyannote lokal) |
| Windows-System-Audio | — | offen |

**Offene Phase-2-Entscheidung:** Anbieter für Mehr-Sprecher-Diarisierung. Empfehlung **Deepgram**
(ein Cloud-Call, bestes Deutsch; da Kosten/Datenschutz für den Nutzer kein Kriterium sind, einfacher
als die lokale pyannote-Lösung). Wird festgelegt, sobald Phase 1 steht.

## 10. Kosten (Phase 1, Groq)
~**0,10–0,25 $ pro Stunde Meeting** (2 Audio-Stunden STT bei 2 Kanälen + 1 Protokoll-Call). Bestehender
Groq-Key reicht; kein weiterer Dienst nötig.

## 11. Manuelle Verifikation (Phase 1)
1. `Cmd+Shift+X` startet/stoppt; Overlay erscheint, Status grün.
2. Test-Call (z. B. WhatsApp/FaceTime): nach ~30 s erscheinen erste Segmente, korrekt als
   „Ich"/„Gegenstelle" beschriftet.
3. Berechtigung absichtlich entzogen → Status rot + Deep-Link funktioniert.
4. App während Aufnahme hart beenden → Chunks liegen im Session-Ordner, Recovery rekonstruiert die Session.
5. Stop → Session-Ordner vollständig (Audio + transcript.json + summary.json); Meeting in Liste;
   Detailseite zeigt Protokoll (4 Rubriken) + sprechergetrenntes Transkript; To-Do abhaken persistiert.
6. „Neu transkribieren" und „Protokoll neu erzeugen" funktionieren.
```
