import { createTranscriptFeed } from './transcript-feed';
import {
  apiBase, listBotMeetings, listDesktopMeetings, watchBotTranscript, watchDesktopTranscript,
  type BotMeeting,
} from './bot-transcript';
import type { TranscriptSegment } from './transcript-rendering';
import { watchTranslation, type TranscriptLanguage, type TranslationSnapshot } from './translation';

type Source = 'bot' | 'desktop';
type Config = Record<'apiKey' | 'deployment' | 'ingestUrl' | 'gatewayUrl' | 'dashboardUrl' | 'botGatewayUrl' | 'terminalUrl' | 'language', string>;
const $ = (id: string) => document.getElementById(id)!;
const fields = ['apiKey', 'deployment', 'ingestUrl', 'gatewayUrl', 'dashboardUrl', 'botGatewayUrl', 'terminalUrl', 'language'] as const;
const defaults: Config = {
  apiKey: '', deployment: 'desktop', ingestUrl: 'ws://127.0.0.1:9099/ingest',
  gatewayUrl: 'http://127.0.0.1:8056', dashboardUrl: 'http://127.0.0.1:13001',
  botGatewayUrl: 'http://127.0.0.1:18056', terminalUrl: 'http://127.0.0.1:13000', language: 'vi',
};
const feed = createTranscriptFeed($('feed'), $('transcriptTurns'), $('latestBtn') as HTMLButtonElement);
let config = { ...defaults };
let source: Source = 'bot';
let meetings: BotMeeting[] = [];
let selected: BotMeeting | null = null;
let segments: TranscriptSegment[] = [];
let stopWatching = () => {};
let listRequest: AbortController | null = null;
let scope = 0;
let theme: 'system' | 'light' | 'dark' = 'system';
let language: TranscriptLanguage = 'bilingual';
let translation: TranslationSnapshot | null = null;
let translationError = false;
let stopTranslation = () => {};

function renderTranslationControls(): void {
  const supported = !!selected && source === 'bot';
  const selector = $('transcriptLanguage') as HTMLSelectElement;
  selector.disabled = !supported;
  selector.value = language;
  const displayLanguage = source === 'desktop' ? 'vi' : language;
  const retrying = translation?.groups.filter(g => g.status === 'retrying').length ?? 0;
  const failed = translation?.groups.filter(g => g.status === 'failed').length ?? 0;
  const serviceMessages: Record<string, string> = {
    auth: 'API từ chối quyền truy cập · kiểm tra khóa trong Settings → Models rồi thử lại',
    configuration: 'Kiểm tra provider và model trong Settings → Models rồi thử lại',
    rate_limit: 'API đang giới hạn lượt gọi · sẽ tự thử lại',
    unavailable: 'Dịch vụ dịch chưa khả dụng · sẽ tự thử lại',
  };
  const message = translation?.service_error ? serviceMessages[translation.service_error] : undefined;
  const progress = translation ? [
    `VI → EN · ${translation.completed}/${translation.total} cụm`,
    retrying ? `${retrying} cụm chờ thử lại` : '',
    failed ? `${failed} cụm cần thử lại` : '',
    translation.groups.some(g => !g.ready) ? 'Đang gom câu…' : '',
  ].filter(Boolean).join(' · ') : 'Đang tải bản dịch…';
  ($('displayLanguage') as HTMLButtonElement).disabled = !supported;
  $('displayLanguage').textContent = { vi: 'Bản gốc', en: 'English', bilingual: 'VI + EN' }[displayLanguage];
  $('translationControls').dataset.state = translationError ? 'error' : translation?.status || 'pending';
  $('translationStatus').textContent = !selected ? '' : source === 'desktop' ? 'Dịch hiện hỗ trợ Meeting Bot.' : language === 'vi' ? ''
    : translationError ? 'Dịch chưa khả dụng · transcript tiếng Việt vẫn hoạt động'
    : message || (translation?.status === 'paused' && !retrying && !failed ? 'Dịch tạm dừng · sẽ tự thử lại'
    : progress);
  $('retryTranslation').hidden = language === 'vi' || !(translationError || translation?.status === 'paused' || retrying || failed);
}

function startTranslation(retry = false): void {
  stopTranslation(); stopTranslation = () => {};
  renderTranslationControls();
  if (!selected || source !== 'bot' || language === 'vi') return;
  const token = scope, id = selected.id;
  stopTranslation = watchTranslation(config, id, snapshot => {
    if (scope !== token || selected?.id !== id) return;
    translation = snapshot; translationError = false; renderTranscript();
  }, () => {
    if (scope !== token || selected?.id !== id) return;
    translationError = true; renderTranscript();
  }, retry, () => segments.filter(segment => segment.completed !== false && !!segment.segment_id).map(segment => segment.segment_id!));
}

$('transcriptLanguage').addEventListener('change', () => {
  language = ($('transcriptLanguage') as HTMLSelectElement).value as TranscriptLanguage;
  renderTranscript(); startTranslation();
});
$('retryTranslation').addEventListener('click', () => startTranslation(true));
$('displayLanguage').addEventListener('click', () => {
  const selector = $('transcriptLanguage') as HTMLSelectElement;
  if (selector.disabled) return;
  ($('meetingControls') as HTMLDetailsElement).open = true;
  selector.focus();
});

function currentKey(meeting: BotMeeting): string {
  return `${meeting.id}|${meeting.platform}|${meeting.nativeMeetingId}`;
}

function desktopGatewayUrl(): string {
  return config.gatewayUrl.trim() || 'http://127.0.0.1:8056';
}

function setStatus(message: string, state: 'ready' | 'loading' | 'error' = 'ready'): void {
  const status = $('connectionStatus');
  status.dataset.state = state;
  status.querySelector('span:last-child')!.textContent = message;
}

function applyTheme(): void {
  const dark = theme === 'dark' || theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  ($('logo') as HTMLImageElement).src = dark ? 'assets/tina-light.svg' : 'assets/tina-dark.svg';
  $('themeBtn').textContent = theme === 'dark' ? '☽' : theme === 'light' ? '☀' : '◐';
  $('themeBtn').title = `Theme: ${theme[0].toUpperCase()}${theme.slice(1)}`;
}

function clearTranscript(): void {
  segments = [];
  feed.reset();
  $('emptyState').hidden = false;
  $('transcriptStatus').textContent = 'Choose a meeting to view its transcript.';
  $('updatedAt').textContent = '';
}

function renderTranscript(status?: string): void {
  const hasText = segments.some(row => row.text?.trim());
  $('emptyState').hidden = hasText;
  feed.render(segments, 'Draft', source === 'bot' ? language : 'vi', translation?.groups ?? [], translationError || translation?.status === 'paused');
  renderTranslationControls();
  if (selected && !hasText) $('emptyStateText').textContent = 'Waiting for transcript text…';
  $('transcriptStatus').textContent = status || (selected ? selected.status === 'active' ? 'Live transcript' : 'Saved transcript' : 'Choose a meeting to view its transcript.');
  $('updatedAt').textContent = hasText ? `Updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
}

function renderMeetings(): void {
  const select = $('meetingSelect') as HTMLSelectElement;
  const options = meetings.map(meeting => {
    const option = document.createElement('option');
    option.value = currentKey(meeting);
    const when = Number.isFinite(meeting.startMs) ? new Date(meeting.startMs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Date unavailable';
    option.textContent = `${meeting.title} · ${meeting.platform.replace(/_/g, ' ')} · ${when}`;
    return option;
  });
  select.replaceChildren(...options);
  select.value = selected && meetings.some(row => currentKey(row) === currentKey(selected!)) ? currentKey(selected) : '';
  select.disabled = !meetings.length;
  $('meetingEmpty').hidden = meetings.length > 0;
  $('meetingEmpty').textContent = meetings.length ? '' : source === 'bot'
    ? 'No Bot meetings yet. Send a meeting from TINA Terminal, then refresh.'
    : 'No saved Desktop transcripts were found.';
  updateDestinations();
  renderTranslationControls();
}

function updateDestinations(): void {
  const terminal = $('openTerminal') as HTMLButtonElement;
  const dashboard = $('openDashboard') as HTMLButtonElement;
  terminal.disabled = !selected || source !== 'bot';
  terminal.title = source === 'desktop' ? 'Desktop archive meetings are not Bot rows in TINA Terminal.' : '';
  dashboard.disabled = !selected || source === 'bot' && !config.dashboardUrl.trim();
  dashboard.textContent = source === 'desktop' ? 'Open Desktop review ↗' : 'Open Dashboard ↗';
}

function stopCurrentWatch(clear = false): number {
  scope++;
  stopTranslation(); stopTranslation = () => {}; translation = null; translationError = false;
  stopWatching(); stopWatching = () => {};
  if (clear) clearTranscript();
  return scope;
}

function watchMeeting(meeting: BotMeeting, token: number): void {
  selected = meeting;
  startTranslation();
  updateDestinations();
  $('meetingTitle').textContent = meeting.title;
  $('meetingMeta').textContent = `${meeting.platform.replace(/_/g, ' ')} · ${meeting.status}`;
  $('emptyStateText').textContent = 'Waiting for transcript text…';
  const onUpdate = (rows: TranscriptSegment[], status: string) => {
    if (token !== scope || !selected || currentKey(selected) !== currentKey(meeting)) return;
    segments = rows;
    renderTranscript(status === 'active' ? 'Live transcript' : 'Saved transcript');
    setStatus('Connected', 'ready');
  };
  const onError = (message: string, denied: boolean) => {
    if (token !== scope) return;
    if (denied) { segments = []; clearTranscript(); }
    setStatus(denied ? 'Access unavailable' : 'Reconnecting…', denied ? 'error' : 'loading');
    $('transcriptStatus').textContent = message;
  };
  stopWatching = source === 'bot'
    ? watchBotTranscript({ botGatewayUrl: config.botGatewayUrl, apiKey: config.apiKey }, meeting, onUpdate, onError)
    : watchDesktopTranscript({ gatewayUrl: desktopGatewayUrl(), apiKey: config.apiKey }, meeting, onUpdate, onError);
}

async function refreshMeetings(preserve = true): Promise<void> {
  listRequest?.abort();
  const controller = new AbortController(); listRequest = controller;
  const token = stopCurrentWatch(false);
  const sourceAtRequest = source;
  const endpointAtRequest = source === 'bot' ? config.botGatewayUrl : desktopGatewayUrl();
  const keyAtRequest = config.apiKey;
  const oldKey = selected ? currentKey(selected) : '';
  if (!preserve) { selected = null; meetings = []; clearTranscript(); }
  $('meetingTitle').textContent = selected?.title || 'Select a meeting';
  $('meetingMeta').textContent = '';
  setStatus('Loading meetings…', 'loading');
  renderMeetings();
  try {
    const rows = source === 'bot'
      ? await listBotMeetings({ botGatewayUrl: endpointAtRequest, apiKey: keyAtRequest }, controller.signal)
      : await listDesktopMeetings({ gatewayUrl: endpointAtRequest, apiKey: keyAtRequest }, controller.signal);
    if (controller.signal.aborted || token !== scope || source !== sourceAtRequest || config.apiKey !== keyAtRequest
        || (source === 'bot' ? config.botGatewayUrl : desktopGatewayUrl()) !== endpointAtRequest) return;
    meetings = rows;
    selected = rows.find(row => currentKey(row) === oldKey) || null;
    if (!selected && rows.length) selected = rows[0];
    renderMeetings();
    if (selected) {
      ($('meetingSelect') as HTMLSelectElement).value = currentKey(selected);
      $('meetingTitle').textContent = selected.title;
      $('meetingMeta').textContent = `${selected.platform.replace(/_/g, ' ')} · ${selected.status}`;
      watchMeeting(selected, token);
    } else {
      $('meetingTitle').textContent = 'Select a meeting';
      clearTranscript();
    }
    setStatus(source === 'bot' ? 'Terminal connected' : 'Desktop archive connected', 'ready');
  } catch (error) {
    if (controller.signal.aborted || token !== scope) return;
    meetings = []; selected = null; renderMeetings(); clearTranscript();
    const message = error instanceof Error ? error.message : 'Gateway unavailable.';
    $('meetingEmpty').textContent = message;
    setStatus(message, 'error');
  }
}

function selectMeeting(): void {
  stopCurrentWatch(true);
  selected = meetings.find(row => currentKey(row) === ($('meetingSelect') as HTMLSelectElement).value) || null;
  renderMeetings();
  if (!selected) { $('meetingTitle').textContent = 'Select a meeting'; $('meetingMeta').textContent = ''; return; }
  const token = scope;
  watchMeeting(selected, token);
  setStatus('Connecting…', 'loading');
}

function safePageUrl(baseValue: string, path: string): string {
  if (!baseValue.trim()) throw new Error('Add this destination URL in Settings.');
  const url = new URL(baseValue.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTP or HTTPS destination without credentials or query parameters.');
  return new URL(path.replace(/^\/+/, ''), url.href.replace(/\/*$/, '/') ).href;
}

function openDestination(destination: 'terminal' | 'dashboard'): void {
  if (!selected) return;
  try {
    let url: string;
    if (source === 'bot' && destination === 'terminal') url = safePageUrl(config.terminalUrl, `/meetings/${selected.id}`);
    else if (source === 'bot') url = safePageUrl(config.dashboardUrl, `/meetings/${selected.id}`);
    else if (destination === 'dashboard') url = safePageUrl(apiBase(desktopGatewayUrl()), `/transcripts/${encodeURIComponent(selected.platform)}/${encodeURIComponent(selected.nativeMeetingId)}/review`);
    else return;
    void chrome.tabs.create({ url });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Unable to open this destination.', 'error');
  }
}

function showSettings(show: boolean): void {
  const settings = $('settings');
  const viewer = $('viewer');
  if (show) {
    settings.hidden = false;
    settings.inert = false;
    viewer.hidden = true;
    viewer.inert = true;
    $('backBtn').focus();
  } else {
    viewer.hidden = false;
    viewer.inert = false;
    $('gearBtn').focus();
    settings.hidden = true;
    settings.inert = true;
  }
}

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get([...fields, 'theme', 'transcriptSource']);
  for (const field of fields) {
    const value = stored[field];
    config[field] = typeof value === 'string' ? value : defaults[field];
    ($(field) as HTMLInputElement).value = config[field];
  }
  if (!['desktop', 'cloud'].includes(config.deployment)) config.deployment = 'desktop';
  ($('deployment') as HTMLSelectElement).value = config.deployment;
  source = stored.transcriptSource === 'desktop' ? 'desktop' : 'bot';
  ($('sourceSelect') as HTMLSelectElement).value = source;
  if (stored.transcriptSource !== source) void chrome.storage.local.set({ transcriptSource: source });
  theme = stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system';
  applyTheme();
  renderTranscript();
  bindSettings();
  void refreshMeetings(false);
  if (!config.apiKey) showSettings(true);
}

function bindSettings(): void {
  for (const field of fields) $(field).addEventListener('change', () => {
    config[field] = ($(field) as HTMLInputElement).value.trim();
    void chrome.storage.local.set({ [field]: config[field] });
    if (field === 'apiKey' || field === 'gatewayUrl' || field === 'botGatewayUrl' || field === 'deployment') void refreshMeetings(false);
    else setStatus('Settings saved', 'ready');
  });
  $('sourceSelect').addEventListener('change', () => {
    source = ($('sourceSelect') as HTMLSelectElement).value === 'desktop' ? 'desktop' : 'bot';
    void chrome.storage.local.set({ transcriptSource: source });
    selected = null; meetings = []; stopCurrentWatch(true);
    ($('sourceSelect') as HTMLSelectElement).value = source; $('meetingTitle').textContent = 'Select a meeting'; $('meetingMeta').textContent = '';
    void refreshMeetings(false);
  });
  $('meetingSelect').addEventListener('change', selectMeeting);
  $('refreshBtn').addEventListener('click', () => void refreshMeetings(true));
  $('openTerminal').addEventListener('click', () => openDestination('terminal'));
  $('openDashboard').addEventListener('click', () => openDestination('dashboard'));
  $('gearBtn').addEventListener('click', () => showSettings(true));
  $('backBtn').addEventListener('click', () => showSettings(false));
  $('doneBtn').addEventListener('click', () => showSettings(false));
  $('themeBtn').addEventListener('click', () => {
    theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    void chrome.storage.local.set({ theme }); applyTheme();
  });
}

void init();
