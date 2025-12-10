import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type StreamState = "idle" | "connecting" | "streaming" | "transcribing" | "polishing" | "error";

// API URLs
const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5173";
const TRANSCRIBE_URL = `${BASE_URL}/api/transcribe`;
const POLISH_URL = `${BASE_URL}/api/polish`;

type Language = "de" | "en";

declare global {
  interface Window {
    electronAPI?: {
      onHotkeyToggle: (cb: () => void) => void;
      sendOutput: (text: string, opts: { autopaste: boolean }) => void;
      copyText: (text: string) => void;
      openAccessibilitySettings: () => void;
    };
  }
}

export default function App() {
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [transcript, setTranscript] = useState("");
  const [polishedText, setPolishedText] = useState("");
  const [language, setLanguage] = useState<Language>("de");
  const [autopaste, setAutopaste] = useState(
    () => localStorage.getItem("autopaste") !== "false",
  );
  const [enablePolish, setEnablePolish] = useState(
    () => localStorage.getItem("enablePolish") !== "false",
  );

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Refs für Closures
  const toggleRef = useRef<() => void>(() => {});
  const languageRef = useRef<Language>(language);
  const autopasteRef = useRef(autopaste);
  const enablePolishRef = useRef(enablePolish);

  // Sync refs
  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  useEffect(() => {
    autopasteRef.current = autopaste;
    localStorage.setItem("autopaste", String(autopaste));
  }, [autopaste]);

  useEffect(() => {
    enablePolishRef.current = enablePolish;
    localStorage.setItem("enablePolish", String(enablePolish));
  }, [enablePolish]);

  useEffect(() => {
    window.electronAPI?.onHotkeyToggle(() => {
      console.log("Hotkey pressed!");
      toggleRef.current();
    });
  }, []);

  const reset = () => {
    setTranscript("");
    setPolishedText("");
    chunksRef.current = [];
  };

  // Audio-Feedback für Start/Stop
  const playBeep = (frequency: number, duration: number) => {
    try {
      const audioCtx = new AudioContext();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.frequency.value = frequency;
      oscillator.type = "sine";
      gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + duration);
    } catch (e) {
      console.error("Beep failed", e);
    }
  };

  // Polish mit Claude (einfacher Prompt)
  const polishText = useCallback(async (text: string): Promise<string | null> => {
    try {
      console.log("[Polish] Sending:", text.substring(0, 80) + "...");
      const res = await fetch(POLISH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcription: text,
          tone: "Code",
          language: languageRef.current,
          formatHint: "default",
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const polished = data.text?.trim() || "";
        console.log("[Polish] Result:", polished.substring(0, 80) + "...");
        return polished;
      } else {
        console.error("[Polish] Failed:", res.status);
        return null;
      }
    } catch (err) {
      console.error("[Polish] Error:", err);
      return null;
    }
  }, []);

  // Hauptfunktion: Transkribieren + Optional Polieren
  const processRecording = useCallback(async () => {
    if (chunksRef.current.length === 0) {
      console.log("No audio to process");
      setStreamState("idle");
      return;
    }

    // 1. Transkribieren
    setStreamState("transcribing");
    const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
    console.log("[Transcribe] Sending:", audioBlob.size, "bytes");

    let transcriptText = "";
    try {
      const res = await fetch(`${TRANSCRIBE_URL}?language=${languageRef.current}`, {
        method: "POST",
        body: audioBlob,
      });

      if (res.ok) {
        const data = await res.json();
        transcriptText = data.transcript?.trim() || "";
        console.log("[Transcribe] Result:", transcriptText);
        setTranscript(transcriptText);
      } else {
        console.error("[Transcribe] Failed:", res.status);
        setStreamState("error");
        return;
      }
    } catch (err) {
      console.error("[Transcribe] Error:", err);
      setStreamState("error");
      return;
    }

    if (!transcriptText) {
      setStreamState("idle");
      return;
    }

    // 2. Optional: Polieren
    let finalText = transcriptText;
    if (enablePolishRef.current) {
      setStreamState("polishing");
      const polished = await polishText(transcriptText);
      if (polished) {
        finalText = polished;
        setPolishedText(polished);
      } else {
        // Fallback: Nutze unpolierten Text
        setPolishedText(transcriptText + " (unpoliert)");
      }
    }

    // 3. Auto-Paste
    if (autopasteRef.current && window.electronAPI) {
      console.log("[Output] Sending to paste:", finalText.substring(0, 50) + "...");
      window.electronAPI.sendOutput(finalText, { autopaste: true });
    }

    setStreamState("idle");
  }, [polishText]);

  const closeStream = useCallback(() => {
    if (recRef.current && recRef.current.state !== "inactive") {
      recRef.current.stop();
    }
    recRef.current?.stream.getTracks().forEach((t) => t.stop());
    recRef.current = null;
  }, []);

  const startStream = useCallback(async () => {
    setStreamState("connecting");
    reset();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("Microphone access granted");

      const preferredType = "audio/webm;codecs=opus";
      const mimeType = MediaRecorder.isTypeSupported(preferredType)
        ? preferredType
        : undefined;

      const rec = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined,
      );

      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };

      rec.onstop = () => {
        console.log("Recording stopped, chunks:", chunksRef.current.length);
        processRecording();
      };

      rec.start(1000);
      recRef.current = rec;
      setStreamState("streaming");
      console.log("Recording started!");
      playBeep(800, 0.15);
    } catch (err) {
      console.error("Microphone error:", err);
      setStreamState("error");
    }
  }, [processRecording]);

  const toggleStream = useCallback(async () => {
    console.log("toggleStream called, state:", streamState);
    if (streamState === "connecting" || streamState === "streaming") {
      playBeep(400, 0.15);
      closeStream();
      return;
    }
    if (streamState === "transcribing" || streamState === "polishing") {
      return;
    }
    await startStream();
  }, [streamState, closeStream, startStream]);

  useEffect(() => {
    toggleRef.current = toggleStream;
  }, [toggleStream]);

  const statusLabel = useMemo(() => {
    switch (streamState) {
      case "connecting": return "Verbinde...";
      case "streaming": return "🎤 Aufnahme läuft";
      case "transcribing": return "⏳ Transkribiere...";
      case "polishing": return "✨ Poliere...";
      case "error": return "❌ Fehler";
      default: return "Bereit";
    }
  }, [streamState]);

  return (
    <div className="app">
      <header className="row">
        <div className="title">Menubar Stream</div>
        <div className="status">{statusLabel}</div>
      </header>

      <div className="row gap">
        <button
          className={`btn ${streamState === "streaming" ? "danger" : "primary"}`}
          onClick={toggleStream}
          disabled={streamState === "transcribing" || streamState === "polishing"}
        >
          {streamState === "streaming" ? "Stop" : "Start (Hotkey)"}
        </button>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          className="select"
        >
          <option value="de">DE</option>
          <option value="en">EN</option>
        </select>
      </div>

      <div className="row gap" style={{ marginTop: "4px" }}>
        <label className="row small-gap">
          <input
            type="checkbox"
            checked={autopaste}
            onChange={(e) => setAutopaste(e.target.checked)}
          />
          Auto-Paste
        </label>
        <label className="row small-gap" title="Poliert mit Claude Haiku nach Transkription">
          <input
            type="checkbox"
            checked={enablePolish}
            onChange={(e) => setEnablePolish(e.target.checked)}
          />
          Polish ✨
        </label>
      </div>

      <div className="note">
        Hotkey → Aufnahme → Stop → Transkript{enablePolish ? " → Polish" : ""} → Paste
      </div>

      <div className="block">
        <div className="label">Transkript (Groq)</div>
        <div className="box">{transcript || "—"}</div>
      </div>

      {enablePolish && (
        <div className="block">
          <div className="label">Poliert (Claude)</div>
          <div className="box final">{polishedText || "—"}</div>
        </div>
      )}
    </div>
  );
}
