import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Mic2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { MeetingFull, MeetingTodo } from '@/types/meeting';

interface MeetingDetailProps {
  id: string;
  onBack: () => void;
}

export function MeetingDetail({ id, onBack }: MeetingDetailProps) {
  const [meeting, setMeeting] = useState<MeetingFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [retranscribing, setRetranscribing] = useState(false);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [todos, setTodos] = useState<MeetingTodo[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const data = await window.electronAPI.getMeeting(id);
      setMeeting(data);
      setTodos(data?.summary?.todos ?? []);
      setSpeakerNames({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const handleToggleTodo = async (idx: number) => {
    setTodos(prev =>
      prev.map((t, i) => (i === idx ? { ...t, erledigt: !t.erledigt } : t))
    );
    await window.electronAPI.toggleMeetingTodo(id, idx);
  };

  const handleRegenerateSummary = async () => {
    setRegenerating(true);
    try {
      await window.electronAPI.regenerateSummary(id);
      await load();
    } finally {
      setRegenerating(false);
    }
  };

  const handleRetranscribe = async () => {
    setRetranscribing(true);
    try {
      await window.electronAPI.retranscribeMeeting(id);
      await load();
    } finally {
      setRetranscribing(false);
    }
  };

  const handleRenameSpeaker = async (from: string, to: string) => {
    if (!to) return;
    await window.electronAPI.renameSpeaker(id, from, to);
    await load();
  };

  const speakerLabel = (speaker: string): string => {
    if (speaker === 'me') return 'Ich';
    if (speaker === 'other') return 'Gegenstelle';
    return speaker;
  };

  const speakerClass = (speaker: string): string => {
    if (speaker === 'me') return 'text-primary font-semibold';
    if (speaker === 'other') return 'text-accent-foreground font-semibold';
    return 'text-muted-foreground font-semibold';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        Lade Meeting...
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p>Meeting nicht gefunden.</p>
        <Button variant="outline" className="mt-4" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Zurück
        </Button>
      </div>
    );
  }

  const { index, transcript, summary, audio } = meeting;
  // Audio wird nach dem Meeting nicht mehr aufbewahrt (Transkript ist der Deliverable).
  // 'Neu transkribieren' braucht aber die Audiodatei → nur verfügbar, solange Audio existiert.
  const hasAudio = !!(audio.mic || audio.system);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="font-semibold">{index.title}</h2>
          <p className="text-xs text-muted-foreground">
            {new Date(index.startTime).toLocaleString('de-DE', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
          {index.diarizationUsed && (
            <p className="text-[11px] text-blue-500 mt-0.5">
              Sprecher-Trennung (lokal) · {index.diarizationSpeakers ?? 0} Sprecher
            </p>
          )}
        </div>
      </div>

      {/* Summary / Protokoll */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Protokoll</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRegenerateSummary}
              disabled={regenerating}
            >
              {regenerating ? (
                <RefreshCw className="w-3 h-3 animate-spin mr-1" />
              ) : (
                <RefreshCw className="w-3 h-3 mr-1" />
              )}
              Neu erzeugen
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!summary ? (
            <p className="text-sm text-muted-foreground italic">Noch kein Protokoll vorhanden.</p>
          ) : (
            <>
              {/* Kurzzusammenfassung */}
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Zusammenfassung</Label>
                <p className="text-sm">{summary.kurzzusammenfassung}</p>
              </div>

              {/* Kernpunkte */}
              {summary.kernpunkte.length > 0 && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Kernpunkte</Label>
                  <ul className="list-disc list-inside space-y-1">
                    {summary.kernpunkte.map((punkt, i) => (
                      <li key={i} className="text-sm">{punkt}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Todos */}
              {todos.length > 0 && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">To-dos</Label>
                  <ul className="space-y-2">
                    {todos.map((todo, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={todo.erledigt}
                          onChange={() => handleToggleTodo(i)}
                          className="mt-0.5 accent-primary cursor-pointer"
                        />
                        <span className={cn(todo.erledigt && 'line-through text-muted-foreground')}>
                          {todo.text}
                          {todo.verantwortlich && (
                            <span className="text-xs text-muted-foreground ml-1">
                              ({todo.verantwortlich})
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Offene Fragen */}
              {summary.offeneFragen.length > 0 && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Offene Fragen</Label>
                  <ul className="list-disc list-inside space-y-1">
                    {summary.offeneFragen.map((frage, i) => (
                      <li key={i} className="text-sm">{frage}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Transkript */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Transkript</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetranscribe}
              disabled={retranscribing || !hasAudio}
              title={hasAudio ? 'Audio erneut transkribieren' : 'Audio wurde nach dem Meeting nicht aufbewahrt'}
            >
              {retranscribing ? (
                <RefreshCw className="w-3 h-3 animate-spin mr-1" />
              ) : (
                <Mic2 className="w-3 h-3 mr-1" />
              )}
              Neu transkribieren
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Sprecher umbenennen / zusammenführen (gleicher Name = Merge) */}
          {(() => {
            const uniq = Array.from(new Set(transcript.segments.map((s) => s.speaker)));
            if (uniq.length === 0) return null;
            return (
              <div className="p-3 bg-muted/40 rounded-lg space-y-2">
                <Label className="text-xs text-muted-foreground block">
                  Sprecher umbenennen — gleicher Name führt zwei Sprecher zusammen
                </Label>
                <div className="grid grid-cols-2 gap-2">
                  {uniq.map((sp) => (
                    <div key={sp} className="flex items-center gap-2">
                      <span className={cn('text-xs w-24 shrink-0 truncate', speakerClass(sp))}>
                        {speakerLabel(sp)}
                      </span>
                      <Input
                        placeholder="Neuer Name…"
                        value={speakerNames[sp] ?? ''}
                        onChange={(e) => setSpeakerNames((p) => ({ ...p, [sp]: e.target.value }))}
                        className="h-8 text-sm"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRenameSpeaker(sp, speakerNames[sp] ?? '')}
                        disabled={!speakerNames[sp]}
                      >
                        OK
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Segments */}
          <ScrollArea className="h-72">
            <div className="space-y-3 pr-2">
              {transcript.segments.map((seg, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className={cn('shrink-0 w-24 text-xs mt-0.5', speakerClass(seg.speaker))}>
                    {speakerLabel(seg.speaker)}
                  </span>
                  <p className="flex-1 leading-relaxed">{seg.text}</p>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Audio */}
      {(audio.mic || audio.system) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Audio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {audio.mic && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Mikrofon</Label>
                <audio controls src={`file://${audio.mic}`} className="w-full" />
              </div>
            )}
            {audio.system && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">System-Audio</Label>
                <audio controls src={`file://${audio.system}`} className="w-full" />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
