import { createVoiceActivity } from './voice-activity-view';
import { createTranscriptFeed } from './transcript-feed';
import { detectMeeting, type MeetingRef } from './meeting';
import {
  botFetch, hasOwnedBotInRoom, listBotMeetings, watchBotTranscript, readBotVoiceSources,
  type BotConnection, type BotMeeting,
} from './bot-transcript';
import { ACCOUNT_KEY, DEFAULT_GATEWAY, DEFAULT_TERMINAL, sessionCommand, storedAccount } from './extension-session';
import type { TranscriptSegment } from './transcript-rendering';
import type { VoiceReply } from './voice-replies';
import { watchTranslation, type TranscriptLanguage, type TranslationSnapshot } from './translation';

type BotTarget = { platform: Exclude<MeetingRef['platform'], 'youtube'>; nativeMeetingId: string; url: string };
const BOT_PLATFORM_NAMES: Record<BotTarget['platform'], string> = {
  google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams',
};
const TERMINAL_MEETING_STATUSES = new Set(['completed', 'failed', 'stopped', 'ended', 'past']);
type Config = BotConnection & { terminalUrl: string };
const $ = (id: string) => document.getElementById(id)!;
const fields = ['botGatewayUrl', 'terminalUrl'] as const;
const defaults: Config = {
  botGatewayUrl: DEFAULT_GATEWAY,
  terminalUrl: DEFAULT_TERMINAL,
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
let sendBotState: { key: string; phase: 'sending' | 'sent' | 'retrying' | 'cancelling' | 'error'; message: string } | null = null;
let autoRetryPoll: ReturnType<typeof setTimeout> | null = null;
let activeTabRead = 0;

function renderTranslationControls(): void {
  const supported = !!selected;
  const selector = $('transcriptLanguage') as HTMLSelectElement;
  selector.disabled = !supported;
  selector.value = language;
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
  selector.disabled = !supported;
  selector.value = language;
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
  if (!activeMeeting || (sendBotState?.phase === 'sending' || sendBotState?.phase === 'cancelling')) return;
  const key = botTargetKey(activeMeeting);
  const latest = meetings.filter(row => !row.shared && row.platform === activeMeeting!.platform
    && row.nativeMeetingId === activeMeeting!.nativeMeetingId).sort((a, b) => b.startMs - a.startMs)[0];
  const retry = latest?.autoRetry;
  if (retry && (retry.state === 'scheduled' || retry.state === 'in_progress' && retry.attempt > 1)) {
    const attempt = retry.attempt + (retry.state === 'scheduled' ? 1 : 0);
    sendBotState = { key, phase: 'retrying', message: `TINA is retrying automatically (${attempt}/${retry.max_attempts}).` };
    scheduleAutoRetryPoll(key);
  } else if (retry?.state === 'succeeded') {
    sendBotState = { key, phase: 'sent', message: retry.attempt > 1
      ? 'The automatically retried bot joined the meeting.' : 'The bot joined the meeting.' };
    clearAutoRetryPoll();
  } else if (latest?.status === 'failed') {
    failBot(key, latest.joinFailureSummary || (retry?.state === 'exhausted'
      ? 'Automatic retries are exhausted. You can send the bot again.'
      : retry?.state === 'failed'
        ? 'Automatic retry failed. You can send the bot again.'
        : retry?.state === 'manual_only'
          ? 'This meeting needs a passcode. Send the bot again manually.'
        : retry?.state === 'not_retryable'
          ? 'This failure is not eligible for automatic retry. You can send the bot again.'
        : undefined));
    clearAutoRetryPoll();
  }
  if (latest && TERMINAL_MEETING_STATUSES.has(latest.status) && latest.status !== 'failed') {
    sendBotState = null;
    clearAutoRetryPoll();
  }
  renderSendBot();
}

function clearAutoRetryPoll(): void {
  if (autoRetryPoll) clearTimeout(autoRetryPoll);
  autoRetryPoll = null;
}

function scheduleAutoRetryPoll(key: string): void {
  if (autoRetryPoll) return;
  autoRetryPoll = setTimeout(async () => {
    autoRetryPoll = null;
    if (!activeMeeting || botTargetKey(activeMeeting) !== key || sendBotState?.phase !== 'retrying') return;
    try {
      const current = sendBotState, connection = { ...config };
      const rows = await listBotMeetings(connection);
      if (sendBotState !== current || config.botGatewayUrl !== connection.botGatewayUrl || config.account?.key !== connection.account?.key
          || !activeMeeting || botTargetKey(activeMeeting) !== key) return;
      meetings = rows;
      syncFailedBotState();
      renderMeetings();
    } catch { /* the next poll can recover a transient gateway error */ }
    if (sendBotState?.key === key && sendBotState.phase === 'retrying') scheduleAutoRetryPoll(key);
  }, 5000);
}

function renderSendBot(): void {
  const panel = $('sendBotPanel');
  const button = $('sendBotBtn') as HTMLButtonElement;
  if (!activeMeeting) { panel.hidden = true; return; }
  panel.hidden = false;
  const key = botTargetKey(activeMeeting);
  const state = sendBotState?.key === key ? sendBotState : null;
  const platform = BOT_PLATFORM_NAMES[activeMeeting.platform];
  const selectedIsActive = selected?.platform === activeMeeting.platform
    && selected.nativeMeetingId === activeMeeting.nativeMeetingId;
  const title = $('sendBotTitle');
  title.textContent = selectedIsActive ? '' : `Active tab: ${platform}, ${activeMeeting.nativeMeetingId}`;
  title.hidden = selectedIsActive;
  $('sendBotStatus').textContent = state?.message
    ?? (config.account ? 'The bot may wait for host admission.' : 'Sign in with Google in Settings.');
  panel.dataset.state = state?.phase ?? 'ready';
  button.hidden = state?.phase === 'sent';
  button.disabled = !config.account || state?.phase === 'sending' || state?.phase === 'cancelling' || state?.phase === 'sent';
  button.setAttribute('aria-busy', state?.phase === 'sending' || state?.phase === 'cancelling' ? 'true' : 'false');
  button.textContent = state?.phase === 'sending' ? 'Sending…' : state?.phase === 'cancelling' ? 'Cancelling…' : state?.phase === 'retrying' ? 'Cancel retry' : state?.phase === 'sent' ? 'Bot sent' : state?.phase === 'error' ? 'Send Bot Again' : 'Send Bot';
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
    if ((activeMeeting ? botTargetKey(activeMeeting) : null) !== (next ? botTargetKey(next) : null)) {
      sendBotState = null;
      clearAutoRetryPoll();
    }
    activeMeeting = next;
    syncFailedBotState();
  } catch {
    if (read !== activeTabRead) return;
    activeMeeting = null; sendBotState = null;
  }
  renderSendBot();
}

async function cancelBotRetry(): Promise<void> {
  const meeting = activeMeeting;
  if (!meeting) return;
  const key = botTargetKey(meeting);
  const session = config.account?.key;
  sendBotState = { key, phase: 'cancelling', message: 'Cancelling automatic retry…' };
  clearAutoRetryPoll();
  renderSendBot();
  try {
    const response = await botFetch(config, `/bots/${meeting.platform}/${encodeURIComponent(meeting.nativeMeetingId)}`, {
      method: 'DELETE', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Could not confirm cancellation. Refresh the meeting status and try again.');
    if (session !== config.account?.key || !activeMeeting || botTargetKey(activeMeeting) !== key) return;
    sendBotState = { key, phase: 'error', message: 'Automatic retry cancelled.' };
  } catch (error) {
    if (session !== config.account?.key || !activeMeeting || botTargetKey(activeMeeting) !== key) return;
    sendBotState = { key, phase: 'retrying', message: error instanceof Error ? error.message : 'Could not cancel retry.' };
    scheduleAutoRetryPoll(key);
  }
  renderSendBot();
}

async function sendBotToActiveMeeting(): Promise<void> {
  const meeting = activeMeeting;
  if (!meeting || !config.account) return;
  const session = config.account.key;
  const key = botTargetKey(meeting);
  if (sendBotState?.key === key && sendBotState.phase !== 'error') return;
  const connection = { ...config };
  const request = { key, phase: 'sending' as const, message: 'Sending bot request…' };
  const isCurrent = () => session === config.account?.key && sendBotState === request;
  sendBotState = request;
  renderSendBot();
  try {
    const response = await botFetch(connection, '/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: meeting.platform,
        native_meeting_id: meeting.nativeMeetingId,
        meeting_url: meeting.platform === 'google_meet' ? `https://meet.google.com/${meeting.nativeMeetingId}` : meeting.url,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({})) as { detail?: unknown };
    if (!isCurrent()) return;
    const failure = typeof body?.detail === 'string' && body.detail.trim()
      ? body.detail : `Could not send bot (${response.status}).`;
    if (response.status === 409) {
      const confirmed = await hasOwnedBotInRoom(connection, meeting);
      if (!isCurrent()) return;
      if (!confirmed) throw new Error(failure);
      sendBotState = { key, phase: 'sent', message: 'A bot is already active for this meeting.' };
    } else if (response.status === 429) {
      throw new Error('Your active bot limit is reached. Stop another bot and try again.');
    } else if (response.status === 401) {
      throw new Error('Sign in again to send the bot.');
    } else if (response.status === 403) {
      throw new Error('This account cannot manage bots in this meeting.');
    } else if (!response.ok) {
      throw new Error(failure);
    } else {
      sendBotState = { key, phase: 'sent', message: 'Bot sent. Admit it in the meeting if prompted.' };
      setTimeout(() => {
        if (session !== config.account?.key) return;
        void refreshMeetings(true).then(() => {
          if (session === config.account?.key && activeMeeting && botTargetKey(activeMeeting) === key) selectBotTranscript(meeting);
        });
      }, 1200);
    }
  } catch (error) {
    if (!isCurrent()) return;
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
    option.textContent = `${meeting.title} — ${meeting.platform.replace(/_/g, ' ')} — ${when}`;
    return option;
  });
  select.replaceChildren(...options);
  select.value = selected && meetings.some(row => currentKey(row) === currentKey(selected!)) ? currentKey(selected) : '';
  select.disabled = !meetings.length;
  $('meetingEmpty').hidden = meetings.length > 0;
  $('meetingEmpty').textContent = meetings.length ? '' : 'No Bot meetings yet. Open a supported meeting tab and use Send Bot here.';
  updateDestinations();
  renderTranslationControls();
  renderSendBot();
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
  $('meetingMeta').textContent = `${meeting.platform.replace(/_/g, ' ')}, ${meeting.status}`;
  renderSendBot();
  $('emptyStateText').textContent = 'Waiting for transcript text…';
  const onUpdate = (rows: TranscriptSegment[], status: string, voice: VoiceReply[] = [], activity?: unknown) => {
    if (token !== scope || !selected || currentKey(selected) !== currentKey(meeting)) return;
    if (!TERMINAL_MEETING_STATUSES.has(meeting.status) && TERMINAL_MEETING_STATUSES.has(status)) {
      meetings = meetings.map(row => currentKey(row) === currentKey(meeting) ? { ...row, status } : row);
      const key = `${meeting.platform}|${meeting.nativeMeetingId}`;
      if (status === 'failed' && !meeting.shared) failBot(key);
      returnToMeetingHome(status === 'failed'
        ? 'The bot failed. Select the meeting from the list to inspect its saved transcript.'
        : 'Meeting ended. Select it from the list to review the saved transcript.');
      void refreshMeetings(true);
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
  stopWatching = watchBotTranscript({ ...config }, meeting, onUpdate, onError);
}

async function refreshMeetings(preserve = true): Promise<void> {
  listRequest?.abort();
  const controller = new AbortController(); listRequest = controller;
  const token = stopCurrentWatch(false);
  const connection = { ...config };
  const oldKey = preserve && selected ? currentKey(selected) : '';
  if (!preserve) { selected = null; meetings = []; clearTranscript(); }
  $('meetingTitle').textContent = selected?.title || 'Select a meeting';
  $('meetingMeta').textContent = '';
  setStatus('Loading meetings…', 'loading');
  renderMeetings();
  try {
    if (!connection.account) {
      $('meetingEmpty').textContent = 'Sign in with Google to view meetings.';
      setStatus('Signed out');
      return;
    }
    const rows = await listBotMeetings(connection, controller.signal);
    if (controller.signal.aborted || token !== scope || config.account?.key !== connection.account.key) return;
    meetings = rows;
    syncFailedBotState();
    selected = rows.find(row => currentKey(row) === oldKey)
      || rows.filter(row => !TERMINAL_MEETING_STATUSES.has(row.status)).sort((a, b) => b.startMs - a.startMs)[0]
      || null;
    renderMeetings();
    if (selected) {
      ($('meetingSelect') as HTMLSelectElement).value = currentKey(selected);
      $('meetingTitle').textContent = selected.title;
      $('meetingMeta').textContent = `${selected.platform.replace(/_/g, ' ')}, ${selected.status}`;
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
  ($('meetingControls') as HTMLDetailsElement).open = false;
  const token = scope;
  watchMeeting(selected, token);
  setStatus('Connecting…', 'loading');
}

function selectBotTranscript(target: BotTarget): void {
  const meeting = meetings.filter(row => !row.shared && row.platform === target.platform && row.nativeMeetingId === target.nativeMeetingId)
    .sort((a, b) => b.startMs - a.startMs)[0];
  if (!meeting) return;
  if (TERMINAL_MEETING_STATUSES.has(meeting.status)) {
    if (meeting.status === 'failed') syncFailedBotState();
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

function renderSettings(): void {
  const account = config.account;
  const email = account?.email ?? '';
  const separator = email.lastIndexOf('@');
  $('accountCard').dataset.signedIn = String(!!account);
  $('accountAvatar').textContent = Array.from(email || 'T')[0].toUpperCase();
  if (separator > 0) {
    $('accountEmail').replaceChildren(email.slice(0, separator), document.createElement('wbr'), email.slice(separator));
  } else {
    $('accountEmail').textContent = email;
  }
  $('accountEmail').hidden = !account;
  $('accountLabel').textContent = account ? 'Signed in with Google' : 'Signed out';
  const action = $('accountAction');
  action.textContent = account ? 'Sign out' : 'Sign in with Google';
  action.classList.toggle('primary', !account);
  $('connectionHint').hidden = !account;
  for (const field of fields) {
    const input = $(field) as HTMLInputElement;
    input.value = config[field];
    input.readOnly = !!account;
  }
}

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get([...fields, ACCOUNT_KEY, 'theme', 'transcriptSource']);
  config.account = storedAccount(stored[ACCOUNT_KEY]);
  for (const field of fields) {
    const value = stored[field];
    config[field] = typeof value === 'string' ? value : defaults[field];
    if (config.account && field === 'terminalUrl') config[field] = config.account.terminal;
    if (config.account && field === 'botGatewayUrl') config[field] = config.account.gateway;
  }
  if (stored.transcriptSource !== 'bot') void chrome.storage.local.set({ transcriptSource: 'bot' });
  theme = stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system';
  applyTheme();
  renderTranscript();
  renderSettings();
  bindSettings();
  void refreshActiveMeeting();
  void refreshMeetings(false);
  if (!config.account) showSettings(true);
}

function bindSettings(): void {
  for (const field of fields) $(field).addEventListener('change', () => {
    config[field] = ($(field) as HTMLInputElement).value.trim();
    void chrome.storage.local.set({ [field]: config[field] });
    renderSendBot();
    setStatus('Settings saved', 'ready');
  });
  const button = $('accountAction') as HTMLButtonElement;
  button.addEventListener('click', async () => {
    button.disabled = true;
    $('accountStatus').textContent = '';
    try {
      if (config.account) await sessionCommand({ action: 'logout', key: config.account.key });
      else await sessionCommand({ action: 'login', terminal: config.terminalUrl, gateway: config.botGatewayUrl });
    } catch (error) {
      $('accountStatus').textContent = error instanceof Error ? error.message : 'Unable to connect to TINA.';
    } finally { button.disabled = false; }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.theme) {
      const saved = changes.theme.newValue;
      theme = saved === 'light' || saved === 'dark' ? saved : 'system';
      applyTheme();
    }
    if (!changes[ACCOUNT_KEY]) return;
    config.account = storedAccount(changes[ACCOUNT_KEY].newValue);
    if (config.account) {
      config.botGatewayUrl = config.account.gateway;
      config.terminalUrl = config.account.terminal;
    }
    sendBotState = null;
    clearAutoRetryPoll();
    renderSettings();
    renderSendBot();
    void refreshMeetings(false);
    showSettings(!config.account);
  });
  $('meetingSelect').addEventListener('change', selectMeeting);
  $('refreshBtn').addEventListener('click', () => void refreshMeetings(true));
  $('openTerminal').addEventListener('click', openTerminal);
  $('sendBotBtn').addEventListener('click', () => {
    if (sendBotState?.phase === 'retrying') void cancelBotRetry();
    else void sendBotToActiveMeeting();
  });
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
