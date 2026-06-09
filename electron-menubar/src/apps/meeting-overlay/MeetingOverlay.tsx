import { useEffect, useRef, useState } from 'react';
import { Mic, Phone } from 'lucide-react';
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

// Resampling auf die Zielrate (16 kHz). Läuft auf einem Default-AudioContext
// (Geräterate) — ein erzwungener 16-kHz-Context lieferte in Electron/Chromium mit
// MediaStreamSource teils STILLE (Capture-Regression).
// - fromRate > toRate: Downsampling per MITTELUNG (Box-Filter) = leichtes Anti-Aliasing.
// - fromRate < toRate: Upsampling per linearer Interpolation. WICHTIG, weil sonst ein
//   Sub-16k-Gerät (z.B. Bluetooth-Headset im SCO-Profil mit 8 kHz) unverändert als
//   16 kHz weiterverarbeitet würde → doppeltes Tempo/Tonhöhe + kaputtes Transkript.
function downsample(f32: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return f32;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(f32.length / ratio));
  const out = new Float32Array(outLen);
  if (fromRate < toRate) {
    // Upsampling: linear zwischen den Stützstellen interpolieren
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = f32[i0] ?? 0;
      const b = f32[i0 + 1] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }
  // Downsampling: über das Quell-Fenster mitteln
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(f32.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = start; j < end; j++) s += f32[j];
    out[i] = s / Math.max(1, end - start);
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

// Mikrofon-Constraints. NS/AGC IMMER aus → rohes, volles Mikrofon-Signal ohne WebRTC-
// Bandbegrenzung, ohne AGC-Clipping, ohne NoiseSuppression die eine 2. (leisere) Stimme als
// Rauschen wegfiltert — entscheidend für die lokale Sprecher-Trennung. EchoCancellation nur,
// wenn ein Anruf auf diesem Computer erkannt wurde (dann spielt die Gegenstelle über die
// Lautsprecher → EC reduziert ihr Echo im Mikro; zusätzlich filtert die Pipeline es heraus).
function micConstraints(callActive: boolean): MediaTrackConstraints {
  return {
    channelCount: 1,
    echoCancellation: callActive,
    noiseSuppression: false,
    autoGainControl: false,
  };
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
  const [diarization, setDiarization] = useState(false);
  const [callActive, setCallActive] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcmBufferRef = useRef<Float32Array>(new Float32Array(0));
  // Anruf-Zustand als Ref — wird in async-Capture-Closures gelesen (State ist dort evtl. stale).
  const callActiveRef = useRef(false);

  // System-Loopback-Capture (nur Windows; macOS nimmt System-Audio über AudioTee im Main auf)
  const sysAudioCtxRef = useRef<AudioContext | null>(null);
  const sysWorkletRef = useRef<AudioWorkletNode | null>(null);
  const sysSrcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sysStreamRef = useRef<MediaStream | null>(null);
  const sysPcmBufferRef = useRef<Float32Array>(new Float32Array(0));
  const isWindows = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);

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
        audio: micConstraints(callActiveRef.current),
      });
      streamRef.current = stream;

      // Default-AudioContext (Geräterate). KEIN erzwungenes sampleRate:16000 — das lieferte
      // mit MediaStreamSource in Electron/Chromium teils eine STILLE Spur. Auf 16 kHz wird
      // in JS per Mittelung heruntergerechnet (downsample()).
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

  const stopSystemCapture = () => {
    sysWorkletRef.current?.disconnect();
    sysSrcRef.current?.disconnect();
    sysStreamRef.current?.getTracks().forEach((t) => t.stop());
    sysAudioCtxRef.current?.close();
    sysWorkletRef.current = null;
    sysSrcRef.current = null;
    sysStreamRef.current = null;
    sysAudioCtxRef.current = null;
    sysPcmBufferRef.current = new Float32Array(0);
  };

  // Windows: System-Mix per Loopback abgreifen (Pendant zu AudioTee auf macOS).
  // getDisplayMedia liefert dank des Main-Handlers audio:'loopback'; der Video-Track
  // ist auf Windows Pflicht und wird sofort verworfen.
  const startSystemCapture = async () => {
    if (!isWindows || sysAudioCtxRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        console.error('MeetingOverlay: kein System-Audio-Track (Loopback)');
        return;
      }
      sysStreamRef.current = stream;

      const ctx = new AudioContext();
      sysAudioCtxRef.current = ctx;

      await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));

      const srcNode = ctx.createMediaStreamSource(stream);
      sysSrcRef.current = srcNode;

      const node = new AudioWorkletNode(ctx, 'mic-processor');
      sysWorkletRef.current = node;

      srcNode.connect(node);

      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        const f32: Float32Array = e.data;
        const downsampled = downsample(f32, ctx.sampleRate, TARGET_RATE);

        const prev = sysPcmBufferRef.current;
        const merged = new Float32Array(prev.length + downsampled.length);
        merged.set(prev);
        merged.set(downsampled, prev.length);
        sysPcmBufferRef.current = merged;

        if (sysPcmBufferRef.current.length >= CHUNK_SAMPLES) {
          const chunk = sysPcmBufferRef.current.slice(0, CHUNK_SAMPLES);
          sysPcmBufferRef.current = sysPcmBufferRef.current.slice(CHUNK_SAMPLES);

          const int16 = floatToInt16(chunk);
          // Pegel/gotSystemPcm berechnet der Controller aus dem PCM (wie bei AudioTee).
          window.electronAPI.sendSystemPcm(int16.buffer as ArrayBuffer);
        }
      };
    } catch (err) {
      console.error('MeetingOverlay: system loopback error', err);
    }
  };

  useEffect(() => {
    window.electronAPI.onMeetingStarted((d) => {
      setActive(true);
      setHealth('green');
      setReason('');
      setDurationMs(0);
      setMicLevel(0);
      setSystemLevel(0);
      setLiveSegments([]);
      if (d) { setDiarization(!!d.diarization); const ca = !!d.callActive; callActiveRef.current = ca; setCallActive(ca); }
      startCapture();
      startSystemCapture();
    });

    window.electronAPI.onMeetingStopped(() => {
      stopCapture();
      stopSystemCapture();
      setActive(false);
      setExpanded(false);
      setMicLevel(0);
      setSystemLevel(0);
      callActiveRef.current = false;
      setCallActive(false);
    });

    // Anruf-Erkennung (live): ein anderer Prozess nutzt das Mikro → Gegenstelle wird mitgenommen.
    // Echo-Cancellation live nachziehen, damit das Lautsprecher-Echo der Gegenstelle gedämpft wird.
    window.electronAPI.onMeetingCallState((d) => {
      const ca = !!(d && d.active);
      callActiveRef.current = ca;
      setCallActive(ca);
      const track = streamRef.current?.getAudioTracks?.()[0];
      track?.applyConstraints?.(micConstraints(ca)).catch(() => { /* best effort */ });
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
        setDiarization(!!st.diarization);
        const ca = !!st.callActive; callActiveRef.current = ca; setCallActive(ca);
        startCapture();
        startSystemCapture();
      }
    });

    return () => {
      stopCapture();
      stopSystemCapture();
    };
  }, []);

  // Overlay-Fenster bei Bedarf vergrößern (Transkript-Panel), sonst klein/unauffällig
  useEffect(() => {
    if (active) window.electronAPI.setOverlayExpanded(expanded);
  }, [expanded, active]);

  if (!active) return null;

  return (
    <div className="flex flex-col items-end justify-start h-screen p-1 gap-1">
      {/* Einziges kleines Pill: Mic · Status · System-Audio-Schalter · Dauer · Stop. Kein Aufklappen. */}
      <div
        className="flex items-center gap-2 px-2.5 py-1 rounded-full border shadow-md select-none"
        style={{ WebkitAppRegion: 'no-drag', backgroundColor: '#ffffff', borderColor: health === 'red' ? '#ef4444' : '#e2e8f0' } as React.CSSProperties}
      >
        {/* Mic icon */}
        <Mic className="w-4 h-4 text-muted-foreground flex-shrink-0" />

        {/* Status-Punkt (grün = läuft, rot = Problem) */}
        <div
          className={cn(
            'w-2 h-2 rounded-full flex-shrink-0',
            health === 'green' && 'bg-green-500',
            health === 'yellow' && 'bg-yellow-500',
            health === 'red' && 'bg-red-500'
          )}
          title={health === 'red' ? (reason || 'Problem') : 'Aufnahme läuft'}
        />

        {/* Anruf-Indikator — erscheint nur, wenn automatisch ein Anruf auf diesem Computer
            erkannt wurde (die Gegenstelle wird dann mitgenommen). Kein Schalter mehr nötig. */}
        {callActive && (
          <span
            className="flex items-center gap-0.5 text-[10px] font-medium text-green-600 flex-shrink-0"
            title="Anruf erkannt — die Gegenstelle wird mitgenommen"
          >
            <Phone className="w-3 h-3" />
            Anruf
          </span>
        )}

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
          className="px-2 py-1 rounded-lg border border-red-500/50 text-[10px] text-red-500 max-w-[340px]"
          style={{ WebkitAppRegion: 'no-drag', backgroundColor: '#ffffff' } as React.CSSProperties}
        >
          {reason}
        </div>
      )}

    </div>
  );
}
