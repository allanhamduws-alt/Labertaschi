# Vereinheitlichtes Meeting-Audio — Design

**Datum:** 2026-06-09
**Status:** Genehmigt (Allan: „komplette Endversion" + „Auto-Erkennung mit Anzeige")

## Ziel

Den verwirrenden „Call vs. In-Person"-Schalter abschaffen. Ein einziges mentales Modell,
das **alle** realen Aufnahme-Szenarien sauber und ohne gegenseitige Störung abdeckt — der
Nutzer drückt nur noch Start/Stop. Die App erkennt selbst, ob ein Anruf auf diesem Computer
läuft, und zeigt das unaufdringlich an.

## Das Kernproblem (Ist-Zustand)

Der eine Overlay-Toggle (`sessionMeetingMode` = `'call'` | `'inperson'`) steuert heute ZWEI
unabhängige Dinge gleichzeitig:

1. **Wird der System-Audio-Kanal benutzt?** (`inperson` wirft ihn weg, `call` nutzt ihn)
2. **Wer ist „Ich"/„Gegenstelle" und welcher Kanal wird in Sprecher getrennt?**
   (`inperson` → Mikro diarisieren, kein „Ich"; `call` → Mikro pauschal „Ich", System diarisieren)

Folgen (verifiziert im Code, `meeting-controller.js` Zeilen 142–145 und 284–307):

- **S3** (Anruf auf dem Laptop): Vergisst der Nutzer den Toggle (Start = `inperson`!), wird die
  **ganze Gegenstelle weggeworfen**.
- **S4** (Anruf auf dem Handy, Laptop hört per Mikro mit): Bei `call` wird **alles** im Mikro
  pauschal „Ich" — der Telefonpartner wird zu Allan. Bei `inperson` greift die Tonhöhen-Trennung,
  kippt aber bei der leisen, bandbegrenzten Telefonstimme. **Allans realer Fehlerfall.**
- **S5** (Anruf + Leute im Raum): Mikro wird pauschal „Ich" → Raum-Leute verschwinden.
- Der Toggle wirkt **rückwirkend** auf die gesamte Aufnahme (kein Live-Umschalt-Zustand).

## Das vereinheitlichte Modell

> **Nimm immer beide Quellen auf.** Trenne, was im **Mikrofon** ist, nach Sprechern. Wenn der
> **System-Kanal** eine echte (Sprach-)Aktivität hat, behandle ihn als sauberen Remote-Kanal,
> entferne sein Echo aus dem Mikrofon und trenne auch ihn nach Sprechern.

Damit gibt es **keinen Modus mehr**. Beide alten Modi werden derselbe Code-Pfad. Die einzige
Laufzeit-Entscheidung — „ist der System-Ton ein Anruf?" — trifft die App automatisch.

### Audioquellen (unverändert)

- **Mikrofon**: `getUserMedia` im Overlay-Renderer → AudioWorklet → 16-kHz-PCM via IPC. Fängt
  alle physisch Anwesenden ein (inkl. Allan) und bei Lautsprecher-Nutzung das Echo der Gegenstelle.
- **System-Audio macOS**: `AudioTeeManager` (Subprozess, Core-Audio-Process-Tap). Läuft schon
  **immer** mit. Sauberer digitaler Mitschnitt der Gegenstelle, **falls** der Anruf auf diesem Mac läuft.
- **System-Audio Windows**: `WindowsAudioManager` + `getDisplayMedia`-Loopback im Renderer.

### Sprecher-Zuordnung (Labeling)

- **Mikrofon-Kanal** wird immer diarisiert:
  - Der **lauteste/dominante** Mikro-Sprecher = **„Ich"** (Allan ist am nächsten am Mikro →
    systematisch lauter). Das liefert endlich eine ehrliche „Ich"-Erkennung statt „Sprecher 1".
  - Weitere Mikro-Sprecher = **„Sprecher 2", „Sprecher 3"** … (Leute im Raum / Telefonpartner
    über Handy-Lautsprecher).
- **System-Kanal** (nur wenn aktiv): wird diarisiert → **„Gegenstelle"** (bzw. „Gegenstelle 2"
  bei mehreren Remote-Sprechern).
- Umbenennen (`renameSpeaker`) funktioniert weiterhin auf allen Labels und propagiert in
  Protokoll + Liste (bestehende Logik bleibt).

### Anruf-Auto-Erkennung (macOS)

Ein neuer kleiner Swift-Helfer (`resources/bin/macos-call-detector.swift`, kompiliert wie der
Globe-Listener via `scripts/build-call-detector.js` mit `swiftc`) prüft periodisch über die
Core-Audio-Prozessliste (`kAudioHardwarePropertyProcessObjectList`), ob **ein anderer Prozess
als Paply gerade das Mikrofon nutzt** (`kAudioProcessPropertyIsRunningInput == true`). Ergebnis:

- **Anderer Prozess nutzt Mikro + System-Audio hat Signal** → es ist ein **Zwei-Wege-Anruf**
  auf diesem Mac. → System-Kanal als Gegenstelle nutzen. Overlay zeigt:
  „📞 Anruf erkannt — Gegenstelle wird mitgenommen".
- **Sonst** (kein anderer Mikro-Nutzer): System-Audio ist Musik/Video → **nicht** als Sprecher
  werten (verhindert, dass ein Podcast als „Gegenstelle" auftaucht).

Diese App-namen-freie Heuristik ist robust (kein Zoom/Teams/WhatsApp-Whitelist nötig).

**Fallback ohne Helfer / auf Windows:** Reine Signal-Heuristik — hat der System-Kanal über die
Aufnahme hinweg substanzielle, sprach-ähnliche Aktivität (vorhandener `gotSystemPcm`/Pegel +
einfacher Sprache-vs-Musik-Check), wird er als Gegenstelle gewertet. Der Helfer verbessert nur
die Genauigkeit + liefert die Live-Anzeige; das Kernmodell funktioniert auch ohne ihn.

### Bedienoberfläche

- **Overlay-Pill**: Der manuelle Toggle verschwindet aus der normalen Bedienung. Stattdessen
  eine **unaufdringliche Status-Anzeige**, wenn ein Anruf erkannt wurde („📞 erkannt"). Pill
  bleibt minimal: Mic-Icon · Health-Punkt · (Anruf-Indikator, nur wenn aktiv) · Dauer · Stop.
- **Einstellungen**: Eine versteckte **Power-Option** „System-Audio" mit den Werten
  *Automatisch (empfohlen)* / *Immer einbeziehen* / *Nie* — für Sonderfälle (z. B. bewusst
  Musik ausschließen oder erzwingen). Default: *Automatisch*.

## Sprecher-Trennung — Qualitäts-Upgrade

Damit S4 (Telefon über Mikro) und S2 (zwei ähnliche Stimmen) korrekt zugeordnet werden, reicht
Tonhöhe allein nicht. Zusätzliche, billig in JS berechenbare Merkmale je Segment:

1. **Lautstärke (RMS)** — Allan am Mikro ist lauter als die ferne Telefonstimme. Stärkstes
   Merkmal in S4 und gleichzeitig die „Ich"-Bestimmung (lautester Sprecher = Allan).
2. **Klangfarbe / Telefon-Erkennung** — Telefonstimme ist bandbegrenzt (kaum Höhen) und hallig.
   Hochfrequenz-Anteil (spektraler Tilt) + Nachhall-Proxy trennen „nah am Mikro" von „fern/Telefon"
   robuster als Tonhöhe — löst nebenbei „zwei Männerstimmen" (S2). Die MFCC-Mathematik liegt
   bereits ungenutzt in `diarize-local.js`.
3. **Zeit-genaue Echo-Unterdrückung** — statt reiner Überlappung (`suppressBleed`) den
   Lautsprecher-Versatz per Kreuzkorrelation bestimmen und nur echtes Echo verwerfen.
4. **Robustere Tonhöhe (YIN)** statt roher Autokorrelation — beseitigt die Oktavfehler, die bei
   der bandbegrenzten Telefonstimme zuschlagen (Ausbaustufe, falls 1–2 nicht reichen).

Clustering bleibt gap-basiert, aber über einen **gewichteten Merkmalsvektor**
(Tonhöhe + Lautstärke + Klangfarbe) statt nur Tonhöhe.

**Kein-Regressions-Garantie:** Wenn der System-Kanal leer ist (S1/S2/S4-Handy), wird **immer**
der Mikro-Kanal diarisiert — nie pauschal alles „Ich". Wenn er Signal hat (S3/S5), wird er als
Gegenstelle genutzt. Ein und derselbe Code-Pfad, kein Modus-Branch.

## Szenario-Matrix (Soll)

| Szenario | Mikro | System | Auto-Erkennung | Ergebnis |
|---|---|---|---|---|
| S1 Diktat allein | Allan | leer | kein Anruf | 1 Sprecher („Ich") |
| S2 mehrere im Raum | mehrere | leer | kein Anruf | Mikro getrennt: Ich + Sprecher 2… |
| S3 Anruf am Laptop | Allan+Echo | Gegenstelle sauber | **Anruf** | Ich + Gegenstelle, Echo gefiltert |
| S4 Anruf am Handy | Allan+Telefonpartner | leer | kein Anruf | Mikro getrennt: Ich + Sprecher 2 (Telefon) |
| S5 Anruf + Raum | Allan+Raum+Echo | Gegenstelle | **Anruf** | Ich + Sprecher 2… + Gegenstelle |

## Architektur / betroffene Dateien

- **`meeting/transcript-merger.js`** — `mergeSegments` Labeling erweitern (me/Sprecher N/Gegenstelle N);
  `suppressBleed` → zeit-genaue Variante.
- **`meeting/diarize-local.js`** — Merkmalsvektor (Pitch+RMS+Klangfarbe), gewichtetes Clustering,
  „lautester = Ich"-Zuordnung, optional YIN.
- **`meeting/meeting-controller.js`** — Modus-Branch entfernen; einheitliche Pipeline in `stop()`
  und `_onSegments`; Anruf-Status verarbeiten + an Overlay emittieren; „System-Audio"-Power-Option lesen.
- **`call-detector-manager.js`** (NEU) — verwaltet den Swift-Helfer (Vorbild: `audio-tee-manager.js`).
- **`resources/bin/macos-call-detector.swift`** (NEU) + **`scripts/build-call-detector.js`** (NEU)
  + `compile:bin`-Script erweitern + electron-builder `extraResources`/`files`.
- **`src/apps/meeting-overlay/MeetingOverlay.tsx`** — Toggle raus, Anruf-Indikator rein.
- **`src/apps/settings/SettingsApp.tsx`** + Settings-Typ — Power-Option „System-Audio".
- **`electron-main.js`** + **`preload.js`** — Call-Detector-Verdrahtung, IPC anpassen, Toggle-IPC entfernen.
- **Typen** (`electron.d.ts`, `meeting.d.ts`) — `meetingMode` raus, `systemAudioMode` + Call-Status rein.

## Test-Strategie (Action-Level-Absicherung)

- **Unit/TDD** für jede reine Funktion (Merger-Labeling, Bleed-Zeit-Align, Diarisierungs-Merkmale,
  CLI/Parse des Detektors, Heuristik-Schwellen).
- **Validierung gegen Allans echte Aufnahmen** (`keepAudio`): S2, S3, S4 erneut durch die Pipeline
  jagen und Zuordnung prüfen, bevor Release.
- **Plattform**: Windows-Pfad bleibt funktional (Fallback-Heuristik), kein Build-Bruch.

## Bewusst NICHT in v1 (YAGNI)

- Kein schweres lokales ML-Diarisierungs-Modell (sherpa-onnx) — erst falls Merkmale 1–4 nicht reichen.
- Keine App-Whitelist für die Anruf-Erkennung (die Mikro-Nutzungs-Heuristik ist robuster).
- Keine echte akustische Echo-Cancellation (Kreuzkorrelations-Align genügt).
