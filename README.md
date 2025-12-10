## Labertaschi – Voice Transcription MVP

Voice → Groq Whisper Large V3 → Claude Haiku 4.5 polish. Mac-Utility Look, PWA-ready, Dark/Light.

### Quickstart
1) `.env.local` mit:
```
GROQ_API_KEY=...
ANTHROPIC_API_KEY=...
```
2) Dev-Server: `npm run dev` → http://localhost:5173/dashboard

### Features
- Live-Transkription (MediaRecorder → Chunk-HTTP-POST → `/api/transcribe`, Groq Whisper Large V3).
- AI Polish (`/api/polish`, Claude Haiku 4.5) mit Tone (Code/Casual/Formal) + FormatHint (Code Block/Bullets).
- Cmd+K Palette (Code Block, Bullets, Formal, Start/Stop Recording, Polish).
- Copy + Toast („Perfekt für Cursor Agent!"), Dark/Light Toggle, DE/EN Toggle.
- PWA manifest (start_url `/dashboard`), mobile-first Layout.

### Electron Menubar App
Die Electron-App unter `electron-menubar/` nutzt dieselbe Transkriptions-API.
Starte die Menubar-App mit:
```bash
cd electron-menubar
npm install
npm run dev
```

### Notes & Next Steps
- Groq Whisper nutzt HTTP-Chunk-Uploads (kein WebSocket), ca. 1s-Chunks für optimale Latenz.
- Latenz messen: Browser Performance API + server logs (Groq + Anthropic).
- Groq ist ~164x schneller als Echtzeit und günstiger als Deepgram bei vergleichbarer Qualität.

### Hinweis
Der Projektordner heißt aktuell noch `WhisprLo` – kann manuell umbenannt werden zu `Labertaschi`.
