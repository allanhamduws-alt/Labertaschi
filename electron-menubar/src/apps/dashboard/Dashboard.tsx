import { useCallback, useEffect, useState } from 'react';
import {
  Mic, History, BarChart3, Users, Code, Settings,
  Play, Square, Loader2, Copy, Check, Trash2, Star,
  Clock, Zap, MessageSquare, Plus, X, Search,
  Palette, FileText, Target, Edit, Lightbulb, Mail,
  Instagram, Sparkles, Save, Eye, EyeOff, Headphones
} from 'lucide-react';
import { MeetingsView } from './views/MeetingsView';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { Settings as SettingsType, HistoryItem, Stats, Profile, CustomAgent, Snippet } from '@/types/electron';

type NavItem = 'transcription' | 'history' | 'stats' | 'agents' | 'snippets' | 'settings' | 'meetings';

// Icon mapping for agents
const AGENT_ICONS: Record<string, React.ReactNode> = {
  chat: <MessageSquare className="w-5 h-5" />,
  document: <FileText className="w-5 h-5" />,
  star: <Sparkles className="w-5 h-5" />,
  target: <Target className="w-5 h-5" />,
  edit: <Edit className="w-5 h-5" />,
  zap: <Zap className="w-5 h-5" />,
  lightbulb: <Lightbulb className="w-5 h-5" />,
  palette: <Palette className="w-5 h-5" />,
};

const AGENT_COLORS = [
  '#7ED957', '#3B82F6', '#F7D154', '#EF4444', '#8B5CF6', '#EC4899'
];

const AGENT_TEMPLATES = [
  { id: 'image-prompt', name: 'Bild-Prompt Generator', desc: 'Für Midjourney, DALL-E', icon: 'palette' },
  { id: 'social-media', name: 'Social Media', desc: 'Posts für LinkedIn, Twitter', icon: 'star' },
  { id: 'email', name: 'E-Mail Profi', desc: 'Professionelle E-Mails', icon: 'edit' },
  { id: 'custom', name: 'Eigener Agent', desc: 'Von Grund auf anpassen', icon: 'star' },
];

export function Dashboard() {
  const [activeNav, setActiveNav] = useState<NavItem>('transcription');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const [activeProfile, setActiveProfile] = useState<string>('coding');
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const [platform, setPlatform] = useState<{ isMac: boolean; isWin: boolean; version?: string } | null>(null);

  // Load initial data
  useEffect(() => {
    const loadData = async () => {
      try {
        const [settingsData, historyData, statsData, profilesData, platformData, snippetsData] = await Promise.all([
          window.electronAPI.getSettings(),
          window.electronAPI.getHistory(),
          window.electronAPI.getStats(),
          window.electronAPI.getProfiles(),
          window.electronAPI.getPlatform(),
          window.electronAPI.getSnippets(),
        ]);
        setSettings(settingsData);
        setHistory(historyData);
        setStats(statsData);
        setProfiles(profilesData.profiles);
        setCustomAgents(profilesData.customAgents);
        setActiveProfile(profilesData.active);
        setPlatform(platformData);
        setSnippets(snippetsData);
      } catch (error) {
        console.error('Failed to load data:', error);
      }
    };
    loadData();

    // Listen for updates
    window.electronAPI.onHistoryUpdated((newHistory) => setHistory(newHistory));
    window.electronAPI.onStatsUpdated((newStats) => setStats(newStats));
    window.electronAPI.onAgentSwitched(({ id }) => setActiveProfile(id));
  }, []);

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      await window.electronAPI.stopTranscription();
      setIsRecording(false);
      setIsTranscribing(true);
      setTimeout(() => setIsTranscribing(false), 3000);
    } else {
      await window.electronAPI.startTranscription();
      setIsRecording(true);
    }
  }, [isRecording]);

  const handleCopy = async (item: HistoryItem) => {
    await window.electronAPI.copyHistoryItem(item.id);
    setCopied(item.id);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleDelete = async (id: number) => {
    await window.electronAPI.deleteHistoryItem(id);
  };

  const handleToggleFavorite = async (id: number) => {
    await window.electronAPI.toggleFavorite(id);
    setHistory(prev => prev.map(item => 
      item.id === id ? { ...item, favorite: !item.favorite } : item
    ));
  };

  const handleSettingChange = async (key: keyof SettingsType, value: boolean | string | number) => {
    await window.electronAPI.setSettings({ [key]: value });
    setSettings(prev => prev ? { ...prev, [key]: value } : null);
  };

  const handleAgentSwitch = async (agentId: string) => {
    await window.electronAPI.setActiveProfile(agentId);
    setActiveProfile(agentId);
  };

  const handleDeleteAgent = async (agentId: string) => {
    await window.electronAPI.deleteAgent(agentId);
    setCustomAgents(prev => prev.filter(a => a.id !== agentId));
  };

  const handleAddSnippet = async (name: string, template: string) => {
    const newSnippet = await window.electronAPI.addSnippet({ name, template });
    setSnippets(prev => [...prev, newSnippet]);
  };

  const handleDeleteSnippet = async (id: string) => {
    await window.electronAPI.deleteSnippet(id);
    setSnippets(prev => prev.filter(s => s.id !== id));
  };

  const handleCreateAgent = async (agent: Partial<CustomAgent>) => {
    const newAgent = await window.electronAPI.createAgent(agent);
    setCustomAgents(prev => [...prev, newAgent]);
  };

  const handleUpdateProfile = async (profileId: string, updates: Partial<Profile>) => {
    await window.electronAPI.updateProfile(profileId, updates);
    if (profiles[profileId]) {
      setProfiles(prev => ({
        ...prev,
        [profileId]: { ...prev[profileId], ...updates }
      }));
    }
  };

  const handleUpdateAgentHotkey = async (agentId: string, hotkey: string) => {
    await window.electronAPI.updateAgentHotkey(agentId, hotkey);
  };

  const shortcutDisplay = platform?.isMac ? 'Command+X' : 'Ctrl+X';

  const navItems = [
    { id: 'transcription' as const, label: 'Transkription', icon: Mic },
    { id: 'history' as const, label: 'History', icon: History },
    { id: 'meetings' as const, label: 'Meetings', icon: Headphones },
    { id: 'stats' as const, label: 'Stats', icon: BarChart3 },
    { id: 'agents' as const, label: 'Agenten', icon: Users },
    { id: 'snippets' as const, label: 'Snippets', icon: Code },
    { id: 'settings' as const, label: 'Einstellungen', icon: Settings },
  ];

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-56 border-r bg-sidebar flex flex-col">
        <div className="p-4 border-b flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center shadow-sm">
            <Mic className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sidebar-foreground">paply</span>
        </div>

        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                activeNav === item.id
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
              )}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="p-4 border-t text-xs text-muted-foreground text-center">
          paply v{platform?.version ?? '1.11.1'}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-14 border-b bg-card px-6 flex items-center justify-between">
          <h1 className="text-lg font-semibold">
            {navItems.find(n => n.id === activeNav)?.label}
          </h1>
          <Badge variant="outline" className="font-mono text-xs">
            {settings?.shortcut || shortcutDisplay}
          </Badge>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeNav === 'transcription' && (
            <TranscriptionView
              isRecording={isRecording}
              isTranscribing={isTranscribing}
              settings={settings}
              history={history}
              activeProfile={activeProfile}
              profiles={profiles}
              customAgents={customAgents}
              onToggleRecording={toggleRecording}
              onSettingChange={handleSettingChange}
              onCopy={handleCopy}
              copied={copied}
            />
          )}

          {activeNav === 'history' && (
            <HistoryView
              history={history}
              profiles={profiles}
              onCopy={handleCopy}
              onDelete={handleDelete}
              onToggleFavorite={handleToggleFavorite}
              copied={copied}
            />
          )}

          {activeNav === 'meetings' && <MeetingsView />}

          {activeNav === 'stats' && <StatsView stats={stats} history={history} settings={settings} />}

          {activeNav === 'agents' && (
            <AgentsView
              profiles={profiles}
              customAgents={customAgents}
              activeProfile={activeProfile}
              platform={platform}
              onAgentSwitch={handleAgentSwitch}
              onDeleteAgent={handleDeleteAgent}
              onCreateAgent={handleCreateAgent}
              onUpdateProfile={handleUpdateProfile}
              onUpdateAgentHotkey={handleUpdateAgentHotkey}
            />
          )}

          {activeNav === 'snippets' && (
            <SnippetsView
              snippets={snippets}
              onAddSnippet={handleAddSnippet}
              onDeleteSnippet={handleDeleteSnippet}
            />
          )}

          {activeNav === 'settings' && (
            <SettingsView
              settings={settings}
              platform={platform}
              onSettingChange={handleSettingChange}
            />
          )}
        </div>
      </main>
    </div>
  );
}

// Transcription View
function TranscriptionView({
  isRecording,
  isTranscribing,
  settings,
  history,
  activeProfile,
  profiles,
  customAgents,
  onToggleRecording,
  onSettingChange,
  onCopy,
  copied,
}: {
  isRecording: boolean;
  isTranscribing: boolean;
  settings: SettingsType | null;
  history: HistoryItem[];
  activeProfile: string;
  profiles: Record<string, Profile>;
  customAgents: CustomAgent[];
  onToggleRecording: () => void;
  onSettingChange: (key: keyof SettingsType, value: boolean | string | number) => void;
  onCopy: (item: HistoryItem) => void;
  copied: number | null;
}) {
  const lastResult = history[0];
  const activeAgent = profiles[activeProfile] || customAgents.find(a => a.id === activeProfile);

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Recording Card */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                size="lg"
                variant={isRecording ? 'destructive' : 'default'}
                className={cn(
                  'w-16 h-16 rounded-full',
                  isRecording && 'animate-pulse'
                )}
                onClick={onToggleRecording}
                disabled={isTranscribing}
              >
                {isTranscribing ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : isRecording ? (
                  <Square className="w-6 h-6 fill-current" />
                ) : (
                  <Mic className="w-6 h-6" />
                )}
              </Button>
              <div>
                <CardTitle>
                  {isRecording ? '🎤 Aufnahme läuft...' : isTranscribing ? '⏳ Transkribiere...' : 'Aufnahme'}
                </CardTitle>
                <CardDescription>
                  {isRecording ? 'Klicke zum Stoppen' : 'Klicke zum Starten oder nutze den Hotkey'}
                </CardDescription>
              </div>
            </div>
            {activeAgent && (
              <Badge variant="secondary" className="text-xs">
                {activeAgent.name}
              </Badge>
            )}
          </div>
        </CardHeader>
      </Card>

      {/* Last Result */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Letztes Ergebnis</CardTitle>
        </CardHeader>
        <CardContent>
          {lastResult ? (
            <div className="space-y-3">
              <div className="p-4 rounded-lg bg-muted/50 text-sm">
                {lastResult.polished || lastResult.transcript}
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  {new Date(lastResult.timestamp).toLocaleString('de-DE')}
                  <span className="mx-1">•</span>
                  {lastResult.wordCount} Wörter
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onCopy(lastResult)}
                >
                  {copied === lastResult.id ? (
                    <><Check className="w-4 h-4 mr-1" /> Kopiert</>
                  ) : (
                    <><Copy className="w-4 h-4 mr-1" /> Kopieren</>
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              <Mic className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>Noch keine Transkription</p>
              <p className="text-sm">Starte eine Aufnahme, um Text zu generieren</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="autopaste">Autopaste aktiviert</Label>
            <Switch
              id="autopaste"
              checked={settings?.autopaste ?? true}
              onCheckedChange={(checked) => onSettingChange('autopaste', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="clipboard">In Zwischenablage kopieren</Label>
            <Switch
              id="clipboard"
              checked={settings?.copyToClipboard ?? false}
              onCheckedChange={(checked) => onSettingChange('copyToClipboard', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="polish">Polish aktiviert</Label>
            <Switch
              id="polish"
              checked={settings?.enablePolish ?? true}
              onCheckedChange={(checked) => onSettingChange('enablePolish', checked)}
            />
          </div>
          <div className="pt-2 border-t">
            <Label className="text-xs text-muted-foreground mb-2 block">Sprache</Label>
            <Select
              value={settings?.language || 'de'}
              onChange={(e) => onSettingChange('language', e.target.value)}
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// History View with Search and Filters
function HistoryView({
  history,
  profiles,
  onCopy,
  onDelete,
  onToggleFavorite,
  copied,
}: {
  history: HistoryItem[];
  profiles: Record<string, Profile>;
  onCopy: (item: HistoryItem) => void;
  onDelete: (id: number) => void;
  onToggleFavorite: (id: number) => void;
  copied: number | null;
}) {
  const [filter, setFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredHistory = history.filter(item => {
    // Filter by type
    if (filter === 'favorites' && !item.favorite) return false;
    if (filter === 'coding' && item.role !== 'coding') return false;
    if (filter === 'meeting' && item.role !== 'meeting') return false;
    if (filter === 'dictation' && item.role !== 'dictation') return false;

    // Filter by search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const text = (item.polished || item.transcript).toLowerCase();
      return text.includes(query);
    }

    return true;
  });

  const filters = [
    { id: 'all', label: 'Alle', count: history.length },
    { id: 'favorites', label: 'Favoriten', count: history.filter(h => h.favorite).length, icon: Star },
    { id: 'coding', label: 'Coding', count: history.filter(h => h.role === 'coding').length },
    { id: 'meeting', label: 'Meeting', count: history.filter(h => h.role === 'meeting').length },
    { id: 'dictation', label: 'Diktat', count: history.filter(h => h.role === 'dictation').length },
  ];

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Suche in History..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Filter Chips */}
      <div className="flex gap-2 flex-wrap">
        {filters.map((f) => (
          <Button
            key={f.id}
            size="sm"
            variant={filter === f.id ? 'default' : 'outline'}
            onClick={() => setFilter(f.id)}
            className="gap-1"
          >
            {f.icon && <f.icon className="w-3 h-3" />}
            {f.label} ({f.count})
          </Button>
        ))}
      </div>

      <ScrollArea className="h-[calc(100vh-280px)]">
        <div className="space-y-3 pr-4">
          {filteredHistory.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <History className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>Keine Einträge gefunden</p>
            </div>
          ) : (
            filteredHistory.map((item) => (
              <Card key={item.id} className="group">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm line-clamp-3">
                        {item.polished || item.transcript}
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        {new Date(item.timestamp).toLocaleString('de-DE')}
                        <span className="mx-1">•</span>
                        {item.wordCount} Wörter
                        {item.polishUsed && (
                          <>
                            <span className="mx-1">•</span>
                            <Zap className="w-3 h-3 text-primary" />
                            Polished
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => onToggleFavorite(item.id)}
                      >
                        <Star className={cn('w-4 h-4', item.favorite && 'fill-primary text-primary')} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => onCopy(item)}
                      >
                        {copied === item.id ? (
                          <Check className="w-4 h-4 text-primary" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive"
                        onClick={() => onDelete(item.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// Stats View with Details
function StatsView({ stats, history, settings }: { stats: Stats | null; history: HistoryItem[]; settings: SettingsType | null }) {
  if (!stats) return null;

  // Calculate polish stats from history
  const polishedCount = history.filter(h => h.polishUsed).length;
  const polishPercentage = history.length > 0 ? Math.round((polishedCount / history.length) * 100) : 0;
  
  // Calculate filler words removed
  const totalFillers = history.reduce((sum, h) => sum + (h.delta?.fillersRemoved || 0), 0);
  const avgFillers = history.length > 0 ? Math.round(totalFillers / history.length) : 0;

  // Calculate text reduction
  const wordsBefore = history.reduce((sum, h) => sum + (h.delta?.wordsBefore || h.wordCount), 0);
  const wordsAfter = history.reduce((sum, h) => sum + (h.delta?.wordsAfter || h.wordCount), 0);
  const reductionPct = wordsBefore > 0 ? Math.round(((wordsBefore - wordsAfter) / wordsBefore) * 100) : 0;

  const today = new Date().toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="space-y-6">
      {/* Main Stats */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary" />
              Übersicht
            </CardTitle>
            <Badge variant="secondary" className="text-xs">Letzte 90 Tage</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
              <div className="flex items-center gap-2 mb-2">
                <Mic className="w-4 h-4 text-primary" />
              </div>
              <p className="text-2xl font-bold">{stats.sessionsCount.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Transkriptionen</p>
            </div>
            <div className="p-4 rounded-lg bg-muted">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-bold">{stats.wordsTotal.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Wörter transkribiert</p>
            </div>
            <div className="p-4 rounded-lg bg-muted">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-bold">{stats.minutesTotal}<span className="text-sm font-normal ml-1">min</span></p>
              <p className="text-xs text-muted-foreground">Aufnahmezeit</p>
            </div>
            <div className="p-4 rounded-lg bg-muted">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-bold">{stats.sessionsCount > 0 ? Math.round(stats.wordsTotal / stats.sessionsCount) : 0}</p>
              <p className="text-xs text-muted-foreground">Wörter pro Session</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Time-based Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            Aktivität nach Zeitraum
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 rounded-lg border">
              <div className="flex items-center justify-between mb-3 pb-2 border-b">
                <span className="font-medium text-sm">Heute</span>
                <span className="text-xs text-muted-foreground">{today}</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">Wörter</span>
                  <span className="font-semibold">{stats.wordsToday.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">Sessions</span>
                  <span className="font-semibold">{stats.sessionsToday}</span>
                </div>
              </div>
            </div>
            <div className="p-4 rounded-lg border">
              <div className="flex items-center justify-between mb-3 pb-2 border-b">
                <span className="font-medium text-sm">Diese Woche</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">Wörter</span>
                  <span className="font-semibold">{stats.wordsWeek.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">Sessions</span>
                  <span className="font-semibold">{stats.sessionsWeek}</span>
                </div>
              </div>
            </div>
            <div className="p-4 rounded-lg bg-muted/50 border">
              <div className="flex items-center justify-between mb-3 pb-2 border-b">
                <span className="font-medium text-sm">Gesamt</span>
                <span className="text-xs text-muted-foreground">90 Tage</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">Wörter</span>
                  <span className="font-semibold text-primary">{stats.wordsTotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">Sessions</span>
                  <span className="font-semibold text-primary">{stats.sessionsCount}</span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Polish Analysis */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              Polish-Analyse
            </CardTitle>
            <Badge variant={settings?.enablePolish ? 'default' : 'secondary'}>
              {settings?.enablePolish ? 'Aktiv' : 'Inaktiv'}
            </Badge>
          </div>
          <CardDescription>
            Zeigt wie die KI-Verbesserung deine Transkriptionen optimiert hat.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg border">
              <div className="flex items-center gap-1 mb-2 text-xs text-muted-foreground">
                <Trash2 className="w-3 h-3 text-primary" />
                Füllwörter entfernt
              </div>
              <p className="text-2xl font-bold text-primary">{avgFillers}</p>
              <p className="text-xs text-muted-foreground mt-1">Durchschnitt pro Session</p>
            </div>
            <div className="p-4 rounded-lg border">
              <div className="flex items-center gap-1 mb-2 text-xs text-muted-foreground">
                <Zap className="w-3 h-3 text-primary" />
                Textreduktion
              </div>
              <p className="text-2xl font-bold text-primary">{reductionPct}%</p>
              <p className="text-xs text-muted-foreground mt-1">Kürzerer, prägnanter Text</p>
              <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full" style={{ width: `${Math.min(reductionPct * 2, 100)}%` }} />
              </div>
            </div>
            <div className="p-4 rounded-lg border">
              <div className="flex items-center gap-1 mb-2 text-xs text-muted-foreground">
                <Check className="w-3 h-3 text-primary" />
                Polish genutzt
              </div>
              <p className="text-2xl font-bold text-primary">{polishPercentage}%</p>
              <p className="text-xs text-muted-foreground mt-1">
                {polishedCount} von {history.length} Sessions
              </p>
            </div>
            <div className="p-4 rounded-lg border">
              <div className="flex items-center gap-1 mb-2 text-xs text-muted-foreground">
                <Check className="w-3 h-3 text-green-500" />
                Erfolgsquote
              </div>
              <p className="text-2xl font-bold text-green-500">
                {stats.sessionsCount > 0 ? Math.round(((stats.sessionsCount - stats.errorsCount) / stats.sessionsCount) * 100) : 100}%
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {stats.sessionsCount - stats.errorsCount} erfolgreich, {stats.errorsCount} Fehler
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Generate REALISTIC example based on ALL agent settings
function generateExamplePrompt(data: Partial<CustomAgent> & { description?: string }): string {
  const name = (data.name || '').toLowerCase();
  const desc = (data.description || '').toLowerCase();
  const combined = name + ' ' + desc;
  const { tone, format, length, creativity, fillerWords, isPromptGenerator, outputLang } = data;
  
  // Detect agent type from name/description - EXPANDED categories
  const categories = {
    maerchen: /märchen|erzähler|story|geschicht|kinder|fantasy/.test(combined),
    email: /mail|email|korrespondenz|brief|anschreiben/.test(combined),
    social: /social|twitter|linkedin|instagram|facebook|post|influencer|content/.test(combined),
    code: /code|coding|tech|programm|entwickl|software|api|debug/.test(combined),
    prompt: isPromptGenerator || /prompt|bild|midjourney|dall|stable.*diffusion|ai.*art|image.*generat/.test(combined),
    // NEW categories
    medical: /medizin|arzt|befund|diagnose|patient|krank|gesund|therapie|symptom/.test(combined),
    legal: /recht|jura|anwalt|vertrag|gesetz|klausel|paragra|jurist/.test(combined),
    marketing: /marketing|werbung|kampagne|branding|slogan|zielgruppe|conversion/.test(combined),
    sales: /verkauf|sales|pitch|angebot|kunde|deal|verhandl/.test(combined),
    recipe: /rezept|koch|backen|zutaten|gericht|küche|essen/.test(combined),
    translate: /übersetz|translat|sprache|dolmetsch/.test(combined),
    summary: /zusammenfass|summary|tldr|kernpunkt|essenz|abstract/.test(combined),
    academic: /wissenschaft|akadem|studie|forschung|paper|these|zitat/.test(combined),
    hr: /bewerbung|lebenslauf|cv|personal|mitarbeiter|job|stelle|hr/.test(combined),
    support: /support|kundenservice|ticket|anfrage|problem|hilfe|faq/.test(combined),
    creative: /kreativ|idee|brainstorm|innovation|konzept/.test(combined),
    news: /news|artikel|bericht|journal|presse|nachrichten/.test(combined),
  };
  
  // Find matched category or use 'generic'
  const matchedCategory = Object.entries(categories).find(([_, matches]) => matches)?.[0] || 'generic';
  
  // Raw inputs with filler words for each category
  const rawInputs: Record<string, string> = {
    maerchen: 'also ähm ein kleines mädchen findet quasi so einen sprechenden frosch im garten und so',
    email: 'also ähm ich muss meinem chef quasi wegen der projektverzögerung schreiben halt',
    social: 'also wir launchen halt nächste woche quasi unser neues produkt ähm ja',
    code: 'ähm also was macht diese funktion hier eigentlich so mit dem async fetch data',
    prompt: 'ähm also ich hätte gerne so ein bild von einem magischen wald bei sonnenuntergang',
    medical: 'also ähm der patient hat quasi so kopfschmerzen und halt auch schwindel seit drei tagen oder so',
    legal: 'ähm also der vertrag hat quasi so eine klausel die halt irgendwie problematisch ist und so',
    marketing: 'also wir brauchen ähm quasi so eine kampagne die halt unsere zielgruppe anspricht oder so',
    sales: 'ähm also der kunde will quasi wissen warum unser produkt halt besser ist als die konkurrenz so',
    recipe: 'also ähm ich hab quasi so kartoffeln und halt zwiebeln und fleisch da was kann ich so kochen',
    translate: 'also ähm kannst du das quasi mal ins englische übersetzen halt der text ist wichtig',
    summary: 'ähm also das hier ist quasi so ein langer text und ich brauch halt die kernpunkte daraus',
    academic: 'also ähm die studie zeigt quasi dass halt die hypothese stimmt oder so im grunde',
    hr: 'ähm also ich bewerbe mich quasi für die stelle als halt projektmanager bei ihrer firma so',
    support: 'also ähm mein gerät funktioniert quasi nicht mehr richtig es halt startet nicht oder so',
    creative: 'also wir brauchen ähm quasi so ideen für halt ein neues produkt das innovativ ist oder so',
    news: 'ähm also gestern gab es quasi so einen vorfall im rathaus halt da wurde was beschlossen',
    generic: 'also ähm ich möchte das quasi so umformulieren dass es halt besser klingt oder so',
  };
  
  // Generate outputs based on category AND settings
  const generateOutput = (): string => {
    const c = creativity || 20;
    const isShort = length === 'short';
    const isBullets = format === 'bullets' || format === 'short';
    const isCreative = c > 50;
    const isFormal = tone === 'professional' || tone === 'formal';
    const isCasual = tone === 'casual' || tone === 'engaging';

    switch (matchedCategory) {
      case 'prompt':
        if (c > 60) {
          return `*enchanted forest at golden hour, magical glowing particles, ancient twisted trees with bioluminescent moss, ethereal volumetric fog, rays of amber sunlight piercing through dense canopy, mystical atmosphere, hyperdetailed foliage, dewdrops on leaves, 8k resolution, cinematic composition, epic scale --ar 16:9 --v 6 --style raw --chaos 30*`;
        } else if (c > 30) {
          return `*enchanted forest at golden hour, magical particles in air, old trees with glowing moss, soft fog, sunlight rays through trees, fantasy mood, detailed, 4k --ar 16:9 --v 6*`;
        }
        return `*forest at sunset, trees, fog, sunlight, nature photography --ar 16:9*`;

      case 'maerchen':
        if (isBullets) {
          return isShort 
            ? `Ein Mädchen findet einen verzauberten Frosch, der eigentlich ein Prinz ist.`
            : `• Ein kleines Mädchen entdeckt einen Frosch im Garten\n• Der Frosch kann sprechen – er ist ein verwunschener Prinz\n• Nur ein mutiges Kind kann den Zauber brechen`;
        }
        return isCreative
          ? `Es war einmal, in einem verwunschenen Garten voller Wunder, da lebte ein kleines Mädchen namens Lina. Eines Morgens, als der Tau noch auf den Blüten glitzerte, entdeckte sie einen Frosch von der Farbe des Smaragds.\n\n"Guten Tag, kleine Träumerin", sprach der Frosch mit samtener Stimme.`
          : `Es war einmal ein kleines Mädchen, das im Garten einen Frosch fand. Der Frosch konnte sprechen und erzählte, dass er ein verwunschener Prinz sei.`;

      case 'email':
        if (isFormal) {
          return isShort
            ? `Betreff: Projektupdate\n\nSehr geehrter Herr [Name], aufgrund technischer Herausforderungen verschiebt sich der Zeitplan um eine Woche. MfG`
            : `Betreff: Projektstatusupdate\n\nSehr geehrter Herr [Name],\n\nich möchte Sie über den aktuellen Stand des Projekts informieren.\n\nAufgrund unvorhergesehener technischer Herausforderungen wird sich der geplante Zeitrahmen um voraussichtlich eine Woche verschieben.\n\nMit freundlichen Grüßen`;
        } else if (isCasual) {
          return `Hey!\n\nKurzes Update zum Projekt – wir brauchen noch etwa eine Woche mehr. Die Technik macht uns gerade etwas Schwierigkeiten, aber wir sind dran!\n\nMeld dich, wenn du Fragen hast.`;
        }
        return `Betreff: Projektverzögerung\n\nHallo,\n\ndas Projekt verzögert sich um ca. eine Woche wegen technischer Probleme.\n\nGruß`;

      case 'social':
        return isCreative
          ? `🚀 BREAKING: Nächste Woche wird EPISCH!\n\nNach Monaten Blut, Schweiß und viel zu viel Kaffee ☕ können wir es endlich verraten...\n\nUnser neues Produkt kommt! 🎉\n\nSeid ihr ready? 👀\n\n#LaunchDay #Innovation #ComingSoon`
          : `🚀 Nächste Woche ist Launch Day!\n\nWir können es kaum erwarten, euch unser neues Produkt zu zeigen.\n\nStay tuned! 👀\n\n#Launch #ComingSoon`;

      case 'code':
        return isBullets
          ? `\`fetchData\` – Asynchrone API-Funktion:\n• Ruft Daten von einer API ab\n• Wartet auf Response (await)\n• Parsed JSON und gibt Daten zurück\n• Fehlerbehandlung via try/catch`
          : `Die \`fetchData\` Funktion ist eine asynchrone Methode, die Daten von einer API abruft. Sie verwendet \`await\`, um auf die Response zu warten, parsed dann die JSON-Daten und gibt sie zurück.`;

      case 'medical':
        if (isBullets) {
          return `**Symptome:**\n• Kopfschmerzen (seit 3 Tagen)\n• Schwindel\n\n**Empfehlung:** Neurologische Abklärung angeraten`;
        }
        return isFormal
          ? `Der Patient präsentiert sich mit einer dreitägigen Anamnese von Cephalgie und Vertigo. Eine weiterführende neurologische Diagnostik wird empfohlen.`
          : `Patient hat seit drei Tagen Kopfschmerzen und Schwindel. Sollte neurologisch abgeklärt werden.`;

      case 'legal':
        if (isBullets) {
          return `**Vertragsanalyse:**\n• Problematische Klausel identifiziert (§ 4.2)\n• Haftungsrisiko: mittel bis hoch\n• Empfehlung: Nachverhandlung`;
        }
        return isFormal
          ? `Die in § 4.2 des vorliegenden Vertrages enthaltene Klausel weist erhebliche Haftungsrisiken auf. Es wird dringend empfohlen, diese Passage vor Vertragsunterzeichnung nachzuverhandeln.`
          : `Die Klausel in § 4.2 ist problematisch und birgt Haftungsrisiken. Hier sollte nachverhandelt werden.`;

      case 'marketing':
        if (isBullets) {
          return `**Kampagnen-Konzept:**\n• Zielgruppe: 25-40, urban, techaffin\n• Kernbotschaft: Innovation trifft Alltag\n• Kanäle: Instagram, LinkedIn, Podcast-Ads`;
        }
        return isCreative
          ? `Die Kampagne setzt auf emotionales Storytelling: "Innovation, die deinen Alltag verändert." Wir erreichen unsere Zielgruppe dort, wo sie lebt – auf Instagram mit visuellen Stories, auf LinkedIn mit Thought Leadership, und in Podcasts mit authentischen Gesprächen.`
          : `Kampagnenvorschlag: Fokus auf die Zielgruppe 25-40 Jahre, urban und technikaffin. Kernbotschaft: Alltagstaugliche Innovation. Primäre Kanäle: Social Media und Podcast-Werbung.`;

      case 'sales':
        return isFormal
          ? `Unser Produkt bietet gegenüber dem Wettbewerb drei entscheidende Vorteile: höhere Effizienz, geringere Gesamtbetriebskosten und erstklassigen Support. Gerne erläutere ich diese Punkte im Detail.`
          : `Was uns von der Konkurrenz abhebt? Ganz einfach: Wir sind effizienter, günstiger im Betrieb und unser Support ist der beste am Markt. Lassen Sie mich das an einem Beispiel zeigen...`;

      case 'recipe':
        if (isBullets) {
          return `**Bratkartoffeln mit Zwiebeln & Fleisch**\n\n• 500g Kartoffeln schälen, in Scheiben\n• 2 Zwiebeln würfeln\n• 300g Fleisch anbraten\n• Alles zusammen goldbraun braten\n• Mit Salz, Pfeffer würzen`;
        }
        return `Aus Kartoffeln, Zwiebeln und Fleisch lässt sich ein köstliches Pfannengericht zaubern: Die Kartoffeln in Scheiben schneiden und knusprig anbraten, das gewürfelte Fleisch hinzufügen, zum Schluss die Zwiebeln für extra Aroma.`;

      case 'translate':
        return `**Übersetzung (DE → EN):**\n\nOriginal: "Der Text ist wichtig."\nTranslation: "The text is important."`;

      case 'summary':
        if (isBullets) {
          return `**Kernpunkte:**\n• Hauptaussage: [Zentrale These]\n• Wichtige Details: [Relevante Fakten]\n• Fazit: [Schlussfolgerung]`;
        }
        return isShort
          ? `Kernaussage: [Zusammenfassung in einem Satz]`
          : `Der Text behandelt [Hauptthema]. Die wichtigsten Punkte sind: [Aufzählung]. Das Fazit lautet: [Schlussfolgerung].`;

      case 'academic':
        return isFormal
          ? `Die vorliegende Studie bestätigt die aufgestellte Hypothese. Die Ergebnisse zeigen eine signifikante Korrelation (p < 0.05) zwischen den untersuchten Variablen.`
          : `Die Studie bestätigt die Hypothese. Es gibt einen klaren Zusammenhang zwischen den untersuchten Faktoren.`;

      case 'hr':
        if (isBullets) {
          return `**Bewerbung: Projektmanager/in**\n\n• 5+ Jahre Erfahrung im Projektmanagement\n• Zertifiziert (PMP/PRINCE2)\n• Expertise in agilen Methoden\n• Führungserfahrung: 10+ Teammitglieder`;
        }
        return isFormal
          ? `Sehr geehrte Damen und Herren,\n\nmit großem Interesse bewerbe ich mich auf die ausgeschriebene Position als Projektmanager. Meine mehrjährige Erfahrung in der Leitung komplexer Projekte qualifiziert mich hervorragend für diese Aufgabe.\n\nMit freundlichen Grüßen`
          : `Ich bewerbe mich für die Stelle als Projektmanager. Mit über 5 Jahren Erfahrung bringe ich genau das mit, was Sie suchen.`;

      case 'support':
        if (isBullets) {
          return `**Problembeschreibung:**\n• Gerät startet nicht\n• LED blinkt rot\n\n**Lösungsvorschlag:**\n1. Netzkabel prüfen\n2. Reset-Taste 10 Sek. halten\n3. Bei Fortsetzung: Support kontaktieren`;
        }
        return isFormal
          ? `Vielen Dank für Ihre Anfrage. Das beschriebene Startproblem kann durch einen Reset behoben werden. Bitte halten Sie die Reset-Taste 10 Sekunden gedrückt. Sollte das Problem bestehen bleiben, wenden Sie sich bitte erneut an uns.`
          : `Hey, das klingt nach einem bekannten Problem! Versuch mal, die Reset-Taste 10 Sekunden zu drücken. Das hilft in den meisten Fällen. Meld dich, wenn's nicht klappt!`;

      case 'creative':
        if (isBullets) {
          return `**Brainstorming – Neue Produktideen:**\n\n💡 Idee 1: [Konzept A]\n💡 Idee 2: [Konzept B]\n💡 Idee 3: [Konzept C]\n\n⭐ Top-Favorit: Idee 2 – höchstes Innovationspotential`;
        }
        return isCreative
          ? `Was wäre, wenn wir das Problem von einer völlig neuen Seite betrachten? Stell dir vor: Ein Produkt, das nicht nur funktional ist, sondern eine Geschichte erzählt. Etwas, das Menschen nicht nur nutzen, sondern lieben.`
          : `Hier sind drei innovative Produktideen, die auf Markttrends und Nutzerbedürfnissen basieren. Favorit: Konzept B wegen des hohen Innovationspotentials.`;

      case 'news':
        return isFormal
          ? `In der gestrigen Ratssitzung wurde ein weitreichender Beschluss gefasst. Die Entscheidung betrifft [Thema] und wird voraussichtlich ab [Datum] in Kraft treten.`
          : `Gestern im Rathaus: Es wurde beschlossen, dass [Thema]. Das tritt ab [Datum] in Kraft.`;

      // GENERIC FALLBACK - now much more dynamic!
      default:
        // Use the description to make it contextual
        const contextHint = desc ? `im Bereich "${data.description?.slice(0, 30)}..."` : '';
        
        if (isBullets) {
          return isShort
            ? `• Kernaussage: [Hauptpunkt]\n• Fazit: [Schluss]`
            : `• Kernpunkt 1: [Hauptaussage ${contextHint}]\n• Kernpunkt 2: [Relevante Details]\n• Kernpunkt 3: [Zusammenfassung]\n• Nächste Schritte: [Empfehlung]`;
        }
        
        if (isFormal) {
          return isShort
            ? `Die Kernaussage ${contextHint} lautet: [Präzise Formulierung].`
            : `Zusammenfassend lässt sich ${contextHint} Folgendes feststellen:\n\nDie Hauptaussage betrifft [Thema]. Die relevanten Aspekte sind [Details]. Daraus ergibt sich [Schlussfolgerung].`;
        }
        
        if (isCasual) {
          return isShort
            ? `Kurz gesagt ${contextHint}: [Kernpunkt]. Easy!`
            : `Hey! ${contextHint ? `Wenn's um ${contextHint} geht: ` : ''}Das ist eigentlich ganz simpel. Im Grunde geht's um [Hauptpunkt]. Der wichtigste Takeaway: [Fazit].`;
        }
        
        // Neutral default
        if (isCreative) {
          return isShort
            ? `${contextHint ? `[${data.description?.slice(0, 20)}...]: ` : ''}[Kreativ umformulierter Inhalt mit Stil und Flair]`
            : `Der Text wurde ${contextHint} optimiert und ansprechend umformuliert:\n\n[Hier steht der verbesserte, flüssig lesbare Text mit klarer Struktur und ansprechendem Stil.]`;
        }
        
        return isShort
          ? `[Präzise Kernaussage ${contextHint}]`
          : `${contextHint ? `Optimiert ${contextHint}:\n\n` : ''}[Hier steht der bereinigte, klar strukturierte Text. Füllwörter wurden entfernt, die Aussage präzisiert.]`;
    }
  };

  const rawInput = rawInputs[matchedCategory] || rawInputs.generic;
  const output = generateOutput();

  // Show filler word removal if enabled
  const fillerNote = fillerWords !== false ? `\n\n✓ Füllwörter entfernt: "also", "ähm", "quasi", "halt", "so"` : '';
  
  // Show language conversion if set
  const langNote = outputLang && outputLang !== 'same' ? `\n✓ Übersetzt nach: ${outputLang === 'en' ? 'Englisch' : 'Deutsch'}` : '';

  return `**Rohe Eingabe:**\n"${rawInput}"\n\n**Polished Ausgabe:**\n${output}${fillerNote}${langNote}`;
}

// Agents View with Wizard
function AgentsView({
  profiles,
  customAgents,
  activeProfile,
  platform,
  onAgentSwitch,
  onDeleteAgent,
  onCreateAgent,
  onUpdateProfile,
  onUpdateAgentHotkey,
}: {
  profiles: Record<string, Profile>;
  customAgents: CustomAgent[];
  activeProfile: string;
  platform: { isMac: boolean; isWin: boolean } | null;
  onAgentSwitch: (id: string) => void;
  onDeleteAgent: (id: string) => void;
  onCreateAgent: (agent: Partial<CustomAgent>) => void;
  onUpdateProfile: (id: string, updates: Partial<Profile>) => void;
  onUpdateAgentHotkey: (id: string, hotkey: string) => void;
}) {
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState<Partial<CustomAgent> & { description?: string }>({
    name: '',
    description: '',
    icon: 'star',
    color: '#7ED957',
    tone: 'neutral',
    format: 'paragraphs',
    length: 'medium',
    creativity: 20,
    outputLang: 'same',
    fillerWords: true,
    hotkey: '',
  });
  const [selectedConfigAgent, setSelectedConfigAgent] = useState<string | null>(null);
  const [hotkeyInput, setHotkeyInput] = useState('');
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
  const [wizardHotkeyRecording, setWizardHotkeyRecording] = useState(false);

  const standardAgents = Object.entries(profiles).map(([id, profile], index) => ({
    id,
    name: profile.name,
    icon: id === 'coding' ? '💻' : id === 'meeting' ? '📝' : '🎤',
    color: id === 'coding' ? '#3B82F6' : id === 'meeting' ? '#F7D154' : '#7ED957',
    profile,
  }));

  const handleCreateAgent = () => {
    if (!wizardData.name) return;
    onCreateAgent(wizardData);
    setShowWizard(false);
    setWizardStep(1);
    setWizardData({
      name: '',
      description: '',
      icon: 'star',
      color: '#7ED957',
      tone: 'neutral',
      format: 'paragraphs',
      length: 'medium',
      creativity: 20,
      outputLang: 'same',
      fillerWords: true,
      hotkey: '',
    });
  };

  const handleTemplateSelect = (templateId: string) => {
    const templates: Record<string, Partial<CustomAgent> & { description?: string }> = {
      'image-prompt': {
        name: 'Bild-Prompt',
        description: 'Wandelt Beschreibungen in detaillierte Bild-Prompts für KI-Generatoren um',
        icon: 'palette',
        color: '#8B5CF6',
        isPromptGenerator: true,
        format: 'structured',
        creativity: 80,
      },
      'social-media': {
        name: 'Social Media',
        description: 'Erstellt knackige Posts für LinkedIn, Twitter und Instagram',
        icon: 'star',
        color: '#EC4899',
        tone: 'engaging',
        format: 'short',
        length: 'short',
      },
      'email': {
        name: 'E-Mail Profi',
        description: 'Formuliert professionelle E-Mails und Geschäftskorrespondenz',
        icon: 'edit',
        color: '#3B82F6',
        tone: 'professional',
        format: 'paragraphs',
      },
      'custom': {
        name: '',
        description: '',
        icon: 'star',
        color: '#7ED957',
      },
    };
    setWizardData(prev => ({ ...prev, ...templates[templateId] }));
  };

  const handleHotkeyRecord = (e: React.KeyboardEvent, isWizard = false) => {
    const recording = isWizard ? wizardHotkeyRecording : isRecordingHotkey;
    if (!recording) return;
    e.preventDefault();
    
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.metaKey) parts.push(platform?.isMac ? 'Cmd' : 'Win');
    if (e.shiftKey) parts.push('Shift');
    
    const key = e.key;
    if (!['Control', 'Alt', 'Meta', 'Shift'].includes(key)) {
      parts.push(key.toUpperCase());
      const hotkey = parts.join('+');
      if (isWizard) {
        setWizardData(prev => ({ ...prev, hotkey }));
        setWizardHotkeyRecording(false);
      } else {
        setHotkeyInput(hotkey);
        setIsRecordingHotkey(false);
      }
    }
  };

  const saveHotkey = async () => {
    if (selectedConfigAgent && hotkeyInput) {
      await onUpdateAgentHotkey(selectedConfigAgent, hotkeyInput);
      // Update local state to show the new hotkey
      if (customAgents.find(a => a.id === selectedConfigAgent)) {
        // The parent will reload
      }
      setHotkeyInput('');
    }
  };

  const currentConfigAgent = selectedConfigAgent 
    ? (profiles[selectedConfigAgent] || customAgents.find(a => a.id === selectedConfigAgent))
    : null;

  return (
    <div className="space-y-6">
      {/* Standard Agents */}
      <div>
        <h3 className="text-sm font-medium mb-3">Standard-Agenten</h3>
        <div className="grid grid-cols-3 gap-3">
          {standardAgents.map((agent) => (
            <Card
              key={agent.id}
              className={cn(
                'cursor-pointer transition-all hover:border-primary/50 relative',
                activeProfile === agent.id && 'border-primary bg-primary/5'
              )}
              onClick={() => {
                onAgentSwitch(agent.id);
                setSelectedConfigAgent(agent.id);
              }}
            >
              <CardContent className="p-4 text-center">
                <div 
                  className="w-11 h-11 rounded-lg mx-auto mb-2 flex items-center justify-center"
                  style={{ backgroundColor: activeProfile === agent.id ? agent.color : 'hsl(var(--muted))' }}
                >
                  <span className={cn('text-xl', activeProfile === agent.id && 'brightness-150')}>{agent.icon}</span>
                </div>
                <p className="font-medium text-sm">{agent.name}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Custom Agents */}
      <div>
        <h3 className="text-sm font-medium mb-3">Custom Agenten</h3>
        <div className="grid grid-cols-3 gap-3">
          {customAgents.map((agent) => (
            <Card
              key={agent.id}
              className={cn(
                'cursor-pointer transition-all hover:border-primary/50 relative group',
                activeProfile === agent.id && 'border-primary bg-primary/5'
              )}
              onClick={() => {
                onAgentSwitch(agent.id);
                setSelectedConfigAgent(agent.id);
              }}
            >
              <CardContent className="p-4 text-center">
                <Button
                  size="icon"
                  variant="destructive"
                  className="absolute top-1 left-1 h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteAgent(agent.id);
                  }}
                >
                  <X className="w-3 h-3" />
                </Button>
                {agent.hotkey && (
                  <Badge variant="outline" className="absolute top-2 right-2 text-[10px] font-mono">
                    {agent.hotkey}
                  </Badge>
                )}
                <div 
                  className="w-11 h-11 rounded-lg mx-auto mb-2 flex items-center justify-center text-white"
                  style={{ backgroundColor: agent.color || '#7ED957' }}
                >
                  {AGENT_ICONS[agent.icon || 'star'] || <Sparkles className="w-5 h-5" />}
                </div>
                <p className="font-medium text-sm">{agent.name}</p>
              </CardContent>
            </Card>
          ))}

          {/* Add New Agent Button */}
          <Card
            className="cursor-pointer transition-all border-dashed border-2 hover:border-primary"
            onClick={() => setShowWizard(true)}
          >
            <CardContent className="p-4 text-center flex flex-col items-center justify-center min-h-[120px]">
              <Plus className="w-6 h-6 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">Neuer Agent</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Agent Config Panel */}
      {selectedConfigAgent && currentConfigAgent && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {currentConfigAgent.name} konfigurieren
              </CardTitle>
              {(profiles[selectedConfigAgent]?.hotkey || (currentConfigAgent as CustomAgent).hotkey) && (
                <Badge variant="outline" className="font-mono">
                  {profiles[selectedConfigAgent]?.hotkey || (currentConfigAgent as CustomAgent).hotkey}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground mb-2 block">Sprache</Label>
                <Select
                  value={(currentConfigAgent as Profile).language || 'de'}
                  onChange={(e) => onUpdateProfile(selectedConfigAgent, { language: e.target.value })}
                >
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-2 block">Output-Sprache</Label>
                <Select defaultValue="same">
                  <option value="same">Gleich wie Input</option>
                  <option value="en">→ Englisch</option>
                  <option value="de">→ Deutsch</option>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Label>Autopaste</Label>
              <Switch
                checked={(currentConfigAgent as Profile).autopaste ?? true}
                onCheckedChange={(checked) => onUpdateProfile(selectedConfigAgent, { autopaste: checked })}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs text-muted-foreground">Kreativität</Label>
                <span className="text-xs font-medium">{(currentConfigAgent as CustomAgent).creativity || 20}%</span>
              </div>
              <Slider
                value={(currentConfigAgent as CustomAgent).creativity || 20}
                onChange={() => {}}
                min={0}
                max={100}
              />
              <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                <span>Exakt</span>
                <span>Kreativ</span>
              </div>
            </div>

            <div className="pt-2 border-t">
              <Label className="text-xs text-muted-foreground mb-2 block">Hotkey</Label>
              <div className="flex gap-2">
                <Input
                  value={hotkeyInput}
                  placeholder="Klicken und Tasten drücken"
                  readOnly
                  onKeyDown={handleHotkeyRecord}
                  onClick={() => setIsRecordingHotkey(true)}
                  onBlur={() => setIsRecordingHotkey(false)}
                  className={cn('flex-1', isRecordingHotkey && 'ring-2 ring-primary')}
                />
                <Button size="icon" variant="outline" onClick={() => setHotkeyInput('')}>
                  <X className="w-4 h-4" />
                </Button>
                <Button size="icon" onClick={saveHotkey}>
                  <Check className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                z.B. Alt+M, Ctrl+Shift+F – zum Aktivieren des Agents
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agent Wizard Modal */}
      <Dialog open={showWizard} onOpenChange={setShowWizard}>
        <DialogContent className="max-w-lg max-h-[85vh] flex flex-col" onClose={() => setShowWizard(false)}>
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Neuen Agenten erstellen</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {/* Wizard Steps */}
            <div className="flex gap-1">
              {[1, 2, 3, 4].map((step) => (
                <div
                  key={step}
                  className={cn(
                    'flex-1 flex items-center gap-2 px-3 py-2 rounded-md text-xs cursor-pointer transition-colors',
                    wizardStep === step ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                    wizardStep > step && 'bg-primary/5'
                  )}
                  onClick={() => setWizardStep(step)}
                >
                  <span className={cn(
                    'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium',
                    wizardStep === step ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/20'
                  )}>
                    {wizardStep > step ? <Check className="w-3 h-3" /> : step}
                  </span>
                  {['Basics', 'Stil', 'Output', 'Preview'][step - 1]}
                </div>
              ))}
            </div>

            {/* Step 1: Basics */}
            {wizardStep === 1 && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Schnellstart-Vorlagen</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {AGENT_TEMPLATES.map((template) => (
                      <div
                        key={template.id}
                        className={cn(
                          'p-3 rounded-lg border cursor-pointer transition-colors hover:border-primary',
                          wizardData.name === template.name && 'border-primary bg-primary/5'
                        )}
                        onClick={() => handleTemplateSelect(template.id)}
                      >
                        <div className="flex items-center gap-2">
                          {AGENT_ICONS[template.icon]}
                          <div>
                            <p className="text-sm font-medium">{template.name}</p>
                            <p className="text-xs text-muted-foreground">{template.desc}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Name</Label>
                  <Input
                    value={wizardData.name}
                    onChange={(e) => setWizardData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="z.B. Social Media Pro"
                  />
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Beschreibung</Label>
                  <Textarea
                    value={wizardData.description || ''}
                    onChange={(e) => setWizardData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="z.B. Optimiert Texte für knackige Social Media Posts mit Emojis und Hashtags"
                    className="min-h-[60px]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-2 block">Icon</Label>
                    <div className="flex gap-2 flex-wrap">
                      {Object.entries(AGENT_ICONS).map(([key, icon]) => (
                        <div
                          key={key}
                          className={cn(
                            'w-10 h-10 rounded-lg border flex items-center justify-center cursor-pointer transition-colors',
                            wizardData.icon === key ? 'border-primary bg-primary/10' : 'hover:border-primary/50'
                          )}
                          onClick={() => setWizardData(prev => ({ ...prev, icon: key }))}
                        >
                          {icon}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs text-muted-foreground mb-2 block">Farbe</Label>
                    <div className="flex gap-2 flex-wrap">
                      {AGENT_COLORS.map((color) => (
                        <div
                          key={color}
                          className={cn(
                            'w-8 h-8 rounded-full cursor-pointer transition-transform hover:scale-110',
                            wizardData.color === color && 'ring-2 ring-offset-2 ring-primary'
                          )}
                          style={{ backgroundColor: color }}
                          onClick={() => setWizardData(prev => ({ ...prev, color }))}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Step 2: Style */}
            {wizardStep === 2 && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Ton</Label>
                  <Select
                    value={wizardData.tone}
                    onChange={(e) => setWizardData(prev => ({ ...prev, tone: e.target.value }))}
                  >
                    <option value="neutral">Neutral</option>
                    <option value="professional">Professionell</option>
                    <option value="casual">Locker</option>
                    <option value="engaging">Engagierend</option>
                    <option value="formal">Formell</option>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Format</Label>
                  <Select
                    value={wizardData.format}
                    onChange={(e) => setWizardData(prev => ({ ...prev, format: e.target.value }))}
                  >
                    <option value="paragraphs">Absätze</option>
                    <option value="bullets">Stichpunkte</option>
                    <option value="structured">Strukturiert</option>
                    <option value="short">Kurz & Knapp</option>
                  </Select>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-xs text-muted-foreground">Kreativität</Label>
                    <span className="text-xs font-medium">{wizardData.creativity}%</span>
                  </div>
                  <Slider
                    value={wizardData.creativity || 20}
                    onChange={(value) => setWizardData(prev => ({ ...prev, creativity: value }))}
                    min={0}
                    max={100}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label>Füllwörter entfernen</Label>
                  <Switch
                    checked={wizardData.fillerWords ?? true}
                    onCheckedChange={(checked) => setWizardData(prev => ({ ...prev, fillerWords: checked }))}
                  />
                </div>
              </div>
            )}

            {/* Step 3: Output */}
            {wizardStep === 3 && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Länge</Label>
                  <Select
                    value={wizardData.length}
                    onChange={(e) => setWizardData(prev => ({ ...prev, length: e.target.value }))}
                  >
                    <option value="short">Kurz</option>
                    <option value="medium">Mittel</option>
                    <option value="long">Lang</option>
                    <option value="auto">Automatisch</option>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Output-Sprache</Label>
                  <Select
                    value={wizardData.outputLang}
                    onChange={(e) => setWizardData(prev => ({ ...prev, outputLang: e.target.value }))}
                  >
                    <option value="same">Gleich wie Input</option>
                    <option value="de">Deutsch</option>
                    <option value="en">Englisch</option>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Fachbereich (optional)</Label>
                  <Input
                    value={wizardData.domain || ''}
                    onChange={(e) => setWizardData(prev => ({ ...prev, domain: e.target.value }))}
                    placeholder="z.B. Marketing, Tech, Medizin"
                  />
                </div>

                <div className="pt-2 border-t">
                  <Label className="text-xs text-muted-foreground mb-2 block">Hotkey (optional)</Label>
                  <div className="flex gap-2">
                    <Input
                      value={wizardData.hotkey || ''}
                      placeholder="Klicken und Tasten drücken"
                      readOnly
                      onKeyDown={(e) => handleHotkeyRecord(e, true)}
                      onClick={() => setWizardHotkeyRecording(true)}
                      onBlur={() => setWizardHotkeyRecording(false)}
                      className={cn('flex-1', wizardHotkeyRecording && 'ring-2 ring-primary')}
                    />
                    <Button 
                      size="icon" 
                      variant="outline" 
                      type="button"
                      onClick={() => setWizardData(prev => ({ ...prev, hotkey: '' }))}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    z.B. Alt+S, Ctrl+Shift+E – zum schnellen Aktivieren
                  </p>
                </div>
              </div>
            )}

            {/* Step 4: Preview */}
            {wizardStep === 4 && (
              <div className="space-y-3">
                {/* Agent Card Preview - Compact */}
                <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg border">
                  <div 
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white flex-shrink-0"
                    style={{ backgroundColor: wizardData.color }}
                  >
                    {AGENT_ICONS[wizardData.icon || 'star']}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm">{wizardData.name || 'Neuer Agent'}</p>
                      {wizardData.hotkey && (
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {wizardData.hotkey}
                        </Badge>
                      )}
                    </div>
                    {wizardData.description && (
                      <p className="text-xs text-muted-foreground truncate">{wizardData.description}</p>
                    )}
                  </div>
                </div>

                {/* Settings Grid - Compact */}
                <div className="grid grid-cols-4 gap-1.5 text-[10px]">
                  <div className="p-1.5 bg-muted/50 rounded text-center">
                    <span className="text-muted-foreground block">Ton</span>
                    <span className="capitalize font-medium">{wizardData.tone}</span>
                  </div>
                  <div className="p-1.5 bg-muted/50 rounded text-center">
                    <span className="text-muted-foreground block">Format</span>
                    <span className="capitalize font-medium">{wizardData.format}</span>
                  </div>
                  <div className="p-1.5 bg-muted/50 rounded text-center">
                    <span className="text-muted-foreground block">Länge</span>
                    <span className="capitalize font-medium">{wizardData.length}</span>
                  </div>
                  <div className="p-1.5 bg-muted/50 rounded text-center">
                    <span className="text-muted-foreground block">Kreativ</span>
                    <span className="font-medium">{wizardData.creativity}%</span>
                  </div>
                </div>

                {/* Example Prompt Preview - Compact with scroll */}
                <div className="border rounded-lg border-primary/30 bg-primary/5">
                  <div className="px-3 py-2 border-b border-primary/20 flex items-center gap-2">
                    <Eye className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium">Beispiel-Transformation</span>
                  </div>
                  <div className="p-3 max-h-[180px] overflow-y-auto">
                    <div className="text-xs whitespace-pre-wrap font-mono leading-relaxed">
                      {generateExamplePrompt(wizardData)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-shrink-0 border-t bg-muted/30 mt-auto">
            <div className="flex justify-between w-full">
              <Button
                variant="outline"
                onClick={() => wizardStep > 1 ? setWizardStep(wizardStep - 1) : setShowWizard(false)}
              >
                {wizardStep > 1 ? 'Zurück' : 'Abbrechen'}
              </Button>
              {wizardStep < 4 ? (
                <Button onClick={() => setWizardStep(wizardStep + 1)}>
                  Weiter
                </Button>
              ) : (
                <Button onClick={handleCreateAgent} disabled={!wizardData.name}>
                  <Save className="w-4 h-4 mr-2" />
                  Agent erstellen
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Snippets View
function SnippetsView({
  snippets,
  onAddSnippet,
  onDeleteSnippet,
}: {
  snippets: Snippet[];
  onAddSnippet: (name: string, template: string) => void;
  onDeleteSnippet: (id: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('');

  const handleAdd = () => {
    if (!newName || !newTemplate) return;
    onAddSnippet(newName, newTemplate);
    setNewName('');
    setNewTemplate('');
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Add Snippet */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Snippet hinzufügen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">Name</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="z.B. Bug Report"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">
              Template (nutze {'{{text}}'} als Platzhalter)
            </Label>
            <Textarea
              value={newTemplate}
              onChange={(e) => setNewTemplate(e.target.value)}
              placeholder="## Bug Report\n\n{{text}}\n\n### Steps to Reproduce\n"
              className="min-h-[120px] font-mono text-sm"
            />
          </div>
          <Button onClick={handleAdd} disabled={!newName || !newTemplate}>
            <Plus className="w-4 h-4 mr-2" />
            Snippet speichern
          </Button>
        </CardContent>
      </Card>

      {/* Snippet List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gespeicherte Snippets</CardTitle>
        </CardHeader>
        <CardContent>
          {snippets.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              <Code className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>Keine Snippets vorhanden</p>
              <p className="text-sm">Erstelle dein erstes Snippet oben</p>
            </div>
          ) : (
            <div className="space-y-3">
              {snippets.map((snippet) => (
                <div
                  key={snippet.id}
                  className="flex items-center justify-between p-4 rounded-lg border"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{snippet.name}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {snippet.template.substring(0, 50)}...
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => onDeleteSnippet(snippet.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Settings View with Full Controls
function SettingsView({
  settings,
  platform,
  onSettingChange,
}: {
  settings: SettingsType | null;
  platform: { isMac: boolean; isWin: boolean } | null;
  onSettingChange: (key: keyof SettingsType, value: boolean | string | number) => void;
}) {
  const [groqKey, setGroqKey] = useState('');
  const [shortcutInput, setShortcutInput] = useState('');
  const [meetingHotkeyInput, setMeetingHotkeyInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingMeeting, setIsRecordingMeeting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setGroqKey(settings.groqApiKey ? '••••••••••••••••' : '');
      setShortcutInput(settings.shortcut || '');
      setMeetingHotkeyInput(settings.meetingHotkey || 'Command+Shift+X');
    }
  }, [settings]);

  const handleHotkeyRecord = (e: React.KeyboardEvent) => {
    if (!isRecording) return;
    e.preventDefault();
    
    const parts: string[] = [];
    if (e.metaKey) parts.push('Command');
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    
    const key = e.key;
    if (!['Control', 'Alt', 'Meta', 'Shift', 'Fn'].includes(key)) {
      const keyMap: Record<string, string> = {
        ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
        'ArrowLeft': 'Left', 'ArrowRight': 'Right',
      };
      parts.push(keyMap[key] || (key.length === 1 ? key.toUpperCase() : key));
      setShortcutInput(parts.join('+'));
      setIsRecording(false);
    }
  };

  const handleMeetingHotkeyRecord = (e: React.KeyboardEvent) => {
    if (!isRecordingMeeting) return;
    e.preventDefault();

    const parts: string[] = [];
    if (e.metaKey) parts.push('Command');
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    const key = e.key;
    if (!['Control', 'Alt', 'Meta', 'Shift', 'Fn'].includes(key)) {
      const keyMap: Record<string, string> = {
        ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
        'ArrowLeft': 'Left', 'ArrowRight': 'Right',
      };
      parts.push(keyMap[key] || (key.length === 1 ? key.toUpperCase() : key));
      setMeetingHotkeyInput(parts.join('+'));
      setIsRecordingMeeting(false);
    }
  };

  const handleSave = async () => {
    if (groqKey && !groqKey.includes('•')) {
      await onSettingChange('groqApiKey', groqKey);
    }
    if (shortcutInput && shortcutInput !== settings?.shortcut) {
      await onSettingChange('shortcut', shortcutInput);
    }
    if (meetingHotkeyInput && meetingHotkeyInput !== settings?.meetingHotkey) {
      await onSettingChange('meetingHotkey', meetingHotkeyInput);
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!settings) return null;

  return (
    <div className="max-w-xl space-y-6">
      {/* API Keys */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">
              Groq API Key (erforderlich)
            </Label>
            <Input
              type="password"
              value={groqKey}
              onChange={(e) => setGroqKey(e.target.value)}
              placeholder="gsk_..."
            />
          </div>
        </CardContent>
      </Card>

      {/* Options */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Allgemein</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Autopaste</Label>
              <p className="text-xs text-muted-foreground">Text automatisch einfügen</p>
            </div>
            <Switch
              checked={settings.autopaste}
              onCheckedChange={(checked) => onSettingChange('autopaste', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Polish aktivieren</Label>
              <p className="text-xs text-muted-foreground">Mit Groq Llama optimieren</p>
            </div>
            <Switch
              checked={settings.enablePolish}
              onCheckedChange={(checked) => onSettingChange('enablePolish', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Beep-Sound</Label>
              <p className="text-xs text-muted-foreground">Audio-Feedback bei Start/Stop</p>
            </div>
            <Switch
              checked={settings.beepEnabled}
              onCheckedChange={(checked) => onSettingChange('beepEnabled', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Autostart</Label>
              <p className="text-xs text-muted-foreground">Beim Login starten</p>
            </div>
            <Switch
              checked={settings.autoStart}
              onCheckedChange={(checked) => onSettingChange('autoStart', checked)}
            />
          </div>
          {platform?.isMac && (
            <div className="flex items-center justify-between">
              <div>
                <Label>Dock-Icon verstecken</Label>
                <p className="text-xs text-muted-foreground">Nur Tray-Icon anzeigen</p>
              </div>
              <Switch
                checked={settings.hideDock}
                onCheckedChange={(checked) => onSettingChange('hideDock', checked)}
              />
            </div>
          )}
          <div className="flex items-center justify-between">
            <div>
              <Label>In Zwischenablage kopieren</Label>
              <p className="text-xs text-muted-foreground">Transkript zusätzlich kopieren</p>
            </div>
            <Switch
              checked={settings.copyToClipboard}
              onCheckedChange={(checked) => onSettingChange('copyToClipboard', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Sprecher trennen (Meetings)</Label>
              <p className="text-xs text-muted-foreground">Mehrere Personen an einem Mikrofon lokal trennen (kostenlos, kein Key)</p>
            </div>
            <Switch
              checked={settings.diarizationEnabled}
              onCheckedChange={(checked) => onSettingChange('diarizationEnabled', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Sprache</Label>
              <p className="text-xs text-muted-foreground">Transkriptions-Sprache</p>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant={settings.language === 'de' ? 'default' : 'outline'} onClick={() => onSettingChange('language', 'de')}>DE</Button>
              <Button size="sm" variant={settings.language === 'en' ? 'default' : 'outline'} onClick={() => onSettingChange('language', 'en')}>EN</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Hotkey */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tastenkürzel</CardTitle>
        </CardHeader>
        <CardContent>
          <Label className="text-xs text-muted-foreground mb-2 block">Globaler Hotkey</Label>
          <Input
            value={shortcutInput === 'GLOBE' ? '🌐 Fn / Globe-Taste' : shortcutInput}
            placeholder="Klicken und Tastenkombination drücken"
            readOnly
            onKeyDown={handleHotkeyRecord}
            onClick={() => setIsRecording(true)}
            onBlur={() => setIsRecording(false)}
            className={cn(
              'font-mono',
              isRecording && 'ring-2 ring-primary'
            )}
          />
          {platform?.isMac && (
            <button
              onClick={() => {
                setShortcutInput('GLOBE');
                setIsRecording(false);
                onSettingChange('shortcut', 'GLOBE');
              }}
              className={cn(
                'mt-2 w-full flex items-center gap-2 p-2 rounded-lg border transition-colors text-sm',
                shortcutInput === 'GLOBE'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-muted text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
              )}
            >
              <span>🌐</span>
              <div className="text-left">
                <div className="font-medium text-xs">Fn / Globe-Taste verwenden</div>
                <div className="text-[10px] opacity-70">Taste unten links auf der Mac-Tastatur</div>
              </div>
            </button>
          )}
          <div className="mt-2 text-xs text-muted-foreground bg-muted/50 p-2 rounded-lg space-y-0.5">
            <div><span className="font-medium text-foreground/70">Kurz drücken</span> → Aufnahme ein/aus</div>
            <div><span className="font-medium text-foreground/70">Gedrückt halten</span> → Aufnahme solange gehalten</div>
          </div>

          <div className="mt-4">
            <Label className="text-xs text-muted-foreground mb-2 block">Meeting-Recorder Hotkey</Label>
            <Input
              value={meetingHotkeyInput}
              placeholder="Command+Shift+X"
              readOnly
              onKeyDown={handleMeetingHotkeyRecord}
              onClick={() => setIsRecordingMeeting(true)}
              onBlur={() => setIsRecordingMeeting(false)}
              className={cn('font-mono', isRecordingMeeting && 'ring-2 ring-primary')}
            />
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <Button onClick={handleSave} className="w-full" size="lg">
        {saved ? (
          <><Check className="w-4 h-4 mr-2" /> Gespeichert!</>
        ) : (
          <><Save className="w-4 h-4 mr-2" /> Einstellungen speichern</>
        )}
      </Button>
    </div>
  );
}
