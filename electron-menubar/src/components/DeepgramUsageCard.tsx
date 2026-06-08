import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { DeepgramUsage } from '@/types/electron';

// Gemeinsame Verbrauchsübersicht für BEIDE Settings-UIs (Dashboard + separates Fenster),
// damit die Anzeige nie auseinanderläuft. Zahlen sind lokale Schätzwerte aus der
// gesendeten Audiolänge (zuverlässig, ohne billing-fähigen Deepgram-Key).

function fmtDuration(seconds: number): string {
  const s = Math.max(0, seconds || 0);
  const m = s / 60;
  if (m < 1) return `${Math.round(s)} s`;
  if (m < 60) return `${m.toFixed(1)} Min`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return `${h} Std ${rem} Min`;
}

function fmtUsd(n: number): string {
  return `$${(n || 0).toFixed(2)}`;
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function DeepgramUsageCard() {
  const [usage, setUsage] = useState<DeepgramUsage | null>(null);

  const load = async () => {
    try {
      setUsage(await window.electronAPI.getDeepgramUsage());
    } catch {
      /* IPC nicht verfügbar — Karte bleibt leer */
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleReset = async () => {
    await window.electronAPI.resetDeepgramUsage();
    await load();
  };

  const month = currentMonthKey();
  const monthData = usage?.perMonth?.[month] ?? { seconds: 0, costUsd: 0, requests: 0 };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Deepgram-Verbrauch</CardTitle>
        <CardDescription>
          Lokal geschätzt aus der gesendeten Audiolänge (nova-3 + Diarization). Echter Stand:{' '}
          <a href="https://console.deepgram.com/usage" className="text-primary underline" target="_blank" rel="noopener">
            console.deepgram.com
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-lg font-semibold tabular-nums">{fmtDuration(usage?.totalSeconds ?? 0)}</div>
            <div className="text-[11px] text-muted-foreground">Gesamt</div>
          </div>
          <div>
            <div className="text-lg font-semibold tabular-nums">~{fmtUsd(usage?.totalCostUsd ?? 0)}</div>
            <div className="text-[11px] text-muted-foreground">Geschätzte Kosten</div>
          </div>
          <div>
            <div className="text-lg font-semibold tabular-nums">{usage?.totalRequests ?? 0}</div>
            <div className="text-[11px] text-muted-foreground">Aufrufe</div>
          </div>
        </div>
        <div className="text-xs text-muted-foreground border-t border-border/40 pt-2 flex items-center justify-between">
          <span>
            Dieser Monat: {fmtDuration(monthData.seconds)} · ~{fmtUsd(monthData.costUsd)} · {monthData.requests} Aufrufe
          </span>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={handleReset}>
            Zurücksetzen
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
