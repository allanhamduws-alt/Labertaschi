import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MeetingSegment } from '@/types/meeting';

type HealthColor = 'green' | 'yellow' | 'red';

interface MeetingStatus {
  color: HealthColor;
  reason: string;
  durationMs: number;
  micLevel: number;
  systemLevel: number;
}

function downsample(f32: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return f32;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = f32[Math.floor(i * ratio)];
  }
  return out;
}

function floatToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, f32[i]));
    out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return out;
}

function rms(int16: Int16Array): number {
  if (int16.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / int16.length);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function MeetingOverlay() {
  const [active, setActive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [health, setHealth] = useState<HealthColor>('green');
  const [reason, setReason] = useState('');
  const [durationMs, setDurationMs] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [systemLevel, setSystemLevel] = useState(0);
  const [liveSegments, setLiveSegments] = useState<MeetingSegment[]>([]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcmBufferRef = useRef<Float32Array>(new Float32Array(0));

  const TARGET_RATE = 16000;
  const CHUNK_SAMPLES = TARGET_RATE; // ~1 second

  const stopCapture = () => {
    workletNodeRef.current?.disconnect();
    srcNodeRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    workletNodeRef.current = null;
    srcNodeRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;
    pcmBufferRef.current = new Float32Array(0);
  };

  const startCapture = async () => {
    if (audioCtxRef.current) return; // bereits aktiv — Doppelstart (Push+Pull) vermeiden
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;

      await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));

      const srcNode = ctx.createMediaStreamSource(stream);
      srcNodeRef.current = srcNode;

      const node = new AudioWorkletNode(ctx, 'mic-processor');
      workletNodeRef.current = node;

      srcNode.connect(node);

      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        const f32: Float32Array = e.data;
        const downsampled = downsample(f32, ctx.sampleRate, TARGET_RATE);

        const prev = pcmBufferRef.current;
        const merged = new Float32Array(prev.length + downsampled.length);
        merged.set(prev);
        merged.set(downsampled, prev.length);
        pcmBufferRef.current = merged;

        if (pcmBufferRef.current.length >= CHUNK_SAMPLES) {
          const chunk = pcmBufferRef.current.slice(0, CHUNK_SAMPLES);
          pcmBufferRef.current = pcmBufferRef.current.slice(CHUNK_SAMPLES);

          const int16 = floatToInt16(chunk);
          // int16 ist frisch alloziert → sein buffer ist immer ein normaler ArrayBuffer
          window.electronAPI.sendMicPcm(int16.buffer as ArrayBuffer);
          window.electronAPI.sendMicLevel(rms(int16));
        }
      };
    } catch (err) {
      console.error('MeetingOverlay: mic error', err);
    }
  };

  useEffect(() => {
    window.electronAPI.onMeetingStarted(() => {
      setActive(true);
      setHealth('green');
      setReason('');
      setDurationMs(0);
      setMicLevel(0);
      setSystemLevel(0);
      setLiveSegments([]);
      startCapture();
    });

    window.electronAPI.onMeetingStopped(() => {
      stopCapture();
      setActive(false);
      setExpanded(false);
      setMicLevel(0);
      setSystemLevel(0);
    });

    window.electronAPI.onMeetingStatus((s: MeetingStatus) => {
      setHealth(s.color);
      setReason(s.reason);
      setDurationMs(s.durationMs);
      setMicLevel(s.micLevel);
      setSystemLevel(s.systemLevel);
    });

    // Live-Transkript (R5): bei jedem fertigen Chunk die gemergten Segmente anzeigen
    window.electronAPI.onMeetingTranscriptChunk((segs: MeetingSegment[]) => {
      setLiveSegments(segs);
    });

    // Pull-Modell gegen die Start-Race: falls das 'meeting:started'-Push-Event
    // verloren ging (Fenster beim ersten Start noch nicht geladen), Status aktiv abfragen.
    window.electronAPI.getMeetingStatus().then((st) => {
      if (st && st.active) {
        setActive(true);
        startCapture();
      }
    });

    return () => {
      stopCapture();
    };
  }, []);

  // Overlay-Fenster bei Bedarf vergrößern (Transkript-Panel), sonst klein/unauffällig
  useEffect(() => {
    if (active) window.electronAPI.setOverlayExpanded(expanded);
  }, [expanded, active]);

  if (!active) return null;

  const micBarHeight = Math.round(4 + micLevel * 16);
  const sysBarHeight = Math.round(4 + systemLevel * 16);

  const speakerLabel = (s: string) => (s === 'me' ? 'Ich' : s === 'other' ? 'Gegenstelle' : s);

  return (
    <div className="flex flex-col items-end justify-start h-screen p-1 gap-1">
      {/* Kleines Pill — Klick klappt das Transkript auf/zu */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded-xl backdrop-blur border shadow-md cursor-pointer select-none',
          'bg-card/95 border-border/50 transition-all duration-200',
          health === 'red' && 'border-red-500/50'
        )}
        onClick={() => setExpanded((e) => !e)}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={expanded ? 'Transkript ausblenden' : 'Transkript anzeigen'}
      >
        {/* Mic icon */}
        <Mic className="w-4 h-4 text-muted-foreground flex-shrink-0" />

        {/* Level bars */}
        <div className="flex items-end gap-0.5 h-5">
          <div
            className="w-1 bg-primary/70 rounded-full transition-all duration-100"
            style={{ height: `${micBarHeight}px` }}
          />
          <div
            className="w-1 bg-blue-400/70 rounded-full transition-all duration-100"
            style={{ height: `${sysBarHeight}px` }}
          />
        </div>

        {/* Health dot */}
        <div
          className={cn(
            'w-2 h-2 rounded-full flex-shrink-0',
            health === 'green' && 'bg-green-500',
            health === 'yellow' && 'bg-yellow-500',
            health === 'red' && 'bg-red-500'
          )}
        />

        {/* Dauer */}
        <span className="text-xs text-muted-foreground font-mono tabular-nums">
          {formatDuration(durationMs)}
        </span>

        {/* Stop-Button */}
        <button
          className={cn(
            'flex items-center justify-center w-4 h-4 rounded-sm',
            'bg-destructive/80 hover:bg-destructive transition-colors',
            'text-destructive-foreground'
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={(e) => { e.stopPropagation(); window.electronAPI.stopMeeting(); }}
          title="Meeting stoppen"
        >
          <span className="text-[8px] leading-none font-bold">■</span>
        </button>
      </div>

      {/* Rot: Klartext-Grund (z.B. fehlende Berechtigung) */}
      {health === 'red' && reason && (
        <div
          className="px-2 py-1 rounded-lg bg-card/95 border border-red-500/50 text-[10px] text-red-400 max-w-[340px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {reason}
        </div>
      )}

      {/* Ausgeklappt: mitlaufendes Transkript (R5) */}
      {expanded && (
        <div
          className="w-[340px] max-h-[180px] overflow-y-auto px-2 py-1.5 rounded-xl backdrop-blur border bg-card/95 border-border/50 shadow-md"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {liveSegments.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Transkript erscheint, sobald gesprochen wird …</p>
          ) : (
            <div className="space-y-1">
              {liveSegments.slice(-12).map((seg, i) => (
                <p key={i} className="text-[11px] leading-snug">
                  <span className={cn('font-semibold', seg.speaker === 'me' ? 'text-primary' : 'text-blue-400')}>
                    {speakerLabel(seg.speaker)}:
                  </span>{' '}
                  <span className="text-foreground/90">{seg.text}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
