/**
 * Side panel UI — local capture controls and an authenticated Meeting Bot transcript viewer.
 *
 * This panel drives the capture session (Start / Pause / Stop / settings /
 * status) through the background worker (START/STOP/STATUS messages). The live
 * transcript itself is read on the TINA dashboard (the "Dashboard ↗" button) —
 * the panel also renders the live feed with the shared transcript manager.
 *
 * Capture flows: panel Start → background opens the ingest WS
 * (ws://localhost:9099/ingest, the desktop) → tells the Meet tab's content
 * script to begin per-participant capture.
 */
import { createTranscriptManager, type TranscriptSegment } from './transcript-rendering';
import { createTranscriptFeed } from './transcript-feed';
import type { VoiceReply } from './voice-replies';
import { type CaptureStatus, isActive } from './capture-liveness';
import { resolveEndpoints, resolveDashboardUrl, dashboardOverride, normalizeDeployment, DEFAULT_DEPLOYMENT } from './endpoints';
import { botBase, listBotMeetings, watchBotTranscript, readBotVoiceSources, type BotMeeting } from './bot-transcript';

interface PanelState {
  status: CaptureStatus;
  sessionId?: string | null;
  startedAt?: number | null;
  paused?: boolean;
  platform: string | null;
  nativeMeetingId: string | null;
  meetingId: number | null;
  streams: number;
  error: string | null;
  pendingAudioFrames?: number;
  pendingAudioBytes?: number;
  transcription?: { backend: string; label: string; model: string; source: string };
  swBuild?: string;
  diskBuild?: string;
}

// build-stamp.txt as this panel doc loaded — compared to the SW's swBuild to
// detect a stale background (reload deferred during capture).
let panelBuild = '';
fetch(chrome.runtime.getURL('build-stamp.txt')).then(r => r.text()).then(s => { panelBuild = s; }).catch(() => { /* none */ });

const $ = (id: string) => document.getElementById(id)!;

const PLATFORMS: Record<string, { name: string; color: string }> = {
  google_meet: { name: 'Google Meet', color: '#22c55e' },
  zoom: { name: 'Zoom', color: '#2d8cff' },
  teams: { name: 'Microsoft Teams', color: '#6264a7' },
  youtube: { name: 'YouTube', color: '#ff0000' },
  note: { name: 'Voice note', color: '#f59e0b' },
};

// `deployment` is a SELECT (the preset) — its default + the URL fields below come
// from src/endpoints.ts so the panel, background, and unit test agree on one SSOT.
const FIELDS = ['apiKey', 'deployment', 'ingestUrl', 'gatewayUrl', 'dashboardUrl', 'language', 'botGatewayUrl', 'terminalUrl'] as const;
const DEFAULTS: Record<string, string> = {
  deployment: DEFAULT_DEPLOYMENT,
  ingestUrl: resolveEndpoints().ingestUrl,
  gatewayUrl: resolveEndpoints().gatewayUrl,
  dashboardUrl: '',
  language: 'auto',
};

let cfg: Record<string, string> = { ...DEFAULTS };
let state: PanelState = { status: 'idle', platform: null, nativeMeetingId: null, meetingId: null, streams: 0, error: null };
let transcriptionPreview: (NonNullable<PanelState['transcription']> & { configured?: boolean }) | undefined;
let previewBusy = false;
let previewError: string | null = null;
let asrFault: string | null = null;
let connectionBusy = false;
let transcriptSource: 'capture' | 'bot' = 'capture';
let botMeetings: BotMeeting[] = [];
let botMeeting: BotMeeting | null = null;
let botWatching = false;
let botReplies: VoiceReply[] = [];
let botStop = () => {};
let botListRequest: AbortController | null = null;

function resetBot(clear = false): void {
  botStop(); botStop = () => {}; botWatching = false;
  if (clear) { txSegs = []; botReplies = []; transcriptFeed.reset(); renderFeed(); }
}

function renderBot(): void {
  $('asrBackend').textContent = 'Transcript từ Meeting Bot · Extension không thu audio';
  $('languageReview').hidden = true;
  $('statusPill').classList.toggle('live', botWatching);
  $('statusText').textContent = botWatching ? 'Watching' : 'Idle';
  const toggle = $('toggleBtn') as HTMLButtonElement;
  toggle.textContent = 'Watch transcript'; toggle.disabled = botWatching || !botMeeting;
  const stop = $('stopBtn') as HTMLButtonElement;
  stop.textContent = 'Ngừng xem'; stop.style.display = botWatching ? '' : 'none'; stop.disabled = false;
  $('dashBtn').textContent = 'Open Terminal ↗';
  $('meetingBar').style.display = 'none';
  $('captureNotice').hidden = true;
  $('micGrantBtn').hidden = true;
  renderFeed();
}

async function refreshBotMeetings(): Promise<void> {
  botListRequest?.abort();
  const request = new AbortController(); botListRequest = request;
  const scope = `${cfg.botGatewayUrl}|${cfg.apiKey}`;
  $('botNotice').textContent = 'Đang tải cuộc họp…';
  try {
    const meetings = await listBotMeetings({ botGatewayUrl: cfg.botGatewayUrl, apiKey: cfg.apiKey }, request.signal);
    if (request.signal.aborted || scope !== `${cfg.botGatewayUrl}|${cfg.apiKey}` || transcriptSource !== 'bot') return;
    botMeetings = meetings;
    if (botMeeting && !meetings.some(meeting => meeting.id === botMeeting!.id)) { resetBot(true); botMeeting = null; }
    const select = $('botMeeting') as HTMLSelectElement;
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Chọn cuộc họp';
    select.replaceChildren(placeholder);
    for (const meeting of meetings) {
      const option = document.createElement('option'); option.value = String(meeting.id);
      const when = Number.isFinite(meeting.startMs) ? new Date(meeting.startMs).toLocaleString() : '';
      option.textContent = `#${meeting.id} · ${meeting.title} · ${meeting.platform} · ${meeting.status} · ${when}`;
      select.append(option);
    }
    select.value = botMeeting ? String(botMeeting.id) : '';
    $('botNotice').textContent = meetings.length ? 'Hiển thị tối đa 100 cuộc họp gần nhất. Chọn phiên rồi bấm Watch transcript.' : 'Chưa có cuộc họp. Gửi Bot từ TINA Terminal rồi Refresh meetings.';
  } catch (error) {
    if (request.signal.aborted || scope !== `${cfg.botGatewayUrl}|${cfg.apiKey}` || transcriptSource !== 'bot') return;
    resetBot(true); botMeeting = null; botMeetings = []; ($('botMeeting') as HTMLSelectElement).replaceChildren();
    $('botNotice').textContent = error instanceof Error ? error.message : 'Không tải được cuộc họp.';
  }
  renderBot();
}

function setTranscriptSource(source: string): void {
  resetBot(true); botListRequest?.abort(); disconnectFeed();
  transcriptSource = source === 'bot' ? 'bot' : 'capture';
  ($('transcriptSource') as HTMLSelectElement).value = transcriptSource;
  $('botPicker').hidden = transcriptSource !== 'bot';
  mgr.clear(); canonicalText.clear(); seenTranscriptRevisions.clear(); feedScope = ''; transcriptFault = null;
  txSegs = []; transcriptFeed.reset(); feedStatus('');
  chrome.storage.local.set({ transcriptSource });
  if (transcriptSource === 'bot') { renderBot(); void refreshBotMeetings(); }
  else { $('dashBtn').textContent = 'Dashboard ↗'; $('stopBtn').textContent = '■ Stop'; applyState(state); }
}

function watchSelectedBot(): void {
  if (!botMeeting) return;
  resetBot(true); botWatching = true;
  const meeting = botMeeting;
  $('botNotice').textContent = 'Đang kết nối transcript…';
  botStop = watchBotTranscript({ botGatewayUrl: cfg.botGatewayUrl, apiKey: cfg.apiKey }, meeting,
    (rows, status, replies = []) => {
      txSegs = rows; botReplies = replies; $('botNotice').textContent = `#${meeting.id} · ${status} · Đang xem; không thu audio tại máy.`;
      renderBot();
    }, (message, denied) => {
      if (denied) { resetBot(true); botMeeting = null; botMeetings = []; ($('botMeeting') as HTMLSelectElement).replaceChildren(); }
      $('botNotice').textContent = message + (denied ? '' : ' Đang thử kết nối lại…'); renderBot();
    });
  renderBot();
}

function renderTranscription(): void {
  if (transcriptSource === 'bot') { renderBot(); return; }
  const active = isActive(state.status);
  const config = active ? state.transcription : transcriptionPreview;
  const error = active ? asrFault : previewError;
  if (error) { $('asrBackend').textContent = `ASR · ${error}`; return; }
  const source = config && ({ user: 'Personal preference', platform: 'Platform default', environment: 'Deployment environment' } as Record<string, string>)[config.source];
  $('asrBackend').textContent = config && (active || transcriptionPreview?.configured !== false) ? `ASR · ${config.label} · ${source || 'Server settings'} · ${active ? 'this session' : 'next session'}` : 'ASR · backend not reported by this server';
}

async function refreshTranscription(): Promise<void> {
  if (transcriptSource === 'bot') return;
  if (previewBusy || isActive(state.status)) return;
  previewBusy = true;
  const requestKey = `${transcriptSource}|${gatewayBase()}|${cfg.apiKey}`;
  try {
    const options = { headers: { 'X-API-Key': cfg.apiKey }, signal: AbortSignal.timeout(5000), cache: 'no-store' as const };
    let response = await fetch(`${gatewayBase()}/transcription/config`, options);
    if (response.status === 404) {
      response = await fetch(`${gatewayBase()}/user/transcription`, options);
      if (!response.ok) throw new Error('ASR settings unavailable');
      const body = await response.json();
      if (requestKey !== `${transcriptSource}|${gatewayBase()}|${cfg.apiKey}`) return;
      transcriptionPreview = body.effective;
    } else {
      if (!response.ok) throw new Error('ASR settings unavailable');
      const body = await response.json();
      if (requestKey !== `${transcriptSource}|${gatewayBase()}|${cfg.apiKey}`) return;
      transcriptionPreview = body;
    }
    previewError = transcriptionPreview?.configured === false ? 'backend is not configured' : null;
    renderTranscription();
  } catch {
    if (requestKey !== `${transcriptSource}|${gatewayBase()}|${cfg.apiKey}`) return;
    transcriptionPreview = undefined;
    previewError = 'settings unavailable — check the server connection or API key';
    renderTranscription();
  } finally { previewBusy = false; }
}

let captureStartMs: number | null = null;

// ── Live transcript — rendered INLINE, the 0.11 way ─────────────
// Feed the desktop gateway's /ws through the SAME grouping brick the 0.11 dashboard
// uses (@tina/transcript-rendering, vendored): dedup + speaker-grouped turns.
type Seg = TranscriptSegment & { revision?: number; canonical_revision?: number; canonical_text?: string };
const mgr = createTranscriptManager<Seg>();
let txSegs: Seg[] = [];
let txWs: WebSocket | null = null;
// Map a transcript.v1 segment (start in seconds) → the brick's shape (absolute ISO time).
function toBrickSeg(s: any): Seg {
  const origin = normalizeDeployment(cfg.deployment) === 'desktop' ? 0 : (state.startedAt ?? captureStartMs ?? Date.now());
  const start = Number.isFinite(Date.parse(s.absolute_start_time)) ? Date.parse(s.absolute_start_time) : origin + (s.start ?? 0) * 1000;
  const end = Number.isFinite(Date.parse(s.absolute_end_time)) ? Date.parse(s.absolute_end_time) : origin + (s.end ?? s.start ?? 0) * 1000;
  return { ...s, start_time: s.start, end_time: s.end, absolute_start_time: new Date(start).toISOString(), absolute_end_time: new Date(end).toISOString() };
}

// Deployment-aware gateway base for this panel: the chosen preset's gateway
// unless an explicit gatewayUrl overrides it (the SAME rule the background uses).
function gatewayBase(): string {
  return resolveEndpoints(cfg).gatewayUrl.replace(/\/+$/, '');
}

let displaySessionId: string | null = null;
let displayMeetingId: number | null = null;
const transcriptFeed = createTranscriptFeed($('feed'), $('transcriptTurns'), $('latestBtn') as HTMLButtonElement, {
  load: (id, signal) => { if (!botMeeting) throw new Error('No Bot meeting'); return readBotVoiceSources({ botGatewayUrl: cfg.botGatewayUrl, apiKey: cfg.apiKey }, botMeeting.id, id, signal); },
  url: (id, index) => botBase(cfg.terminalUrl) + `/meetings/${botMeeting!.id}?voiceSource=${encodeURIComponent(id)}#voice-source-${id}-${index}`,
});
let feedKey = '';
let feedScope = '';
let transcriptFault: string | null = null;
let feedCleanup = () => {};
const canonicalText = new Map<string, { text: string; revision: number }>();
const seenTranscriptRevisions = new Map<string, number>();
function protectCanonical(segment: Seg): Seg {
  const accepted = segment.segment_id && canonicalText.get(segment.segment_id);
  return accepted ? { ...segment, ...accepted, completed: true } : segment;
}
function applyCanonicalSnapshot(rows: Seg[], replace = true): void {
  const confirmed = mgr.getState().confirmed;
  if (replace) confirmed.clear();
  const present = new Set(rows.map(s => s.segment_id));
  if (replace) for (const id of canonicalText.keys()) if (!present.has(id)) canonicalText.delete(id);
  for (const row of rows) {
    const revision = row.canonical_revision ?? row.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid canonical revision');
    if (row.segment_id && revision > (canonicalText.get(row.segment_id)?.revision ?? 0))
      canonicalText.set(row.segment_id, { text: row.canonical_text ?? row.text, revision });
    const segment = protectCanonical({ ...row, text: row.canonical_text ?? row.text, completed: true });
    confirmed.set(segment.segment_id || segment.absolute_start_time, segment);
  }
  // Only a draft of an already accepted edited segment is stale; unrelated drafts stay visible.
  for (const [speaker, pending] of mgr.getState().pendingBySpeaker)
    mgr.getState().pendingBySpeaker.set(speaker, pending.filter(s => !s.segment_id || !canonicalText.has(s.segment_id) && !present.has(s.segment_id)));
  txSegs = mgr.getSegments(); renderFeed();
}
function connectFeed(): void {
  if (transcriptSource === 'bot') return;
  if (!state.platform || !state.nativeMeetingId) return;
  const base = gatewayBase();
  const apiKey = cfg.apiKey;
  const key = `${state.platform}/${state.nativeMeetingId}`;
  const identity = `${base}|${apiKey}|${displaySessionId ?? key}`;
  if (feedKey === identity && txWs && (txWs.readyState === WebSocket.OPEN || txWs.readyState === WebSocket.CONNECTING)) return;
  disconnectFeed(); feedKey = identity;
  if (feedScope !== identity) {
    feedScope = identity; canonicalText.clear(); seenTranscriptRevisions.clear(); transcriptFault = null;
    displayMeetingId = state.meetingId ?? null; mgr.clear(); txSegs = []; transcriptFeed.reset();
  }
  const path = `/transcripts/${encodeURIComponent(state.platform)}/${encodeURIComponent(state.nativeMeetingId)}`;
  const endpoint = new URL(base.replace(/^http/, 'ws') + '/ws');
  if (apiKey) endpoint.searchParams.set('api_key', apiKey);
  const socket = new WebSocket(endpoint.toString()); txWs = socket;
  const current = () => txWs === socket && feedKey === identity;
  const queued: any[] = []; let loading = false, refreshAgain = false;
  let refreshTask: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  feedCleanup = () => { if (retry) clearTimeout(retry); request?.abort(); };
  const refreshCanonical = (): void => {
    refreshAgain = true;
    if (refreshTask || !current()) return;
    if (retry) { clearTimeout(retry); retry = undefined; }
    refreshTask = (async () => {
      while (refreshAgain && current()) {
        refreshAgain = false; loading = true; let failed = false;
        request = new AbortController();
        const timeout = setTimeout(() => request?.abort(), 5000);
        try {
          const response = await fetch(`${base}${path}`, { headers: { 'X-API-Key': apiKey }, cache: 'no-store', signal: request.signal });
          if (!response.ok) throw new Error(`Transcript history unavailable (${response.status})`);
          const body = await response.json();
          if (!current()) return;
          const id = state.meetingId ?? displayMeetingId;
          const snapshotId = body.meeting_id ?? body.id;
          if ((body.platform && body.platform !== state.platform) || (body.native_meeting_id && body.native_meeting_id !== state.nativeMeetingId)
              || (id != null && snapshotId != null && snapshotId !== id) || !Array.isArray(body.segments)) throw new Error('Transcript snapshot does not match this meeting');
          const rows = body.segments.map((s: Seg) => {
            if (typeof s.text !== 'string' || (s.canonical_text != null && typeof s.canonical_text !== 'string')) throw new Error('Invalid canonical text');
            const row = toBrickSeg(s), revision = row.canonical_revision ?? row.revision ?? 0;
            if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid canonical revision');
            return row;
          });
          if (Number.isSafeInteger(snapshotId)) displayMeetingId = snapshotId;
          applyCanonicalSnapshot(rows);
          const previousFault = transcriptFault; transcriptFault = null;
          if (previousFault && $('feedStatus').textContent === previousFault) feedStatus('');
        } catch (error: any) {
          if (!current()) return;
          failed = true; transcriptFault = 'Canonical transcript chưa đồng bộ; đang thử lại.'; feedStatus(transcriptFault, true);
        } finally {
          clearTimeout(timeout); request = null; loading = false;
          if (current()) for (const message of queued.splice(0)) {
            try { receive(message); } catch { /* One malformed frame must not discard the remaining updates. */ }
          }
        }
        if (failed) { retry = setTimeout(() => { retry = undefined; refreshCanonical(); }, 1000); return; }
      }
    })().finally(() => { refreshTask = null; });
  };
  let lastUiMetricAt = 0;
  const receive = (message: any) => {
    const received = globalThis.performance?.now() ?? Date.now();
    if (message.type === 'speaker.revised') {
      const id = state.meetingId ?? displayMeetingId;
      if (message.version !== 'speaker-revision.v1' || message.platform !== state.platform || message.native_meeting_id !== state.nativeMeetingId
          || !Number.isSafeInteger(message.meeting_id) || message.meeting_id < 1 || id != null && message.meeting_id !== id
          || typeof message.speaker_id !== 'string' || !Number.isSafeInteger(message.revision) || message.revision < 1) return;
      const key = 'speaker:' + message.speaker_id;
      if (message.revision <= (seenTranscriptRevisions.get(key) ?? 0)) return;
      seenTranscriptRevisions.set(key, message.revision); refreshCanonical(); return;
    }
    if (message.type === 'transcript.revised') {
      const id = state.meetingId ?? displayMeetingId;
      if (message.version !== 'transcript-revision.v1' || message.platform !== state.platform || message.native_meeting_id !== state.nativeMeetingId
          || !Number.isSafeInteger(message.meeting_id) || message.meeting_id < 1 || (id != null && message.meeting_id !== id) || typeof message.segment_id !== 'string' || !message.segment_id
          || !Number.isSafeInteger(message.revision) || message.revision < 1 || message.revision <= (seenTranscriptRevisions.get(message.segment_id) ?? 0)) return;
      seenTranscriptRevisions.set(message.segment_id, message.revision); refreshCanonical(); return;
    }
    if (message.meeting && (typeof message.meeting === 'string' ? message.meeting !== key : message.meeting.id !== (state.meetingId ?? displayMeetingId))) return;
    if (message.type === 'health') {
      if (message.kind === 'language_review') {
        const link = $('languageReview') as HTMLAnchorElement; link.href = `${base}${path}/review`; link.hidden = false;
      } else if (message.source === 'stt') { asrFault = message.detail || message.kind || 'transcription failed'; renderTranscription(); }
      return;
    }
    if (message.type === 'transcript_retract') {
      const ids = message.segment_ids || [];
      mgr.handleMessage({ type: 'transcript_retract', segment_ids: ids.filter((id: string) => !canonicalText.has(id)) });
      if (ids.some((id: string) => canonicalText.has(id))) refreshCanonical();
    }
    else if (message.type === 'transcript') {
      const confirmed: Seg[] = (message.confirmed || []).map((s: Seg) => protectCanonical(toBrickSeg({ ...s, completed: true })));
      if (!Array.isArray(message.pending)) {
        // A metadata repaint has no draft snapshot; legacy final ticks may be partial.
        // Merge by stable segment ID without dropping unrelated confirmed rows or drafts.
        if (confirmed.some(s => s.text?.trim())) { asrFault = null; renderTranscription(); }
        applyCanonicalSnapshot(confirmed, false); return;
      }
      const pending = (message.pending || []).filter((s: Seg) => !s.segment_id || !canonicalText.has(s.segment_id)).map((s: Seg) => toBrickSeg({ ...s, completed: false }));
      if ([...confirmed, ...pending].some(s => s.text?.trim())) { asrFault = null; renderTranscription(); }
      mgr.handleMessage({ type: 'transcript', speaker: message.speaker || pending[0]?.speaker || confirmed[0]?.speaker, confirmed, pending });
    } else return;
    txSegs = mgr.getSegments(); renderFeed();
    if (!document.hidden && Date.now() - lastUiMetricAt >= 5000) {
      lastUiMetricAt = Date.now();
      const commit = (globalThis.performance?.now() ?? Date.now()) - received;
      const report = (frame?: number) => {
        if (!current() || document.hidden) return;
        const server = typeof message.ts === 'string' ? Date.parse(message.ts) : NaN;
        const values = { ui_commit_ms: commit, ...(frame == null ? {} : {ui_frame_ms: frame}),
          ...(Number.isFinite(server) && Date.now() >= server ? {server_to_ui_ms: Date.now()-server} : {}) };
        void fetch(`${base}${path}/metrics`, {method:'POST',headers:{'Content-Type':'application/json','X-API-Key':cfg.apiKey},
          body:JSON.stringify(values),signal:AbortSignal.timeout(2000)}).catch(()=>{});
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(()=>requestAnimationFrame(()=>report((globalThis.performance?.now() ?? Date.now())-received)));
      else report();
    }
  };
  socket.onopen = () => {
    if (!current()) return;
    socket.send(JSON.stringify({ action: 'subscribe', meetings: [{ platform: state.platform, native_id: state.nativeMeetingId }] }));
    refreshCanonical();
  };
  socket.onmessage = event => {
    if (!current()) return;
    try {
      const message = JSON.parse(event.data);
      if (loading) { if (queued.length >= 1024) { socket.close(); return; } queued.push(message); }
      else receive(message);
    } catch { /* Ignore malformed frames. */ }
  };
  socket.onclose = () => { if (current()) { txWs = null; feedCleanup(); transcriptFault = 'Transcript connection interrupted; reconnecting…'; feedStatus(transcriptFault, true); } };
  socket.onerror = () => { if (current()) feedStatus('Transcript connection error; reconnecting…', true); };
}
function disconnectFeed(): void { const socket = txWs; txWs = null; feedKey = ''; feedCleanup(); feedCleanup = () => {}; socket?.close(); }

// ── Config ──────────────────────────────────────────────────────

async function loadConfig(): Promise<void> {
  const stored = await chrome.storage.local.get([...FIELDS, 'autoStart', 'transcriptSource']);
  for (const f of FIELDS) {
    cfg[f] = stored[f] || DEFAULTS[f] || '';
    ($(f) as HTMLInputElement).value = cfg[f];
  }
  // Deployment is a closed set — normalize any unknown/legacy stored value.
  cfg.deployment = normalizeDeployment(cfg.deployment);
  ($('deployment') as HTMLSelectElement).value = cfg.deployment;
  const dashboard = dashboardOverride(cfg);
  if (dashboard !== cfg.dashboardUrl) {
    cfg.dashboardUrl = dashboard;
    ($('dashboardUrl') as HTMLInputElement).value = dashboard;
    await chrome.storage.local.set({ dashboardUrl: dashboard });
  }
  ($('autoStart') as HTMLInputElement).checked = stored.autoStart !== false;
  if (stored.transcriptSource === 'bot') setTranscriptSource('bot');
}

function bindSettings(): void {
  for (const f of FIELDS) {
    $(f).addEventListener('change', () => {
      cfg[f] = ($(f) as HTMLInputElement).value.trim();
      chrome.storage.local.set({ [f]: cfg[f] });
      if (transcriptSource === 'bot') {
        if (f === 'apiKey' || f === 'botGatewayUrl') {
          resetBot(true); botMeeting = null; botMeetings = []; ($('botMeeting') as HTMLSelectElement).replaceChildren();
          renderBot(); void refreshBotMeetings();
        }
        return;
      }
      if (f === 'apiKey' || f === 'gatewayUrl' || f === 'deployment') { transcriptionPreview = undefined; void refreshTranscription(); }
      // Re-verify when anything that changes the resolved gateway changes — the
      // deployment preset OR an explicit gateway override OR the key.
      if (f === 'apiKey' || f === 'gatewayUrl' || f === 'deployment') verifyConnection();
    });
  }
  $('autoStart').addEventListener('change', () =>
    chrome.storage.local.set({ autoStart: ($('autoStart') as HTMLInputElement).checked }));
}

async function verifyConnection(): Promise<void> {
  if (transcriptSource === 'bot') { $('connText').textContent = 'Meeting Bot access is checked when loading meetings.'; return; }
  if (connectionBusy) return;
  connectionBusy = true;
  const requestKey = `${transcriptSource}|${gatewayBase()}|${cfg.apiKey}`;
  const row = $('connRow'), text = $('connText');
  row.classList.remove('ok');
  if (!cfg.apiKey) { text.textContent = 'No API key set'; connectionBusy = false; return; }
  text.textContent = 'Checking…';
  void refreshTranscription();
  try {
    const resp = await fetch(`${gatewayBase()}/bots`, { headers: { 'X-API-Key': cfg.apiKey }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (requestKey !== `${transcriptSource}|${gatewayBase()}|${cfg.apiKey}`) return;
    if (resp.ok) { row.classList.add('ok'); text.textContent = 'Gateway connected'; }
    else text.textContent = `Gateway responded ${resp.status}`;
  } catch {
    if (requestKey === `${transcriptSource}|${gatewayBase()}|${cfg.apiKey}`) text.textContent = 'Gateway unreachable';
  } finally { connectionBusy = false; }
}

// ── Background sync (capture state) ─────────────────────────────

function feedStatus(text: string, isError = false): void {
  const el = $('feedStatus');
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
  el.style.color = isError ? 'var(--destructive)' : 'var(--muted-foreground)';
  console.log(`[tina-panel] ${text}`);
}

function renderFeed(): void {
  const hasTranscript = txSegs.some(segment => segment.text?.trim()) || transcriptSource === 'bot' && botReplies.length > 0;
  $('emptyState').hidden = hasTranscript;
  if (transcriptSource === 'bot') {
    transcriptFeed.render(txSegs, 'Bản nháp · Bot đang nhận dạng…', 'vi', [], false, botReplies);
    $('captureNotice').hidden = true;
    $('emptyText').textContent = botWatching ? 'Đang chờ transcript từ Bot…' : 'Chọn cuộc họp rồi bấm Watch transcript.';
    return;
  }
  const running = isActive(state.status) && state.status !== 'stopping';
  transcriptFeed.render(txSegs, running && !state.paused ? 'Đang nhận dạng…' : 'Bản nháp · chưa chốt');
  let notice = '';
  if (state.error === 'mic-permission') notice = 'Cần quyền microphone để bắt đầu thu.';
  else if (state.error) notice = state.error;
  else if (state.status === 'stopping') notice = 'Đang dừng thu và lưu các đoạn cuối…';
  else if (state.paused) notice = 'Đã tạm dừng thu · bấm Resume để tiếp tục.';
  else if (state.status === 'connecting') notice = 'Đang kết nối · transcript hiện có được giữ lại.';
  else if (state.status === 'starting') notice = 'Đã kết nối · đang chờ âm thanh.';
  else if (state.status === 'no-signal') notice = 'Chưa nhận được âm thanh từ cuộc họp.';
  else if (state.status === 'idle' && hasTranscript) notice = 'Đã dừng thu · transcript được giữ lại.';
  const banner = $('captureNotice');
  if ($('captureNoticeText').textContent !== notice) $('captureNoticeText').textContent = notice;
  banner.hidden = !notice; banner.dataset.error = String(state.status === 'error');
  $('micGrantBtn').hidden = state.error !== 'mic-permission';
  $('emptyText').textContent = state.status === 'capturing' && !state.paused
    ? 'Đang thu âm thanh · transcript sẽ xuất hiện tại đây.' : 'Bắt đầu thu để xem transcript tại đây.';
}

function applyState(s: PanelState): void {
  ($('transcriptSource') as HTMLSelectElement).disabled = isActive(s.status) || !!s.pendingAudioFrames;
  if (transcriptSource === 'bot') {
    state = s;
    if (isActive(s.status) || s.pendingAudioFrames) { setTranscriptSource('capture'); return; }
    renderBot(); return;
  }
  const newSession = !!s.sessionId && s.sessionId !== displaySessionId;
  if (newSession || s.platform !== state.platform || s.nativeMeetingId !== state.nativeMeetingId) {
    $('languageReview').hidden = true; asrFault = null; disconnectFeed(); mgr.clear(); txSegs = []; transcriptFeed.reset();
    displaySessionId = s.sessionId ?? null; displayMeetingId = null;
  }
  if (s.meetingId != null) displayMeetingId = s.meetingId;
  state = s;
  for (const field of ['apiKey', 'deployment', 'ingestUrl', 'gatewayUrl']) ($(field) as HTMLInputElement).disabled = isActive(s.status) || !!s.pendingAudioFrames;
  renderTranscription();
  if (s.status !== 'stopping' && (isActive(s.status) || txSegs.length || s.startedAt)) connectFeed();

  // Stale-background guard: if the running service worker loaded an older build
  // than this panel, capture-control code is out of date. Surface a blocking
  // banner with a one-click forced reload.
  const newerOnDisk = s.diskBuild && s.swBuild && s.diskBuild !== s.swBuild;
  const staleBuild = newerOnDisk || (s.swBuild && panelBuild && s.swBuild !== panelBuild);
  if (staleBuild) {
    const el = $('feedStatus');
    el.style.display = 'block';
    el.style.color = 'var(--destructive)';
    el.innerHTML = `⚠ Background is running an old build — fixes won't apply. `
      + `<button class="btn" id="reloadSwBtn" style="display:inline-block;padding:3px 10px;font-size:12px;margin-left:6px;">Reload now</button>`
      + `<div style="margin-top:6px;font-size:11px;opacity:.85;">After it reloads, also refresh the meeting tab (Cmd/Ctrl+R) — an extension reload orphans the page's capture scripts.</div>`;
    const b = document.getElementById('reloadSwBtn');
    if (b && !(b as any).__wired) {
      (b as any).__wired = true;
      b.addEventListener('click', async () => {
        const result = await chrome.runtime.sendMessage({ type: 'RELOAD_NOW' });
        if (!result?.ok) feedStatus(result?.error || 'Reload failed');
      });
    }
  }
  const pill = $('statusPill'), pillText = $('statusText');
  pill.classList.toggle('live', s.status === 'capturing' && !s.paused);
  pillText.textContent =
    s.status === 'capturing' ? (s.paused ? 'Paused' : 'LIVE')
    : s.status === 'starting' ? 'Starting…'
    : s.status === 'no-signal' ? 'No signal'
    : s.status === 'connecting' ? 'Connecting'
    : s.status === 'stopping' ? 'Stopping…'
    : s.status === 'error' ? 'Error'
    : 'Idle';
  const toggle = $('toggleBtn') as HTMLButtonElement;
  const stopBtn = $('stopBtn') as HTMLButtonElement;
  toggle.disabled = s.status === 'stopping'; stopBtn.disabled = s.status === 'stopping';
  if (isActive(s.status)) {
    // Live: Pause suspends (session stays alive, Resume continues the same
    // meeting); Stop ends it. Two distinct verbs, two buttons.
    toggle.innerHTML = s.paused ? '&#9654; Resume' : '&#10074;&#10074; Pause';
    toggle.classList.remove('danger');
    stopBtn.style.display = '';
  } else {
    toggle.textContent = s.pendingAudioFrames ? 'Retry audio delivery' : '▶ Start';
    toggle.classList.remove('danger');
    stopBtn.style.display = 'none';
  }

  const bar = $('meetingBar');
  if (s.platform && s.nativeMeetingId && (s.status !== 'idle' || txSegs.length)) {
    bar.style.display = 'flex';
    const p = PLATFORMS[s.platform] || { name: s.platform, color: '#8e8e8e' };
    ($('platDot') as HTMLElement).style.background = p.color;
    $('platName').textContent = p.name;
    $('meetingCode').textContent = s.nativeMeetingId;
  } else {
    bar.style.display = 'none';
  }

  if (s.status === 'capturing' && s.nativeMeetingId) {
    captureStartMs = s.startedAt ?? captureStartMs ?? Date.now();
  } else if (s.status === 'idle') {
    captureStartMs = null;
  }

  if (!staleBuild) feedStatus(transcriptFault || '', !!transcriptFault);
  renderFeed();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS' && msg.state) applyState(msg.state as PanelState);
});
setInterval(() => void verifyConnection(), 10000);

async function pollStatus(): Promise<void> {
  const resp = await chrome.runtime.sendMessage({ type: 'STATUS' }).catch(() => null);
  if (resp && resp.state) applyState(resp.state as PanelState);
}

// ── Rendering helpers ───────────────────────────────────────────


function openDashboard(): void {
  if (transcriptSource === 'bot') {
    try { chrome.tabs.create({ url: botBase(cfg.terminalUrl) + (botMeeting ? `/meetings/${botMeeting.id}` : '') }); }
    catch { $('botNotice').textContent = 'Đặt TINA Terminal URL hợp lệ trong Settings.'; }
    return;
  }
  try { chrome.tabs.create({ url: resolveDashboardUrl(cfg, state) }); }
  catch { feedStatus('Dashboard URL không hợp lệ. Kiểm tra trong Settings.'); }
}

// ── UI wiring ───────────────────────────────────────────────────

function showSettings(show: boolean): void {
  $('settings').style.display = show ? 'flex' : 'none';
  $('transcriptPane').style.display = show ? 'none' : 'flex';
  if (!show) transcriptFeed.reveal();
  $('meetingBar').style.display = show || transcriptSource === 'bot' ? 'none' : (state.platform && (state.status !== 'idle' || txSegs.length) ? 'flex' : 'none');
  if (show) verifyConnection();
}

// ── Theme (System / Light / Dark) ───────────────────────────────
type Theme = 'system' | 'light' | 'dark';
const THEME_ORDER: Theme[] = ['system', 'light', 'dark'];
const THEME_ICON: Record<Theme, string> = { system: '☾', light: '☀', dark: '☽' };
const darkMql = window.matchMedia('(prefers-color-scheme: dark)');
let theme: Theme = 'system';

function effectiveDark(): boolean {
  return theme === 'dark' || (theme === 'system' && darkMql.matches);
}

function applyTheme(): void {
  document.documentElement.setAttribute('data-theme', effectiveDark() ? 'dark' : 'light');
  // Logo: light-colored logo on dark bg, dark-colored logo on light bg.
  const logo = document.getElementById('logo') as HTMLImageElement | null;
  if (logo) logo.src = effectiveDark() ? 'assets/tina-light.svg' : 'assets/tina-dark.svg';
  const btn = $('themeBtn');
  btn.textContent = THEME_ICON[theme];
  btn.title = `Theme: ${theme[0].toUpperCase()}${theme.slice(1)}`;
}

async function initTheme(): Promise<void> {
  const { theme: stored } = await chrome.storage.local.get('theme');
  theme = (stored as Theme) || 'system';
  applyTheme();
  // Follow OS changes only while on System.
  darkMql.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
}

$('themeBtn').addEventListener('click', () => {
  theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  chrome.storage.local.set({ theme });
  applyTheme();
});

$('gearBtn').addEventListener('click', () => showSettings($('settings').style.display !== 'flex'));
$('stopBtn').addEventListener('click', () => {
  if (transcriptSource === 'bot') { resetBot(); $('botNotice').textContent = 'Đã ngừng xem. Bot tiếp tục chạy.'; renderBot(); return; }
  chrome.runtime.sendMessage({ type: 'STOP' });
});
$('toggleBtn').addEventListener('click', async () => {
  if (transcriptSource === 'bot') { watchSelectedBot(); showSettings(false); return; }
  if (isActive(state.status)) {
    chrome.runtime.sendMessage({ type: state.paused ? 'RESUME' : 'PAUSE' });
    return;
  }
  chrome.runtime.sendMessage({ type: state.pendingAudioFrames ? 'RETRY_AUDIO' : 'START' });
  showSettings(false);
});
$('dashBtn').addEventListener('click', openDashboard);
$('transcriptSource').addEventListener('change', () => {
  if (isActive(state.status) || state.pendingAudioFrames) return;
  setTranscriptSource(($('transcriptSource') as HTMLSelectElement).value);
});
$('botMeeting').addEventListener('change', () => {
  resetBot(true); botMeeting = botMeetings.find(meeting => String(meeting.id) === ($('botMeeting') as HTMLSelectElement).value) ?? null;
  $('botNotice').textContent = 'Bấm Watch transcript để xem phiên đã chọn.'; renderBot();
});
$('botRefresh').addEventListener('click', () => void refreshBotMeetings());
$('micGrantBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') }));

// Elapsed clock
setInterval(() => {
  if (transcriptSource === 'capture' && state.status === 'capturing' && captureStartMs) {
    const s = Math.floor((Date.now() - captureStartMs) / 1000);
    $('elapsed').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
}, 1000);

// Dev auto-reload (same stamp the background watches): the MV3 service worker
// can idle out, but this page lives while the panel is open — between them the
// reload always lands.
const stampUrl = chrome.runtime.getURL('build-stamp.txt');
let knownStamp: string | null = null;
fetch(stampUrl).then(r => r.text()).then(s => { knownStamp = s; }).catch(() => { /* no stamp */ });
setInterval(async () => {
  try {
    const cur = await fetch(stampUrl, { cache: 'no-store' }).then(r => r.text());
    if (knownStamp && cur && cur !== knownStamp) {
      if (isActive(state.status) || state.pendingAudioFrames) return;
      await chrome.runtime.sendMessage({ type: 'RELOAD_NOW', idleOnly: true });
    }
  } catch { /* stamp unreadable; skip */ }
}, 2000);

(async () => {
  // Visible build identity — confirms which build is loaded after hot reload
  try {
    const raw = await fetch(stampUrl).then(r => r.text());
    const stamp = JSON.parse(raw);
    $('buildTag').textContent = `build ${stamp.human}`;
    $('buildHeader').textContent = stamp.human;
  } catch { $('buildTag').textContent = 'build unknown'; }
  await initTheme();
  await loadConfig();
  void refreshTranscription();
  bindSettings();
  await pollStatus();
  if (!cfg.apiKey) showSettings(true);
  setInterval(pollStatus, 3000);
})();
