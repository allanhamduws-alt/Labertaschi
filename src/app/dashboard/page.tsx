"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  Clipboard,
  Command,
  Languages,
  Loader2,
  Mic,
  Moon,
  Sparkles,
  Square,
  Sun,
} from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

type ToneMode = "Code" | "Casual" | "Formal";
type Language = "de" | "en";
type FormatHint = "default" | "bullets" | "code";
type RecordingState = "idle" | "recording" | "transcribing";

export default function DashboardPage() {
  const { setTheme, theme } = useTheme();
  const [language, setLanguage] = useState<Language>("de");
  const [tone, setTone] = useState<ToneMode>("Code");
  const [formatHint, setFormatHint] = useState<FormatHint>("default");
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [isPolishing, setIsPolishing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [polished, setPolished] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const languageRef = useRef<Language>(language);

  // Sync language ref
  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  const autosize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 520)}px`;
  }, []);

  useEffect(() => {
    autosize();
  }, [transcript, autosize]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Transkription am Ende der Aufnahme
  const transcribeAudio = useCallback(async () => {
    if (chunksRef.current.length === 0) {
      console.log("No audio chunks to transcribe");
      setRecordingState("idle");
      return;
    }

    setRecordingState("transcribing");
    const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
    console.log("Transcribing audio:", audioBlob.size, "bytes");

    try {
      const res = await fetch(`/api/transcribe?language=${languageRef.current}`, {
        method: "POST",
        body: audioBlob,
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.transcript?.trim() || "";
        console.log("Groq transcript:", text);
        if (!text) {
          toast.message("Nichts erkannt");
        } else {
          setTranscript((prev) => (prev ? `${prev} ${text}` : text));
          toast.success("Transkription fertig!");
        }
      } else {
        console.error("Transcription failed:", res.status);
        toast.error("Transkription fehlgeschlagen");
      }
    } catch (err) {
      console.error("Transcription error:", err);
      toast.error("Transkription fehlgeschlagen");
    } finally {
      setRecordingState("idle");
    }
  }, []);

  const closeRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredType = "audio/webm;codecs=opus";
      const mimeType = MediaRecorder.isTypeSupported(preferredType)
        ? preferredType
        : undefined;

      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined,
      );

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        console.log("MediaRecorder stopped, chunks:", chunksRef.current.length);
        transcribeAudio();
      };

      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setRecordingState("recording");
      toast.success("Aufnahme gestartet");
    } catch (err) {
      console.error(err);
      toast.error("Mikrofon nicht verfügbar");
    }
  }, [transcribeAudio]);

  const toggleRecording = useCallback(() => {
    if (recordingState === "recording") {
      closeRecording();
    } else if (recordingState === "idle") {
      startRecording();
    }
    // Wenn "transcribing", nichts tun
  }, [recordingState, closeRecording, startRecording]);

  const handlePolish = async () => {
    if (!transcript.trim()) {
      toast.message("Nichts zu polieren");
      return;
    }
    setIsPolishing(true);
    setCopied(false);
    const started = performance.now();
    try {
      const res = await fetch("/api/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcription: transcript,
          tone,
          language,
          formatHint,
        }),
      });
      if (!res.ok) throw new Error("Polish failed");
      const data = await res.json();
      const text = data.text ?? "";
      setPolished(text);
      const latency = Math.round(performance.now() - started);
      console.debug(`[Claude Haiku 4.5] Latency: ${latency}ms`);
      toast.success("Polished Prompt bereit");
    } catch (error) {
      console.error(error);
      toast.error("Polish fehlgeschlagen");
    } finally {
      setIsPolishing(false);
    }
  };

  const handleCopy = async () => {
    if (!polished) return;
    await navigator.clipboard.writeText(polished);
    setCopied(true);
    toast.success("Perfekt für Cursor Agent!");
    setTimeout(() => setCopied(false), 1400);
  };

  const isRecording = recordingState === "recording";
  const isTranscribing = recordingState === "transcribing";
  const micPulseClasses = isRecording ? "animate-pulse-soft bg-primary/20" : "bg-accent";

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-soft-sm">
              <Mic className="h-5 w-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-foreground">
                Wispr Flow Clone ✨
              </span>
              <span className="text-xs text-muted-foreground">Groq Whisper · Claude Haiku 4.5</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "px-3",
                language === "de" && "bg-accent text-foreground",
              )}
              onClick={() => setLanguage("de")}
            >
              <Languages className="mr-2 h-4 w-4" />
              DE
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "px-3",
                language === "en" && "bg-accent text-foreground",
              )}
              onClick={() => setLanguage("en")}
            >
              <Languages className="mr-2 h-4 w-4" />
              EN
            </Button>

            <div className="mx-2 h-6 w-px bg-border" />

            <div className="flex rounded-md border bg-card shadow-soft-sm">
              {(["Code", "Casual", "Formal"] as ToneMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    setTone(mode);
                    if (mode === "Code") setFormatHint("code");
                  }}
                  className={cn(
                    "px-3 py-1 text-sm transition hover:bg-accent",
                    tone === mode && "bg-accent font-semibold",
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>

            <Button
              variant="ghost"
              size="icon"
              aria-label="Cmd+K"
              onClick={() => setCommandOpen(true)}
            >
              <Command className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              aria-label="Theme Toggle"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-16 pt-8 sm:px-6">
        <section className="card">
          <div className="flex flex-col gap-3 border-b px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Button
                size="icon"
                variant="ghost"
                className={cn("h-12 w-12 rounded-full border", micPulseClasses)}
                onClick={toggleRecording}
                disabled={isTranscribing}
                aria-pressed={isRecording}
              >
                {isRecording ? (
                  <div className="relative flex items-center justify-center">
                    <span className="absolute h-10 w-10 rounded-full bg-primary/25" />
                    <Square className="relative h-5 w-5 text-primary fill-primary" />
                  </div>
                ) : isTranscribing ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Mic className="h-5 w-5" />
                )}
              </Button>
              <div className="flex flex-col">
                <p className="text-sm font-semibold text-foreground">
                  {isRecording ? "🎤 Aufnahme läuft..." : isTranscribing ? "⏳ Transkribiere..." : "Aufnahme"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isRecording ? "Klicke zum Stoppen" : "Klicke zum Starten · Groq Whisper"}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setTranscript("")} size="sm">
                Reset
              </Button>
            </div>
          </div>

          <div className="px-6 pb-6 pt-4">
            <Textarea
              ref={textareaRef}
              placeholder="Transkript erscheint hier nach der Aufnahme..."
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
          </div>
        </section>

        <section className="card">
          <div className="flex flex-col gap-3 border-b px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary/10 text-secondary shadow-soft-sm">
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="flex flex-col">
                <p className="text-sm font-semibold text-foreground">AI Polish ✨</p>
                <p className="text-xs text-muted-foreground">
                  Entfernt Füllwörter · Fix Tech Terms · Formatiert
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={handlePolish}
                disabled={isPolishing || !transcript.trim()}
              >
                {isPolishing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Läuft...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" /> Polish
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={handleCopy}
                disabled={!polished}
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4" /> Kopiert
                  </>
                ) : (
                  <>
                    <Clipboard className="h-4 w-4" /> Copy
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="px-6 pb-6 pt-4">
            <Textarea
              placeholder="Polierter Prompt erscheint hier..."
              value={polished}
              onChange={(e) => setPolished(e.target.value)}
              className="min-h-[200px]"
            />
          </div>
        </section>
      </main>

      <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
        <CommandInput placeholder="Befehle: Code Block, Bullets, Formal..." />
        <CommandList>
          <CommandGroup heading="Tone">
            <CommandItem
              onSelect={() => {
                setTone("Code");
                setFormatHint("code");
                setCommandOpen(false);
              }}
            >
              Code Block
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setTone("Formal");
                setFormatHint("default");
                setCommandOpen(false);
              }}
            >
              Formal
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setTone("Casual");
                setFormatHint("bullets");
                setCommandOpen(false);
              }}
            >
              Bullets
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Aktionen">
            <CommandItem onSelect={toggleRecording} disabled={isTranscribing}>
              {isRecording ? "Stop Recording" : "Start Recording"}
            </CommandItem>
            <CommandItem onSelect={handlePolish}>
              AI Polish jetzt
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </div>
  );
}
