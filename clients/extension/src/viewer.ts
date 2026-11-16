import { createVoiceActivity } from './voice-activity-view';
import { createTranscriptFeed } from './transcript-feed';
import { detectMeeting, type MeetingRef } from './meeting';
import {
  botBase, listBotMeetings, watchBotTranscript, readBotVoiceSources,
  type BotMeeting,
} from './bot-transcript';
import type { TranscriptSegment } from './transcript-rendering';
import type { VoiceReply } from './voice-replies';
import { watchTranslation, type TranscriptLanguage, type TranslationSnapshot } from './translation';

type BotTarget = { platform: Exclude<MeetingRef['platform'], 'youtube'>; nativeMeetingId: string; url: string };
const BOT_PLATFORM_NAMES: Record<BotTarget['platform'], string> = {
  google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams',
};
const TERMINAL_MEETING_STATUSES = new Set(['completed', 'failed', 'stopped', 'ended', 'past']);
type Config = Record<'apiKey' | 'deployment' | 'ingestUrl' | 'botGatewayUrl' | 'terminalUrl' | 'language', string>;
const $ = (id: string) => document.getElementById(id)!;
const fields = ['apiKey', 'deployment', 'ingestUrl', 'botGatewayUrl', 'terminalUrl', 'language'] as const;
const defaults: Config = {
  apiKey: '', deployment: 'desktop', ingestUrl: 'ws://127.0.0.1:9099/ingest',
  botGatewayUrl: 'https://tinabot.duckdns.org/extension-api',
  terminalUrl: 'https://tinabot.duckdns.org',
  language: 'vi',
};
const voiceActivityView = createVoiceActivity($('voiceActivity'));
const feed = createTranscriptFeed($('feed'), $('transcriptTurns'), $('latestBtn') as HTMLButtonElement, {
  load: (id, signal) => { if (!selected) throw new Error('No Bot meeting'); return readBotVoiceSources(config, selected.id, id, signal); },
  url: (id, index) => safePageUrl(config.terminalUrl, `/meetings/${selected!.id}?voiceSource=${encodeURIComponent(id)}#voice-source-${id}-${index}`),
});
let config = { ...defaults };
let meetings: BotMeeting[] = [];
let selected: BotMeeting | null = null;
let segments: TranscriptSegment[] = [];
let replies: VoiceReply[] = [];
let stopWatching = () => {};
let listRequest: AbortController | null = null;
let scope = 0;
let theme: 'system' | 'light' | 'dark' = 'system';
let language: TranscriptLanguage = 'bilingual';
let translation: TranslationSnapshot | null = null;
let translationError = false;
let stopTranslation = () => {};
let activeMeeting: BotTarget | null = null;
let sendBotState: { key: string; phase: 'sending' | 'sent' | 'error'; message: string } | null = null;
let activeTabRead = 0;

function renderTranslationControls(): void {
  const supported = !!selected;
  const selector = $('transcriptLanguage') as HTMLSelectElement;
  selector.disabled = !supported;
  selector.value = language;
  const displayLanguage = language;
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
  $('displayLanguage').textContent = { vi: 'Tiếng Việt', en: 'English', bilingual: 'VI + EN' }[displayLanguage];
  $('translationControls').dataset.state = translationError ? 'error' : translation?.status || 'pending';
  $('translationStatus').textContent = !selected || language === 'vi' ? ''
    : translationError ? 'Dịch chưa khả dụng · transcript tiếng Việt vẫn hoạt động'
    : message || (translation?.status === 'paused' && !retrying && !failed ? 'Dịch tạm dừng · sẽ tự thử lại'
    : progress);
  $('retryTranslation').hidden = language === 'vi' || !(translationError || translation?.status === 'paused' || retrying || failed);
}

function startTranslation(retry = false): void {
  stopTranslation(); stopTranslation = () => {};
  renderTranslationControls();
  if (!selected || language === 'vi') return;
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

function botTargetKey(meeting: BotTarget): string {
  return `${meeting.platform}|${meeting.nativeMeetingId}`;
}

function failBot(key: string, message = 'Bot failed. You can send it again.'): void {
  sendBotState = { key, phase: 'error', message };
  if (activeMeeting && botTargetKey(activeMeeting) === key) renderSendBot();
}

function syncFailedBotState(): void {
  if (!activeMeeting || sendBotState?.phase === 'sending') return;
  const failed = meetings.filter(row => row.platform === activeMeeting!.platform
    && row.nativeMeetingId === activeMeeting!.nativeMeetingId).sort((a, b) => b.startMs - a.startMs)[0];
  if (failed?.status === 'failed') failBot(botTargetKey(activeMeeting));
}

function renderSendBot(): void {
  const panel = $('sendBotPanel');
  const button = $('sendBotBtn') as HTMLButtonElement;
  if (!activeMeeting) { panel.hidden = true; return; }
  panel.hidden = false;
  const key = botTargetKey(activeMeeting);
  const state = sendBotState?.key === key ? sendBotState : null;
  const platform = BOT_PLATFORM_NAMES[activeMeeting.platform];
  $('sendBotTitle').textContent = `${platform} · ${activeMeeting.nativeMeetingId}`;
  $('sendBotStatus').textContent = state?.message
    ?? (config.apiKey.trim() ? 'The bot may wait for host admission.' : 'Add your TINA API key in Settings.');
  panel.dataset.state = state?.phase ?? 'ready';
  button.disabled = !config.apiKey.trim() || state?.phase === 'sending' || state?.phase === 'sent';
  button.textContent = state?.phase === 'sending' ? 'Sending…' : state?.phase === 'sent' ? 'Bot sent' : state?.phase === 'error' ? 'Send Bot Again' : 'Send Bot';
  button.title = `Send a TINA bot to this ${platform} meeting`;
}

async function refreshActiveMeeting(): Promise<void> {
  const read = ++activeTabRead;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (read !== activeTabRead) return;
    const meetingUrl = tab?.url?.replace(/^(https?:\/\/meet\.google\.com)\/meet\//i, '$1/');
    const detected = meetingUrl ? detectMeeting(meetingUrl) : null;
    const next: BotTarget | null = !detected || detected.platform === 'youtube' || !tab?.url ? null : {
      platform: detected.platform,
      nativeMeetingId: detected.nativeMeetingId,
      url: tab.url,
    };
    if ((activeMeeting ? botTargetKey(activeMeeting) : null) !== (next ? botTargetKey(next) : null)) sendBotState = null;
    activeMeeting = next;
    syncFailedBotState();
  } catch {
    if (read !== activeTabRead) return;
    activeMeeting = null; sendBotState = null;
  }
  renderSendBot();
}

async function sendBotToActiveMeeting(): Promise<void> {
  const meeting = activeMeeting;
  if (!meeting || !config.apiKey.trim()) return;
  const key = botTargetKey(meeting);
  if (sendBotState?.key === key && sendBotState.phase !== 'error') return;
  sendBotState = { key, phase: 'sending', message: 'Sending bot request…' };
  renderSendBot();
  try {
    const response = await fetch(`${botBase(config.botGatewayUrl)}/bots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
      body: JSON.stringify({
        platform: meeting.platform,
        native_meeting_id: meeting.nativeMeetingId,
        meeting_url: meeting.platform === 'google_meet' ? `https://meet.google.com/${meeting.nativeMeetingId}` : meeting.url,
      }),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({})) as { detail?: unknown };
    if (response.status === 409) {
      sendBotState = { key, phase: 'sent', message: 'A bot is already active for this meeting.' };
    } else if (response.status === 429) {
      throw new Error('Your active bot limit is reached. Stop another bot and try again.');
    } else if (response.status === 401) {
      throw new Error('The TINA API key was rejected. Check it in Settings.');
    } else if (response.status === 403) {
      throw new Error('This API key needs the “Join meetings” (bot) scope.');
    } else if (!response.ok) {
      throw new Error(typeof body.detail === 'string' ? body.detail : `Could not send bot (${response.status}).`);
    } else {
      sendBotState = { key, phase: 'sent', message: 'Bot sent. Admit it in the meeting if prompted.' };
      setTimeout(() => {
        void refreshMeetings(true).then(() => {
          if (activeMeeting && botTargetKey(activeMeeting) === key) selectBotTranscript(meeting);
        });
      }, 1200);
    }
  } catch (error) {
    failBot(key, error instanceof Error ? error.message : 'Could not send the bot.');
  }
  if (activeMeeting && botTargetKey(activeMeeting) === key) renderSendBot();
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
  voiceActivityView.reset();
  segments = [];
  replies = [];
  feed.reset();
  $('emptyState').hidden = false;
  $('transcriptStatus').textContent = 'Choose a Bot meeting to view its transcript.';
  $('updatedAt').textContent = '';
}

function renderTranscript(status?: string): void {
  const hasText = segments.some(row => row.text?.trim()) || replies.length > 0;
  $('emptyState').hidden = hasText;
  feed.render(segments, 'Draft', language, translation?.groups ?? [], translationError || translation?.status === 'paused', replies);
  renderTranslationControls();
  if (selected && !hasText) $('emptyStateText').textContent = 'Waiting for transcript text…';
  $('transcriptStatus').textContent = status || (selected ? selected.status === 'active' ? 'Live transcript' : 'Saved transcript' : 'Choose a Bot meeting to view its transcript.');
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
  $('meetingEmpty').textContent = meetings.length ? '' : 'No Bot meetings yet. Open a supported meeting tab and use Send Bot here.';
  updateDestinations();
  renderTranslationControls();
}

function updateDestinations(): void {
  const terminal = $('openTerminal') as HTMLButtonElement;
  terminal.disabled = !selected;
  terminal.title = '';
}

function stopCurrentWatch(clear = false): number {
  scope++;
  stopTranslation(); stopTranslation = () => {}; translation = null; translationError = false;
  stopWatching(); stopWatching = () => {}; voiceActivityView.reset();
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
  const onUpdate = (rows: TranscriptSegment[], status: string, voice: VoiceReply[] = [], activity?: unknown) => {
    if (token !== scope || !selected || currentKey(selected) !== currentKey(meeting)) return;
    if (!TERMINAL_MEETING_STATUSES.has(meeting.status) && TERMINAL_MEETING_STATUSES.has(status)) {
      meetings = meetings.map(row => currentKey(row) === currentKey(meeting) ? { ...row, status } : row);
      const key = `${meeting.platform}|${meeting.nativeMeetingId}`;
      if (status === 'failed') failBot(key);
      returnToMeetingHome(status === 'failed'
        ? 'The bot failed. Select the meeting from the list to inspect its saved transcript.'
        : 'Meeting ended. Select it from the list to review the saved transcript.');
      return;
    }
    segments = rows;
    replies = voice;
    if (meeting.platform === 'google_meet') {
      voiceActivityView.update(activity, ['completed','failed','stopped','ended','past'].includes(status));
    }
    renderTranscript(status === 'active' ? 'Live transcript' : 'Saved transcript');
    setStatus('Connected', 'ready');
  };
  const onError = (message: string, denied: boolean) => {
    if (token !== scope) return;
    if (meeting.platform === 'google_meet') voiceActivityView.update(null);
    if (denied) { segments = []; clearTranscript(); }
    setStatus(denied ? 'Access unavailable' : 'Reconnecting…', denied ? 'error' : 'loading');
    $('transcriptStatus').textContent = message;
  };
  stopWatching = watchBotTranscript({ botGatewayUrl: config.botGatewayUrl, apiKey: config.apiKey }, meeting, onUpdate, onError);
}

async function refreshMeetings(preserve = true): Promise<void> {
  listRequest?.abort();
  const controller = new AbortController(); listRequest = controller;
  const token = stopCurrentWatch(false);
  const endpointAtRequest = config.botGatewayUrl;
  const keyAtRequest = config.apiKey;
  const oldKey = preserve && selected ? currentKey(selected) : '';
  if (!preserve) { selected = null; meetings = []; clearTranscript(); }
  $('meetingTitle').textContent = selected?.title || 'Select a meeting';
  $('meetingMeta').textContent = '';
  setStatus('Loading meetings…', 'loading');
  renderMeetings();
  try {
    const rows = await listBotMeetings({ botGatewayUrl: endpointAtRequest, apiKey: keyAtRequest }, controller.signal);
    if (controller.signal.aborted || token !== scope || config.apiKey !== keyAtRequest
        || config.botGatewayUrl !== endpointAtRequest) return;
    meetings = rows;
    syncFailedBotState();
    selected = rows.find(row => currentKey(row) === oldKey)
      || rows.filter(row => !TERMINAL_MEETING_STATUSES.has(row.status)).sort((a, b) => b.startMs - a.startMs)[0]
      || null;
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
    setStatus('Terminal connected', 'ready');
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
  if (!selected) { $('meetingTitle').textContent = 'Select a meeting'; $('meetingMeta').textContent = ''; $('transcriptStatus').textContent = 'Choose a Bot meeting to view its transcript.'; return; }
  const token = scope;
  watchMeeting(selected, token);
  setStatus('Connecting…', 'loading');
}

function selectBotTranscript(target: BotTarget): void {
  const meeting = meetings.filter(row => row.platform === target.platform && row.nativeMeetingId === target.nativeMeetingId)
    .sort((a, b) => b.startMs - a.startMs)[0];
  if (!meeting) return;
  if (TERMINAL_MEETING_STATUSES.has(meeting.status)) {
    if (meeting.status === 'failed') failBot(botTargetKey(target));
    returnToMeetingHome(meeting.status === 'failed'
      ? 'The bot failed. Select the meeting from the list to inspect its saved transcript.'
      : 'Meeting ended. Select it from the list to review the saved transcript.');
    return;
  }
  ($('meetingSelect') as HTMLSelectElement).value = currentKey(meeting);
  ($('meetingControls') as HTMLDetailsElement).open = true;
  selectMeeting();
}

function returnToMeetingHome(message: string): void {
  ($('meetingSelect') as HTMLSelectElement).value = '';
  ($('meetingControls') as HTMLDetailsElement).open = true;
  selectMeeting();
  $('transcriptStatus').textContent = message;
}

function safePageUrl(baseValue: string, path: string): string {
  if (!baseValue.trim()) throw new Error('Add this destination URL in Settings.');
  const url = new URL(baseValue.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTP or HTTPS destination without credentials or query parameters.');
  return new URL(path.replace(/^\/+/, ''), url.href.replace(/\/*$/, '/') ).href;
}

function openTerminal(): void {
  if (!selected) return;
  try {
    void chrome.tabs.create({ url: safePageUrl(config.terminalUrl, `/meetings/${selected.id}`) });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Unable to open Terminal.', 'error');
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
  if (stored.transcriptSource !== 'bot') void chrome.storage.local.set({ transcriptSource: 'bot' });
  theme = stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system';
  applyTheme();
  renderTranscript();
  bindSettings();
  void refreshActiveMeeting();
  void refreshMeetings(false);
  if (!config.apiKey) showSettings(true);
}

function bindSettings(): void {
  for (const field of fields) $(field).addEventListener('change', () => {
    config[field] = ($(field) as HTMLInputElement).value.trim();
    void chrome.storage.local.set({ [field]: config[field] });
    renderSendBot();
    if (field === 'apiKey' || field === 'botGatewayUrl') void refreshMeetings(false);
    else setStatus('Settings saved', 'ready');
  });
  $('meetingSelect').addEventListener('change', selectMeeting);
  $('refreshBtn').addEventListener('click', () => void refreshMeetings(true));
  $('openTerminal').addEventListener('click', openTerminal);
  $('sendBotBtn').addEventListener('click', () => void sendBotToActiveMeeting());
  chrome.tabs.onActivated.addListener(() => void refreshActiveMeeting());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) void refreshActiveMeeting();
  });
  $('gearBtn').addEventListener('click', () => showSettings(true));
  $('backBtn').addEventListener('click', () => showSettings(false));
  $('doneBtn').addEventListener('click', () => showSettings(false));
  $('themeBtn').addEventListener('click', () => {
    theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    void chrome.storage.local.set({ theme }); applyTheme();
  });
}

void init();
