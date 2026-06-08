import { Trash2, Headphones } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { MeetingIndexEntry } from '@/types/meeting';

interface MeetingsListProps {
  items: MeetingIndexEntry[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function MeetingsList({ items, onSelect, onDelete }: MeetingsListProps) {
  if (items.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        <Headphones className="w-12 h-12 mx-auto mb-3 opacity-20" />
        <p>Noch keine Meetings</p>
        <p className="text-sm mt-1">Aufgezeichnete Meetings erscheinen hier.</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[calc(100vh-200px)]">
      <div className="space-y-2 pr-2">
        {items.map((item) => (
          <Card
            key={item.id}
            className="group cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => onSelect(item.id)}
          >
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm truncate">{item.title}</span>
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      {item.speakerCount} Sprecher
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                    {item.preview}
                  </p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      {new Date(item.startTime).toLocaleString('de-DE', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span>{formatDuration(item.durationMs)}</span>
                    {item.hasSummary && (
                      <Badge variant="outline" className="text-xs py-0">Protokoll</Badge>
                    )}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className={cn(
                    'h-8 w-8 shrink-0 text-destructive opacity-0 group-hover:opacity-100 transition-opacity'
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(item.id);
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}
