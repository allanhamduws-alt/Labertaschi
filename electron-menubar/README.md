# Labertaschi Menubar App

Eigenständige macOS Menüleisten-App für Sprachtranskription mit Groq Whisper und optional Claude Haiku Polishing.

## Features

- **Tray-Menü** mit:
  - Transcribe (mit konfigurierbarem Shortcut, Standard: ⌥⌘K)
  - History (letzte 30 Transkripte)
  - Einstellungen (API Keys, Polish, Autostart, Shortcut)
  - Über Labertaschi
  - Beenden (⌘Q)

- **Direkte API-Calls** zu Groq und Anthropic (kein externer Server nötig)
- **Auto-Paste** ins vorherige Fenster nach Transkription
- **Lokale Speicherung** von Settings und History

## Installation

```bash
cd electron-menubar
npm install
```

## Entwicklung

```bash
npm run dev
```

## Build (Apple Silicon DMG/ZIP)

```bash
npm run build
```

Das erzeugt eine `.dmg` und `.zip` Datei im `dist/` Ordner.

## Einrichtung

1. App starten
2. In Menüleiste klicken → "Einstellungen..."
3. **Groq API Key** eingeben (erforderlich für Transkription)
4. Optional: **Anthropic API Key** für Polish-Funktion
5. Optional: "Polish aktivieren" ankreuzen
6. Speichern

## Nutzung

- **Shortcut drücken** (Standard: ⌥⌘K) → Aufnahme startet
- **Erneut Shortcut drücken** → Aufnahme stoppt, Transkription läuft
- Text wird automatisch ins Clipboard kopiert und (bei aktiviertem Auto-Paste) eingefügt

## Hinweise

- Bei erstem Start Mikrofon-Berechtigung und ggf. Accessibility-Berechtigung (für Auto-Paste) erteilen
- Die App erscheint NICHT im Dock, nur in der Menüleiste

## Technische Details

- Electron 33
- electron-store für Settings-Persistenz
- auto-launch für Autostart-Funktion
- Groq Whisper Large V3 für Transkription
- Claude Haiku 4.5 für optionales Polishing
