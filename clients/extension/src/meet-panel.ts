import { createTranscriptFeed } from './transcript-feed';
import { botFetch, hasOwnedBotInRoom, listBotMeetings, readBotProcessedNotes, readBotRecap, readBotSpeakerLinks, readBotTranscript, stopBotMeeting, watchBotTranscript, type BotConnection, type BotMeeting, type BotProcessedNotes, type BotSpeakerLink } from './bot-transcript';
import { ACCOUNT_KEY, DEFAULT_GATEWAY, DEFAULT_TERMINAL, sessionCommand, storedAccount } from './extension-session';
import { meetAvatarUrl } from './meet-avatars';
import type { TranscriptSegment } from './transcript-rendering';
import type { VoiceReply } from './voice-replies';
import {
  watchTranslation, LANGUAGE_STORAGE_KEY, parseTranscriptLanguage, prioritizeSegmentIds,
  type TranscriptLanguage, type TranslationHandle, type TranslationSnapshot,
} from './translation';
import { currentGoogleMeetBot, isOwnedActiveBot, isTerminalBotStatus, latestMiniCaption } from './meet-panel-state';
import { createVoiceActivity } from './voice-activity-view';
import { createMeetAsk, requestNotesPreview } from './meet-ask';
import { createMeetFacts } from './meet-facts';
import { noteTime, notesPreview, recapGroups, recapText, type NoteGroup, type NotesPreview } from './meet-notes';
import { pinLabelLimit, pinScope, pinSource, readPins, writePin, type MeetingPin } from './meet-pins';

const $ = (id: string) => document.getElementById(id)!;
const meetId = new URLSearchParams(location.search).get('meet')?.trim() || '';
const validMeetId = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(meetId);
const parentOrigin = new URLSearchParams(location.search).get('parentOrigin') || '';
const feed = createTranscriptFeed($('feed'), $('transcriptTurns'), $('latestBtn') as HTMLButtonElement);
const voiceActivityView = createVoiceActivity($('voiceActivity'));
const askPanel = createMeetAsk();
const factsPanel = createMeetFacts($('notesFacts'));
const panelViews = ['transcript', 'notes', 'ask'] as const;
type PanelView = typeof panelViews[number];

let config: BotConnection = { botGatewayUrl: DEFAULT_GATEWAY };
let terminalUrl = DEFAULT_TERMINAL;
let selected: BotMeeting | null = null;
let segments: TranscriptSegment[] = [];
let speakerLinks = new Map<string, BotSpeakerLink>();
let avatarUrls = new Map<string, string>();
let speakerLinkKey = '';
let speakerLinkRequest: AbortController | null = null;
let lastAvatarRequest = -Infinity;
let replies: VoiceReply[] = [];
let translation: TranslationSnapshot | null = null;
let translationError = false;
let language: TranscriptLanguage = 'bilingual';
let stopWatching = () => {};
let stopTranslation: TranslationHandle = Object.assign(() => {}, { nudge: () => {} });
let lastConfirmedDigest = '';
let listRequest: AbortController | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let scope = 0;
let stopping = false;
let disposed = false;
let activePanelView: PanelView = 'transcript';
let notesSnapshot: BotProcessedNotes | null = null;
let storedRecap = '';
let recapError = false;
let pinPrefix = '';
let pins = new Map<string, MeetingPin>();
let writingPins = new Set<string>();
let pinRead = 0;
let preview: NotesPreview | null = null;
let previewRequest: AbortController | null = null;
let previewError = '';
let notesError = '';
let notesLoading = false;
let notesRequest: AbortController | null = null;
let notesTimer: ReturnType<typeof setTimeout> | undefined;
let notesScope = 0;
let sendBotState: 'idle' | 'sending' | 'sent' | 'error' = 'idle';
let sendBotMessage = '';
let sendBotResetTimer: ReturnType<typeof setTimeout> | undefined;
let lastMiniCaptionPayload = '';

function emitMiniCaption(): void {
  const caption = selected && !isTerminalBotStatus(selected.status)
    ? latestMiniCaption(segments, translation?.groups ?? [])
    : null;
  const serialized = JSON.stringify(caption);
  if (serialized === lastMiniCaptionPayload) return;
  lastMiniCaptionPayload = serialized;
  postPanelMessage('live-caption', { meet: meetId, caption });
}

function setBotStatus(message: string, state: 'loading' | 'active' | 'joining' | 'stopping' | 'ended' | 'error'): void {
  const status = $('botStatus');
  status.textContent = message;
  status.dataset.state = state;
}

function hasStoppableBot(): boolean {
  return isOwnedActiveBot(selected) || sendBotState === 'sent';
}

function renderFooterActions(): void {
  const send = $('sendBot') as HTMLButtonElement;
  const stop = $('stopBot') as HTMLButtonElement;
  const sending = sendBotState === 'sending';
  const canStop = !!config.account && (hasStoppableBot() || stopping);
  const stopPending = stopping || (isOwnedActiveBot(selected) && selected?.status.toLowerCase() === 'stopping');
  send.hidden = canStop || !config.account;
  $('signIn').hidden = !!config.account;
  $('signOut').hidden = !config.account;
  $('panelMenuAccount').hidden = !config.account;
  $('panelMenuSeparator').hidden = !config.account;
  $('accountEmail').textContent = config.account?.email || '';
  send.textContent = sending ? 'Đang gửi…' : sendBotState === 'error' ? 'Gửi lại Bot' : 'Invite TINA';
  send.disabled = !validMeetId || !config.account || sending || canStop;
  send.setAttribute('aria-busy', String(sending));
  send.title = !config.account ? 'Đăng nhập TINA để gửi Bot.' : 'Gửi TINA Bot vào Google Meet hiện tại.';
  stop.hidden = !canStop;
  if (!canStop) $('stopConfirm').hidden = true;
  stop.disabled = !config.account || stopPending;
  stop.textContent = stopPending ? 'Đang dừng…' : 'Stop TINA Bot';
  stop.title = 'Stop TINA Bot in this meeting.';
  const status = $('footerStatus');
  status.textContent = sendBotMessage;
  status.hidden = !sendBotMessage;
}

function setFooterStatus(message: string, error = false): void {
  sendBotMessage = message;
  const status = $('footerStatus');
  status.textContent = message;
  status.hidden = !message;
  status.dataset.state = error ? 'error' : 'ready';
}

function safeTerminalUrl(path: string): string {
  if (!terminalUrl.trim()) throw new Error('Hãy nhập URL TINA Terminal trong cài đặt extension.');
  const base = new URL(terminalUrl.trim());
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error('URL Terminal phải dùng HTTP/HTTPS và không chứa thông tin đăng nhập hoặc query.');
  const baseUrl = base.href + (base.href.endsWith('/') ? '' : '/');
  return new URL(path.replace(/^\/+/, ''), baseUrl).href;
}

async function sendBot(): Promise<void> {
  if (!validMeetId || !config.account || sendBotState === 'sending' || stopping || hasStoppableBot()) return;
  if (sendBotResetTimer) clearTimeout(sendBotResetTimer);
  const connection = config;
  const account = config.account;
  const isCurrent = () => !disposed && config.account?.key === account.key;
  sendBotState = 'sending';
  setFooterStatus('Đang gửi yêu cầu TINA Bot…');
  renderFooterActions();
  try {
    const response = await botFetch(connection, '/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'google_meet', native_meeting_id: meetId, meeting_url: `https://meet.google.com/${meetId}` }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({})) as { detail?: unknown };
    if (!isCurrent()) return;
    const failure = typeof body?.detail === 'string' && body.detail.trim()
      ? body.detail.slice(0, 300) : `Không gửi được Bot (${response.status}).`;
    if (response.status === 409) {
      const confirmed = await hasOwnedBotInRoom(connection, { platform: 'google_meet', nativeMeetingId: meetId });
      if (!isCurrent()) return;
      if (!confirmed) throw new Error(failure);
      sendBotState = 'sent';
      setFooterStatus('TINA Bot đã được mời vào phòng này.');
    } else if (response.status === 429) throw new Error('Đã đạt giới hạn Bot đang chạy. Hãy dừng một phiên khác rồi thử lại.');
    else if (response.status === 401) throw new Error('Hãy đăng nhập TINA lại để tiếp tục.');
    else if (response.status === 403) throw new Error('Tài khoản này chưa có quyền mời TINA Bot.');
    else if (!response.ok) throw new Error(failure);
    else {
      sendBotState = 'sent';
      setFooterStatus('Đã gửi Bot · hãy chấp nhận trong Meet nếu được hỏi.');
    }
    void connect();
    sendBotResetTimer = setTimeout(() => {
      if (sendBotState === 'sent' && !isOwnedActiveBot(selected)) {
        sendBotState = 'idle';
        setFooterStatus('');
        renderFooterActions();
      }
    }, 15000);
  } catch (error) {
    if (!isCurrent()) return;
    sendBotState = 'error';
    setFooterStatus(error instanceof Error ? error.message : 'Không gửi được TINA Bot.', true);
  }
  renderFooterActions();
}

function openTerminal(): void {
  try {
    const path = selected ? `/meetings/${selected.id}` : '/';
    void chrome.tabs.create({ url: safeTerminalUrl(path) }).catch(error => {
      setFooterStatus(error instanceof Error ? error.message : 'Không mở được TINA Terminal.', true);
    });
  } catch (error) {
    setFooterStatus(error instanceof Error ? error.message : 'Không mở được TINA Terminal.', true);
  }
}

function applyPanelTheme(theme: unknown): void {
  const dark = theme === 'dark' || theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  ($('logo') as HTMLImageElement).src = chrome.runtime.getURL(dark ? 'assets/tina-light.svg' : 'assets/tina-dark.svg');
  $('panelTheme').setAttribute('aria-checked', String(dark));
}

function postPanelMessage(type: string, detail: Record<string, unknown> = {}): void {
  try {
    const origin = new URL(parentOrigin);
    const meet = origin.protocol === 'https:' && origin.hostname === 'meet.google.com';
    const localPreview = origin.origin === location.origin && ['localhost', '127.0.0.1'].includes(origin.hostname);
    if (meet || localPreview) window.parent.postMessage({ ...detail, source: 'tina-meet-panel', type }, origin.origin);
  } catch { /* an invalid or absent parent origin cannot receive panel controls */ }
}

function beginPanelGesture(kind: 'move' | 'resize', target: HTMLElement, event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  try { target.setPointerCapture(event.pointerId); } catch { /* the gesture can still finish on the handle */ }
  const pointerId = event.pointerId;
  const controller = new AbortController();
  let finished = false;
  const finish = (next?: PointerEvent) => {
    if (finished || next && next.pointerId !== pointerId) return;
    finished = true;
    postPanelMessage('interaction-end');
    controller.abort();
  };
  const move = (next: PointerEvent) => {
    if (next.pointerId === pointerId) postPanelMessage('interaction-move', { screenX: next.screenX, screenY: next.screenY });
  };
  postPanelMessage('interaction-start', { kind, screenX: event.screenX, screenY: event.screenY });
  target.addEventListener('pointermove', move, { signal: controller.signal });
  target.addEventListener('pointerup', finish, { once: true, signal: controller.signal });
  target.addEventListener('pointercancel', finish, { once: true, signal: controller.signal });
  target.addEventListener('lostpointercapture', finish, { once: true, signal: controller.signal });
  window.addEventListener('blur', () => finish(), { once: true, signal: controller.signal });
}

function nudgePanel(kind: 'move' | 'resize', event: KeyboardEvent): void {
  const step = event.shiftKey ? 32 : 8;
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
  if (!dx && !dy) return;
  event.preventDefault();
  postPanelMessage('nudge', kind === 'move' ? { kind, dx, dy } : { kind, dw: dx, dh: dy });
}

function statusForMeeting(status: string): { label: string; state: 'active' | 'joining' | 'stopping' | 'ended' | 'error' } {
  const normalized = status.toLowerCase();
  if (normalized === 'active') return { label: 'Bot đang chạy', state: 'active' };
  if (normalized === 'stopping') return { label: 'Bot đang dừng', state: 'stopping' };
  if (normalized === 'failed') return { label: 'Bot gặp lỗi', state: 'error' };
  if (isTerminalBotStatus(normalized)) return { label: 'Bot đã kết thúc', state: 'ended' };
  return { label: 'Bot đang vào', state: 'joining' };
}

function renderTranslationStatus(): void {
  const status = $('translationStatus');
  const retry = $('retryTranslation') as HTMLButtonElement;
  if (!selected || language === 'vi') {
    status.textContent = '';
    delete status.dataset.state;
    retry.hidden = true;
    return;
  }
  const failed = translation?.groups.some(group => group.status === 'failed') ?? false;
  const retrying = translation?.groups.some(group => group.status === 'retrying') ?? false;
  status.dataset.state = translationError ? 'error' : translation?.status || 'pending';
  status.textContent = translationError
    ? 'Dịch chưa khả dụng · transcript gốc vẫn hoạt động'
    : translation?.service_error
      ? 'Dịch vụ dịch đang bận · sẽ tự thử lại'
      : translation
        ? `VI → EN · ${translation.completed}/${translation.total} cụm${translation.groups.some(group => !group.ready) ? ' · Đang gom câu…' : ''}`
        : 'Đang tải bản dịch…';
  retry.hidden = !(translationError || failed || retrying || translation?.status === 'paused');
}

function speakerPhoto(segment: TranscriptSegment): string | undefined {
  const link = segment.speaker_id && speakerLinks.get(segment.speaker_id);
  if (link && link.revision === segment.speaker_revision) return avatarUrls.get(link.participantId);
}

function requestAvatars(): void {
  if (!speakerLinks.size || activePanelView !== 'transcript' || performance.now() - lastAvatarRequest < 1000) return;
  lastAvatarRequest = performance.now();
  postPanelMessage('read-avatars', { meet: meetId });
}

async function syncSpeakerLinks(meetingId: number, rows: TranscriptSegment[]): Promise<void> {
  const keys = new Set(rows.flatMap(row => row.speaker_id && row.speaker_revision
    ? [JSON.stringify([row.speaker_id, row.speaker_revision])] : []));
  const key = [...keys].sort().join(',');
  if (key === speakerLinkKey) { requestAvatars(); return; }
  speakerLinkRequest?.abort();
  speakerLinkKey = key;
  if (!key) { speakerLinks.clear(); return; }
  const request = new AbortController();
  speakerLinkRequest = request;
  try {
    const links = await readBotSpeakerLinks(config, meetingId, request.signal);
    if (request.signal.aborted) return;
    speakerLinks = links;
    requestAvatars();
    render();
  } catch {
    if (!request.signal.aborted) speakerLinkKey = '';
  } finally {
    if (speakerLinkRequest === request) speakerLinkRequest = null;
  }
}

window.addEventListener('message', event => {
  const message = event.data;
  if (disposed || !selected || !speakerLinks.size || event.source !== window.parent
      || event.origin !== parentOrigin || message?.source !== 'tina-meet-content'
      || message.type !== 'avatars' || message.meet !== meetId || !Array.isArray(message.entries)) return;
  const urls = new Map<string, string>();
  const ids = new Set([...speakerLinks.values()].map(link => link.participantId));
  for (const entry of message.entries.slice(0, 500)) {
    if (!Array.isArray(entry) || !ids.has(entry[0])) continue;
    const url = meetAvatarUrl(entry[1]);
    if (url) urls.set(entry[0], url);
  }
  if (urls.size === avatarUrls.size && [...urls].every(([id, url]) => avatarUrls.get(id) === url)) return;
  avatarUrls = urls;
  render();
});

function render(): void {
  const status = selected?.status || '';
  const hasText = segments.some(row => row.text?.trim()) || replies.length > 0;
  $('emptyState').hidden = hasText;
  feed.render(segments, 'Draft', language, translation?.groups ?? [], translationError || translation?.status === 'paused', replies, {
    available: segment => !!pinPrefix && !!pinSource(segment),
    pinned: id => pins.has(id),
    busy: id => writingPins.has(id),
    toggle: togglePin,
  }, speakerPhoto);
  if (activePanelView === 'notes') renderPins();
  renderTranslationStatus();
  emitMiniCaption();
  if (hasText) $('emptyMessage').textContent = '';
  else if (selected) $('emptyMessage').textContent = 'Đang chờ transcript từ TINA Bot…';
  renderFooterActions();
}

function clearWatchers(): void {
  scope++;
  clearPins();
  askPanel.reset();
  stopNotesPolling(true);
  listRequest?.abort(); listRequest = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  stopWatching(); stopWatching = () => {};
  stopTranslation(); stopTranslation = Object.assign(() => {}, { nudge: () => {} });
  lastConfirmedDigest = '';
  speakerLinkRequest?.abort(); speakerLinkRequest = null;
  speakerLinkKey = ''; speakerLinks.clear(); avatarUrls.clear(); lastAvatarRequest = -Infinity;
  selected = null; segments = []; replies = []; translation = null; translationError = false; stopping = false;
  feed.reset();
  voiceActivityView.reset();
  renderNotes();
  renderFooterActions();
  emitMiniCaption();
}

function startTranslation(retry = false): void {
  stopTranslation(); stopTranslation = Object.assign(() => {}, { nudge: () => {} });
  translation = null; translationError = false;
  if (!selected || language === 'vi') { render(); return; }
  const token = scope, meetingId = selected.id;
  stopTranslation = watchTranslation(config, meetingId, snapshot => {
    if (disposed || token !== scope || selected?.id !== meetingId) return;
    translation = snapshot; translationError = false; render();
  }, () => {
    if (disposed || token !== scope || selected?.id !== meetingId) return;
    translationError = true; render();
  }, retry, () => prioritizeSegmentIds(segments));
  render();
}

function watch(meeting: BotMeeting, token: number): void {
  selected = meeting;
  void openPins(meeting, token);
  $('meetingTitle').textContent = meeting.title;
  const initial = statusForMeeting(meeting.status);
  setBotStatus(initial.label, initial.state);
  $('emptyTitle').textContent = isTerminalBotStatus(meeting.status) ? 'Transcript đã lưu' : 'Transcript trực tiếp';
  $('emptyMessage').textContent = 'Đang chờ transcript từ TINA Bot…';
  render();
  startTranslation();
  stopWatching = watchBotTranscript(config, meeting, (rows, nextStatus, nextReplies = [], voiceStatus) => {
    if (disposed || token !== scope || selected?.id !== meeting.id) return;
    const previousStatus = selected.status;
    const hadConfirmed = hasConfirmedTranscript();
    selected = { ...meeting, status: nextStatus };
    segments = rows; replies = nextReplies;
    const confirmedDigest = rows.filter(r => r.completed !== false && r.segment_id).map(r => `${r.segment_id}:${r.text}`).join('|');
    if (confirmedDigest !== lastConfirmedDigest) {
      lastConfirmedDigest = confirmedDigest;
      stopTranslation.nudge();
    }
    void syncSpeakerLinks(meeting.id, rows);
    voiceActivityView.update(voiceStatus, isTerminalBotStatus(nextStatus));
    if (isOwnedActiveBot(selected) && sendBotState === 'sent' && !stopping) {
      sendBotState = 'idle';
      sendBotMessage = '';
      if (sendBotResetTimer) clearTimeout(sendBotResetTimer);
    }
    if (!meeting.shared && isTerminalBotStatus(nextStatus) && stopping) {
      sendBotState = 'idle';
      sendBotMessage = '';
      stopping = false;
    }
    const current = statusForMeeting(nextStatus);
    const ownedStopping = stopping && isOwnedActiveBot(selected);
    setBotStatus(ownedStopping ? 'Đang dừng Bot' : current.label, ownedStopping ? 'stopping' : current.state);
    if (isTerminalBotStatus(nextStatus)) { stopWatching(); stopWatching = () => {}; }
    render();
    if (activePanelView === 'notes') {
      if (previousStatus !== nextStatus) startNotesPolling();
      else if (hadConfirmed !== hasConfirmedTranscript()) renderNotes();
    }
  }, (message, denied) => {
    if (disposed || token !== scope || selected?.id !== meeting.id) return;
    if (denied) {
      segments = []; replies = [];
      void syncSpeakerLinks(meeting.id, []);
      clearPins();
      setBotStatus('Thiếu quyền', 'error');
    } else setBotStatus('Đang kết nối', 'joining');
    voiceActivityView.update(null);
    $('emptyMessage').textContent = message;
    render();
    if (denied) {
      stopNotesPolling(true);
      notesError = message;
      renderNotes();
    }
  });
  if (activePanelView === 'notes') startNotesPolling();
  if (activePanelView === 'ask') askPanel.open(config, meeting.id);
}

function noteFeedback(message: string): void {
  const feedback = $('noteFeedback');
  feedback.textContent = message;
  feedback.hidden = !message;
}

function pinFeedback(message: string): void {
  const feedback = $('pinFeedback');
  feedback.textContent = message;
  feedback.hidden = !message;
}

function clearPins(): void {
  pinRead++;
  pinPrefix = '';
  writingPins = new Set();
  pins.clear();
  pinFeedback('');
  renderPins();
}

async function openPins(meeting: BotMeeting, token: number): Promise<void> {
  const request = ++pinRead;
  try {
    const prefix = await pinScope(config, meeting);
    const saved = await readPins(prefix);
    if (token !== scope || request !== pinRead || selected?.id !== meeting.id) return;
    pinPrefix = prefix;
    pins = new Map(saved.map(pin => [pin.segmentId, pin]));
    render();
  } catch {
    if (token === scope && request === pinRead) pinFeedback('Không đọc được ghim đã lưu trong trình duyệt.');
  }
}

async function updatePin(pin: MeetingPin, remove = false): Promise<void> {
  const prefix = pinPrefix;
  const busy = writingPins;
  if (!prefix || busy.has(pin.segmentId)) return;
  busy.add(pin.segmentId);
  render();
  const feedback = activePanelView === 'notes' ? noteFeedback : pinFeedback;
  try {
    await writePin(prefix, pin, remove);
    if (prefix !== pinPrefix || busy !== writingPins) return;
    if (remove) pins.delete(pin.segmentId);
    else pins.set(pin.segmentId, pin);
    feedback(remove ? 'Đã bỏ ghim.' : 'Đã lưu ghim.');
  } catch {
    if (prefix === pinPrefix && busy === writingPins) feedback('Không lưu được thay đổi ghim. Hãy thử lại.');
  } finally {
    busy.delete(pin.segmentId);
    if (prefix === pinPrefix && busy === writingPins) render();
  }
}

function togglePin(segment: TranscriptSegment): void {
  const pin = pinSource(segment);
  if (pin) void updatePin(pin, pins.has(pin.segmentId));
}

function renderPins(): void {
  const list = $('meetingPinEntries');
  const rows = [...pins.values()].sort((a, b) => a.timeMs - b.timeMs).map(pin => ({
    pin,
    quote: segments.find(segment => segment.segment_id === pin.segmentId)?.text.trim().slice(0, 180),
  }));
  $('meetingPins').hidden = !rows.length;
  const version = JSON.stringify(rows);
  if (list.dataset.version === version) return;
  list.dataset.version = version;
  list.replaceChildren();
  for (const { pin, quote } of rows) {
    const row = document.createElement('li');
    row.className = 'note-item';
    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const startMs = selected?.startMs;
    const offsetMs = startMs != null && Number.isFinite(startMs) && pin.timeMs >= startMs ? pin.timeMs - startMs : pin.timeMs;
    const time = noteTime(offsetMs / 1000);
    const jump = document.createElement('button');
    jump.type = 'button'; jump.className = 'note-time'; jump.textContent = time;
    jump.setAttribute('aria-label', `Mở đoạn đã ghim lúc ${time}`);
    jump.onclick = () => void jumpToNote(pin.segmentId, jump);
    meta.append(jump);
    if (pin.label) {
      const label = document.createElement('strong');
      label.textContent = pin.label;
      meta.append(label);
    }
    const excerpt = document.createElement('p');
    excerpt.className = 'note-copy';
    excerpt.textContent = quote || 'Mở transcript để xem đoạn đã ghim.';
    const actions = document.createElement('div');
    actions.className = 'note-pin-actions';
    const edit = document.createElement('details');
    const editToggle = document.createElement('summary');
    editToggle.textContent = pin.label ? 'Đổi nhãn' : 'Thêm nhãn';
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.maxLength = pinLabelLimit; input.value = pin.label;
    input.setAttribute('aria-label', 'Nhãn cho đoạn đã ghim');
    const save = document.createElement('button');
    save.type = 'submit'; save.className = 'button'; save.textContent = 'Lưu nhãn';
    form.onsubmit = event => {
      event.preventDefault();
      const label = input.value.trim().slice(0, pinLabelLimit);
      edit.open = false;
      if (label !== pin.label) void updatePin({ ...pin, label });
    };
    form.append(input, save);
    edit.append(editToggle, form);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'button'; remove.textContent = 'Bỏ ghim';
    remove.onclick = () => void updatePin(pin, true);
    actions.append(edit, remove);
    row.append(meta, excerpt, actions);
    list.append(row);
  }
}

async function jumpToNote(segmentId: string, button: HTMLButtonElement): Promise<void> {
  const meeting = selected;
  if (!meeting) return;
  const token = notesScope;
  noteFeedback('');
  if (!segments.some(segment => segment.segment_id === segmentId)) {
    button.disabled = true;
    try {
      const refreshed = await readBotTranscript(config, meeting);
      if (token !== notesScope || selected?.id !== meeting.id || !button.isConnected) return;
      if (isTerminalBotStatus(selected.status)) segments = refreshed;
      else if (!segments.some(segment => segment.segment_id === segmentId)) {
        const source = refreshed.find(segment => segment.segment_id === segmentId);
        if (source) segments = [...segments, source].sort((a, b) => Date.parse(a.absolute_start_time) - Date.parse(b.absolute_start_time));
      }
      render();
    } catch {
      if (token === notesScope) noteFeedback('Không tải được transcript nguồn. Hãy thử lại.');
      return;
    } finally {
      button.disabled = false;
    }
  }
  if (!segments.some(segment => segment.segment_id === segmentId)) {
    noteFeedback('Đoạn transcript nguồn chưa khả dụng.');
    return;
  }
  selectPanelView('transcript');
  const phrase = language !== 'vi' && translation?.groups.find(group => group.members.some(member => member.segment_id === segmentId));
  if (!feed.focusSegment(segmentId) && phrase) feed.focusSegment(phrase.group_id);
}

function renderNoteGroups(entries: HTMLElement, groups: NoteGroup[]): void {
  const version = JSON.stringify(groups);
  if (entries.dataset.version === version) return;
  entries.dataset.version = version;
  entries.replaceChildren();
  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'notes-group';
    const heading = document.createElement('h3');
    heading.textContent = group.title;
    const list = document.createElement('ul');
    for (const note of group.notes) {
      const row = document.createElement('li');
      row.className = 'note-item';
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      if (note.t != null) {
        const time = noteTime(note.t);
        const segmentId = note.segmentId;
        if (segmentId && !note.stale && !note.withdrawn) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'note-time';
          button.textContent = time;
          button.setAttribute('aria-label', `Mở transcript tại ${time}`);
          button.addEventListener('click', () => void jumpToNote(segmentId, button));
          meta.append(button);
        } else {
          const label = document.createElement('span');
          label.textContent = time;
          meta.append(label);
        }
      }
      if (note.speaker) {
        const speaker = document.createElement('span');
        speaker.textContent = note.speaker;
        meta.append(speaker);
      }
      if (note.withdrawn || note.stale) {
        const label = document.createElement('span');
        label.className = 'note-stale';
        label.textContent = note.withdrawn ? 'Đã rút lại' : 'Nguồn đã thay đổi';
        meta.append(label);
      }
      const copy = document.createElement('p');
      copy.className = 'note-copy';
      copy.textContent = note.withdrawn ? 'Ghi chú này đã được rút lại.' : note.text;
      if (meta.childNodes.length) row.append(meta);
      row.append(copy);
      list.append(row);
    }
    section.append(heading, list);
    entries.append(section);
  }
}

function showingLiveNotes(): boolean {
  return selected?.status.toLowerCase() === 'active' && !notesSnapshot?.finished;
}

function hasConfirmedTranscript(): boolean {
  return segments.some(segment => segment.completed !== false && !!segment.text?.trim());
}

function renderNotes(): void {
  const live = showingLiveNotes();
  const groups = preview?.groups ?? [];
  renderPins();
  $('storedRecap').hidden = !storedRecap;
  $('storedRecapText').textContent = storedRecap;
  const finished = !!selected && isTerminalBotStatus(selected.status);
  const cleaned = finished ? recapGroups(notesSnapshot?.notes ?? []) : [];
  const cleanedDetails = $('notesCleaned') as HTMLDetailsElement;
  cleanedDetails.hidden = !cleaned.length;
  renderNoteGroups($('notesCleanedEntries'), cleaned);
  const empty = $('notesEmpty');
  const status = $('notesStatus');
  const refresh = $('refreshNotes') as HTMLButtonElement;
  const generate = $('generateNotes') as HTMLButtonElement;
  const canGenerate = !!selected && (hasConfirmedTranscript() || cleaned.length > 0);
  generate.disabled = !canGenerate || !!previewRequest;
  generate.textContent = previewRequest ? 'Đang tóm tắt…' : preview ? 'Tạo lại' : 'Tạo tóm tắt';
  $('notesHeading').textContent = live ? 'Live Notes' : 'Notes sau họp';
  status.hidden = groups.length === 0;
  $('copyNotes').hidden = !groups.length && !storedRecap;
  refresh.disabled = !selected || notesLoading;
  renderNoteGroups($('notesEntries'), groups);
  empty.hidden = groups.length > 0 || !!storedRecap
    || ((pins.size > 0 || cleaned.length > 0) && !previewRequest && !previewError);

  const showStatus = (state: string, heading: string, message: string) => {
    status.dataset.state = state;
    if (status.textContent !== heading) status.textContent = heading;
    $('notesEmptyTitle').textContent = heading;
    $('notesEmptyMessage').textContent = message;
  };
  const failed = (heading: string, message: string) => showStatus('failed', heading, message);
  const snapshot = notesSnapshot;
  if (previewError) {
    failed('Chưa tạo được bản tóm tắt', previewError);
  } else if (previewRequest) {
    showStatus('pending', 'Đang tạo bản tóm tắt', 'TINA đang tổng hợp các ý từ transcript đã xác nhận.');
  } else if (preview) {
    const coverage = preview.bounded ? 'Tóm tắt dựa trên các đoạn được chọn' : 'Summary from the confirmed transcript';
    if (groups.length) showStatus('current', coverage, '');
    else showStatus('current', 'Chưa có ý chính để ghi chú', 'Các đoạn đã xử lý chưa có kết luận hoặc việc cần làm rõ ràng.');
  } else if (!selected) {
    showStatus('', 'Chưa có TINA Bot', 'Gửi Bot vào phòng Meet này để tạo ghi chú.');
  } else if (recapError && !notesLoading) {
    failed('Không tải được tóm tắt đã lưu', 'Bấm Làm mới để thử lại.');
  } else if (canGenerate) {
    showStatus('current', 'Tóm tắt cuộc họp', 'Bấm Tạo tóm tắt để xem ý chính, quyết định và việc cần làm.');
  } else if (notesError) {
    failed('Không tải được Notes', notesError);
  } else if (snapshot?.status === 'failed') {
    failed('Xử lý transcript thất bại', 'Mở TINA Terminal để kiểm tra và thử lại.');
  } else {
    showStatus('pending', 'Đang chờ transcript', 'Bạn có thể tạo tóm tắt khi TINA Bot lưu lời nói.');
  }
}

async function generateNotes(): Promise<void> {
  const meeting = selected;
  if (!meeting || previewRequest) return;
  const controller = new AbortController();
  previewRequest = controller;
  previewError = '';
  noteFeedback('');
  renderNotes();
  try {
    const result = await requestNotesPreview(config, meeting.id, controller.signal);
    if (!controller.signal.aborted && selected?.id === meeting.id) preview = notesPreview(result, meeting.id);
  } catch (error) {
    if (!controller.signal.aborted && selected?.id === meeting.id)
      previewError = error instanceof Error ? error.message : 'Không tạo được bản tóm tắt.';
  } finally {
    if (previewRequest === controller) {
      previewRequest = null;
      renderNotes();
    }
  }
}

async function copyNotes(): Promise<void> {
  const text = recapText(preview?.groups ?? []) || storedRecap;
  if (!text) return;
  const token = notesScope;
  try {
    await navigator.clipboard.writeText(text);
    if (token === notesScope) noteFeedback('Đã sao chép ghi chú.');
  } catch {
    if (token === notesScope) noteFeedback('Không sao chép được. Hãy cấp quyền clipboard hoặc chọn nội dung để sao chép.');
  }
}

function stopNotesPolling(clear = false): void {
  factsPanel.stop();
  notesScope++;
  notesRequest?.abort(); notesRequest = null;
  if (notesTimer) clearTimeout(notesTimer);
  notesTimer = undefined;
  notesLoading = false;
  noteFeedback('');
  if (clear) {
    notesSnapshot = null; notesError = '';
    storedRecap = ''; recapError = false;
    previewRequest?.abort(); previewRequest = null;
    preview = null; previewError = '';
    ($('notesCleaned') as HTMLDetailsElement).open = false;
  }
}

async function pollNotes(token: number, meeting: BotMeeting): Promise<void> {
  if (disposed || token !== notesScope || activePanelView !== 'notes' || selected?.id !== meeting.id) return;
  const controller = new AbortController();
  notesRequest = controller;
  notesLoading = true;
  notesError = '';
  renderNotes();
  try {
    const [notes, recap] = await Promise.allSettled([
      readBotProcessedNotes(config, meeting.id, controller.signal),
      isTerminalBotStatus(meeting.status) ? readBotRecap(config, meeting, controller.signal) : Promise.resolve(''),
    ]);
    if (!controller.signal.aborted && token === notesScope && activePanelView === 'notes' && selected?.id === meeting.id) {
      storedRecap = recap.status === 'fulfilled' ? recap.value : '';
      recapError = recap.status === 'rejected';
      if (notes.status === 'rejected') throw notes.reason;
      notesSnapshot = notes.value;
    }
  } catch (error) {
    if (!controller.signal.aborted && token === notesScope && selected?.id === meeting.id)
      notesError = error instanceof Error ? error.message : 'Không đọc được Notes.';
  } finally {
    if (controller.signal.aborted || disposed || token !== notesScope) return;
    notesRequest = null;
    notesLoading = false;
    renderNotes();
    if (activePanelView === 'notes' && selected?.id === meeting.id)
      notesTimer = setTimeout(() => void pollNotes(token, meeting), 10000);
  }
}

function startNotesPolling(): void {
  stopNotesPolling();
  if (!selected || activePanelView !== 'notes') { renderNotes(); return; }
  factsPanel.start(config, selected.id);
  const token = notesScope;
  void pollNotes(token, selected);
}

function selectPanelView(view: PanelView): void {
  if (view === activePanelView) return;
  activePanelView = view;
  $('askNewQuestion').hidden = view !== 'ask';
  for (const name of panelViews) {
    const tab = $(name + 'Tab');
    tab.setAttribute('aria-selected', String(name === view));
    tab.tabIndex = name === view ? 0 : -1;
    $(name + 'View').hidden = name !== view;
  }
  if (view === 'notes') startNotesPolling();
  else stopNotesPolling();
  if (view === 'transcript') requestAvatars();
  if (view === 'ask' && selected) askPanel.open(config, selected.id);
}

async function connect(): Promise<void> {
  if (disposed || !validMeetId) {
    voiceActivityView.reset();
    setBotStatus('Không nhận diện phòng', 'error');
    $('emptyTitle').textContent = 'Không tìm thấy mã cuộc họp';
    $('emptyMessage').textContent = 'Mở TINA từ một phòng Google Meet đang hoạt động.';
    return;
  }
  clearWatchers();
  const token = scope;
  const controller = new AbortController(); listRequest = controller;
  $('refreshBot').hidden = true;
  $('meetingTitle').textContent = 'Đang tìm TINA Bot…';
  $('emptyTitle').textContent = 'Đang kết nối transcript';
  $('emptyMessage').textContent = 'TINA đang kiểm tra Bot trong phòng Meet này.';
  setBotStatus('Kiểm tra Bot', 'loading'); render();
  try {
    const stored = await chrome.storage.local.get([ACCOUNT_KEY, 'botGatewayUrl', 'terminalUrl', 'theme', LANGUAGE_STORAGE_KEY]);
    if (controller.signal.aborted || token !== scope) return;
    language = parseTranscriptLanguage(stored[LANGUAGE_STORAGE_KEY], language);
    ($('language') as HTMLSelectElement).value = language;
    const account = storedAccount(stored[ACCOUNT_KEY]);
    config = { account, botGatewayUrl: account?.gateway || stored.botGatewayUrl || DEFAULT_GATEWAY };
    terminalUrl = account?.terminal || stored.terminalUrl || DEFAULT_TERMINAL;
    renderFooterActions();
    applyPanelTheme(stored.theme);
    if (!config.account) {
      voiceActivityView.update({ runtime: { session_active: false } });
      setBotStatus('Chưa đăng nhập', 'joining');
      $('meetingTitle').textContent = 'MeetTina';
      $('emptyTitle').textContent = 'Đăng nhập để xem transcript';
      $('emptyMessage').textContent = 'Dùng tài khoản Google của bạn trên TINA Terminal.';
      return;
    }
    const rows = await listBotMeetings(config, controller.signal);
    if (controller.signal.aborted || token !== scope) return;
    const meeting = currentGoogleMeetBot(rows, meetId);
    if (!meeting) {
      voiceActivityView.update({ runtime: { session_active: false } });
      setBotStatus('Chưa có Bot', 'joining');
      $('meetingTitle').textContent = 'Chưa tìm thấy TINA Bot';
      $('emptyTitle').textContent = 'Bot chưa vào cuộc họp';
      $('emptyMessage').textContent = 'Gửi TINA Bot vào phòng này từ TINA Terminal. Bảng sẽ tự kiểm tra lại.';
      $('refreshBot').hidden = false;
      retryTimer = setTimeout(() => { void connect(); }, 5000);
      return;
    }
    watch(meeting, token);
    if (sendBotState === 'sent' && !isOwnedActiveBot(meeting)) {
      retryTimer = setTimeout(() => { if (sendBotState === 'sent' && !stopping) void connect(); }, 5000);
    }
  } catch (error) {
    if (controller.signal.aborted || token !== scope) return;
    voiceActivityView.update(null);
    setBotStatus('TINA mất kết nối', 'error');
    $('meetingTitle').textContent = 'Không tải được Bot';
    $('emptyTitle').textContent = 'Không kết nối được TINA';
    $('emptyMessage').textContent = error instanceof Error ? error.message : 'Kiểm tra kết nối trong Settings.';
    $('refreshBot').hidden = false;
  }
}

async function requestStop(): Promise<void> {
  if (!config.account || stopping || !hasStoppableBot()) return;
  const account = config.account;
  stopping = true; render();
  try {
    await stopBotMeeting(config, { platform: 'google_meet', nativeMeetingId: meetId });
    if (config.account?.key !== account?.key) return;
    if (selected && isOwnedActiveBot(selected)) selected = { ...selected, status: 'stopping' };
    else {
      sendBotState = 'idle';
      stopping = false;
      setFooterStatus('Đã gửi yêu cầu dừng TINA Bot.');
    }
    if (!selected?.shared) setBotStatus(stopping ? 'Bot đang dừng' : 'Bot đã dừng', stopping ? 'stopping' : 'ended');
  } catch (error) {
    if (config.account?.key !== account?.key) return;
    stopping = false;
    setBotStatus('Dừng thất bại', 'error');
    $('translationStatus').dataset.state = 'error';
    $('translationStatus').textContent = error instanceof Error ? error.message : 'Không dừng được TINA Bot.';
  }
  $('stopConfirm').hidden = true;
  render();
}

$('closePanel').addEventListener('click', () => {
  postPanelMessage('close');
});
for (const id of ['signIn', 'signOut']) {
  const button = $(id) as HTMLButtonElement;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (id === 'signIn') {
        await sessionCommand({ action: 'login', terminal: terminalUrl, gateway: config.botGatewayUrl });
      } else if (config.account) {
        await sessionCommand({ action: 'logout', key: config.account.key });
      }
    } catch (error) {
      setFooterStatus(error instanceof Error ? error.message : 'Không kết nối được TINA.', true);
    } finally { button.disabled = false; }
  });
}
($('sendBot') as HTMLButtonElement).addEventListener('click', () => void sendBot());
($('openTerminal') as HTMLButtonElement).addEventListener('click', openTerminal);
const panelTheme = $('panelTheme') as HTMLButtonElement;
panelTheme.addEventListener('click', async () => {
  const theme = panelTheme.getAttribute('aria-checked') === 'true' ? 'light' : 'dark';
  panelTheme.disabled = true;
  try {
    await chrome.storage.local.set({ theme });
    applyPanelTheme(theme);
  } catch {
    setFooterStatus('Could not save the theme. Please try again.', true);
  } finally {
    panelTheme.disabled = false;
    if ($('panelMenu').matches(':popover-open')) panelTheme.focus();
  }
});
for (const view of panelViews) $(view + 'Tab').addEventListener('click', () => selectPanelView(view));
($('panelTabs')).addEventListener('keydown', event => {
  const key = (event as KeyboardEvent).key;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
  event.preventDefault();
  const index = panelViews.indexOf(activePanelView);
  const last = panelViews.length - 1;
  const next = panelViews[key === 'Home' ? 0 : key === 'End' ? last
    : (index + (key === 'ArrowLeft' ? last : 1)) % panelViews.length];
  selectPanelView(next);
  $(next + 'Tab').focus();
});
($('refreshNotes') as HTMLButtonElement).addEventListener('click', () => startNotesPolling());
($('copyNotes') as HTMLButtonElement).addEventListener('click', () => void copyNotes());
($('generateNotes') as HTMLButtonElement).addEventListener('click', () => void generateNotes());
const movePanel = $('movePanel') as HTMLButtonElement;
const resizePanel = $('resizePanel') as HTMLButtonElement;
movePanel.addEventListener('pointerdown', event => beginPanelGesture('move', movePanel, event));
movePanel.addEventListener('keydown', event => nudgePanel('move', event));
resizePanel.addEventListener('pointerdown', event => beginPanelGesture('resize', resizePanel, event));
resizePanel.addEventListener('keydown', event => nudgePanel('resize', event));
$('panelHeader').addEventListener('pointerdown', event => {
  if (event.target instanceof Element && event.target.closest('button, [popover]')) return;
  beginPanelGesture('move', $('panelHeader'), event);
});
($('language') as HTMLSelectElement).addEventListener('change', () => {
  language = parseTranscriptLanguage(($('language') as HTMLSelectElement).value);
  void chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: language });
  render(); startTranslation();
});
($('refreshBot') as HTMLButtonElement).addEventListener('click', () => void connect());
($('retryTranslation') as HTMLButtonElement).addEventListener('click', () => startTranslation(true));
($('stopBot') as HTMLButtonElement).addEventListener('click', () => {
  if (activePanelView !== 'transcript') selectPanelView('transcript');
  $('stopConfirm').hidden = false;
});
($('cancelStop') as HTMLButtonElement).addEventListener('click', () => { $('stopConfirm').hidden = true; });
($('confirmStop') as HTMLButtonElement).addEventListener('click', () => void requestStop());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.theme) applyPanelTheme(changes.theme.newValue);
  if (changes[LANGUAGE_STORAGE_KEY]) {
    const nextLang = parseTranscriptLanguage(changes[LANGUAGE_STORAGE_KEY].newValue);
    if (nextLang !== language) {
      language = nextLang;
      ($('language') as HTMLSelectElement).value = language;
      render();
      startTranslation();
    }
  }
  if (changes[ACCOUNT_KEY] || changes.terminalUrl || changes.botGatewayUrl) {
    if (changes[ACCOUNT_KEY]) {
      config = { ...config, account: undefined };
      if (sendBotResetTimer) clearTimeout(sendBotResetTimer);
      sendBotState = 'idle';
      setFooterStatus('');
      $('stopConfirm').hidden = true;
    }
    void connect();
  }
  else if (selected && pinPrefix && Object.keys(changes).some(key => key.startsWith(pinPrefix))) void openPins(selected, scope);
});
window.addEventListener('pagehide', () => {
  disposed = true;
  if (sendBotResetTimer) clearTimeout(sendBotResetTimer);
  clearWatchers();
}, { once: true });
void connect();
