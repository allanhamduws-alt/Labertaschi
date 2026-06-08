import { useEffect, useState } from 'react';
import type { MeetingIndexEntry } from '@/types/meeting';
import { MeetingsList } from './MeetingsList';
import { MeetingDetail } from './MeetingDetail';

export function MeetingsView() {
  const [items, setItems] = useState<MeetingIndexEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    const data = await window.electronAPI.listMeetings();
    setItems(data);
  };

  useEffect(() => {
    load();
    window.electronAPI.onMeetingStopped(() => load());
  }, []);

  const handleDelete = async (id: string) => {
    await window.electronAPI.deleteMeeting(id);
    await load();
  };

  if (selectedId !== null) {
    return (
      <MeetingDetail
        id={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <MeetingsList
      items={items}
      onSelect={(id) => setSelectedId(id)}
      onDelete={handleDelete}
    />
  );
}
