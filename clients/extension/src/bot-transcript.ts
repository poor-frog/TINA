import { sessionCommand, type ExtensionAccount, type SessionResult } from './extension-session';
import type { TranscriptSegment } from './transcript-rendering';
import { voiceReplies, voiceSources, type VoiceReply } from './voice-replies';

export interface BotConnection { botGatewayUrl: string; account?: ExtensionAccount; legacyKey?: string }
export interface DesktopConnection { gatewayUrl: string; apiKey: string }
export interface BotMeeting { id: number; platform: string; nativeMeetingId: string; title: string; status: string; startMs: number; shared?: boolean; joinFailureSummary?: string; autoRetry?: { state: string; attempt: number; max_attempts: number } }
export interface BotSpeakerLink { participantId: string; revision: number }
export interface BotProcessedNote {
  id: string;
  segmentId?: string;
  text: string;
  speaker?: string;
  chapter?: string;
  t?: number;
  stale: boolean;
  withdrawn: boolean;
}
export interface BotProcessedNotes {
  configured: boolean;
  enabled: boolean;
  finished: boolean;
  publicationRevision: number;
  status: 'disabled' | 'failed' | 'pending' | 'current' | 'stale' | 'unknown';
  notes: BotProcessedNote[];
}

export function apiBase(value: string): string {
  if (!value?.trim()) throw new Error('Set the API gateway in Settings.');
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Use a loopback HTTP or HTTPS gateway without credentials or query parameters.');
  return url.href.replace(/\/+$/, '');
}

export const botBase = apiBase;

class ReadError extends Error {
  constructor(public status: number, public routeMissing = false) {
    super(`Transcript API returned ${status}. Check your TINA login and meeting access.`);
  }
}

export async function botFetch(config: BotConnection, path: string, options: RequestInit = {}): Promise<Response> {
  const gateway = apiBase(config.botGatewayUrl);
  const account = config.account;
  // The separate legacy capture panel is outside the shipped Viewer build.
  if (!account && config.legacyKey?.trim()) return fetch(gateway + path, {
    ...options, headers: { ...options.headers, 'X-API-Key': config.legacyKey },
    credentials: 'omit', redirect: 'error', cache: 'no-store',
  });
  if (!account || account.gateway !== gateway) throw new ReadError(401);
  const access = (rejected?: string) => sessionCommand({ action: 'access', key: account.key, gateway, rejected });
  const send = ({ token, apiKey }: SessionResult) => {
    options.signal?.throwIfAborted();
    if (!token) throw new ReadError(401);
    return fetch(gateway + path, {
      ...options, headers: { ...options.headers, ...(apiKey ? { 'X-API-Key': token } : { Authorization: `Bearer ${token}` }) },
      credentials: 'omit', redirect: 'error', cache: 'no-store',
    });
  };
  const auth = await access();
  const response = await send(auth);
  if (auth.apiKey || response.status !== 401 || (options.method && options.method !== 'GET')) return response;
  return send(await access(auth.token));
}

async function readResponse(response: Response): Promise<any> {
  if (!response.ok) {
    const detail = response.status === 404 ? (await response.json().catch(() => null))?.detail : null;
    throw new ReadError(response.status, detail === 'Not Found');
  }
  return response.json();
}

async function readGateway(gatewayUrl: string, apiKey: string, path: string, signal?: AbortSignal, allowLocalWithoutKey = false): Promise<any> {
  const base = apiBase(gatewayUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
  if (!apiKey.trim() && (!allowLocalWithoutKey || !local)) throw new Error('Set your TINA API key in Settings.');
  return readResponse(await fetch(base + path, {
    headers: apiKey.trim() ? { 'X-API-Key': apiKey } : {}, credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000),
  }));
}

async function read(config: BotConnection, path: string, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(7000);
  return readResponse(await botFetch(config, path, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
}

export async function readBotVoiceSources(config: BotConnection, meetingId: number, requestId: string, signal?: AbortSignal) {
  return voiceSources(await read(config, `/meetings/${meetingId}/voice-assistant/sources/${encodeURIComponent(requestId)}`, signal));
}

/** Read the post-meeting report for the selected run, including older Flow annotations. */
export async function readBotRecap(config: BotConnection, meeting: BotMeeting, signal?: AbortSignal): Promise<string> {
  const row = await read(config, `/meetings/${meeting.id}`, signal);
  if (row?.id !== meeting.id || row.platform !== meeting.platform || row.native_meeting_id !== meeting.nativeMeetingId)
    throw new Error('Bản tóm tắt không khớp cuộc họp.');
  const summary = typeof row.data?.summary === 'string' ? row.data.summary : row.data?.metadata?.tina_summary;
  return typeof summary === 'string' ? summary.slice(0, 6000).trim() : '';
}

function epoch(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 100_000_000_000 ? value * 1000 : value;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

export async function listBotMeetings(config: BotConnection, signal?: AbortSignal): Promise<BotMeeting[]> {
  const body = await read(config, '/meetings?limit=100&exclude_planned=true', signal);
  if (!Array.isArray(body?.meetings)) throw new Error('Unsupported meetings response.');
  return body.meetings.filter((row: any) => Number.isSafeInteger(row.id) && row.id > 0
    && typeof row.platform === 'string' && row.platform !== 'note' && /^[a-z0-9_-]{1,48}$/i.test(row.platform)
    && typeof row.native_meeting_id === 'string' && row.native_meeting_id.length > 0 && row.native_meeting_id.length <= 512).map((row: any) => ({
      id: row.id, platform: row.platform, nativeMeetingId: row.native_meeting_id,
      title: typeof row.data?.title === 'string' ? row.data.title : row.native_meeting_id,
      status: typeof row.status === 'string' ? row.status : 'unknown', startMs: epoch(row.start_time),
      shared: typeof row.shared === 'boolean' ? row.shared : undefined,
      autoRetry: row.data?.auto_retry && typeof row.data.auto_retry === 'object' ? row.data.auto_retry : undefined,
      joinFailureSummary: typeof row.data?.join_failure_summary === 'string' ? row.data.join_failure_summary.slice(0,300) : undefined,
    }));
}

/** A spawn conflict can mean the room already has this account's bot, or that the spawn was refused. */
export async function hasOwnedBotInRoom(config: BotConnection, room: Pick<BotMeeting, 'platform' | 'nativeMeetingId'>): Promise<boolean> {
  const meetings = await listBotMeetings(config).catch(() => []);
  const roomId = (id: string) => room.platform === 'google_meet' ? id.toLowerCase() : id;
  return meetings.some(meeting => meeting.shared === false && meeting.platform === room.platform
    && roomId(meeting.nativeMeetingId) === roomId(room.nativeMeetingId)
    && ['requested', 'joining', 'awaiting_admission', 'active'].includes(meeting.status.toLowerCase()));
}

/** Read existing processed notes for this exact meeting row, without enabling generation. */
export async function readBotProcessedNotes(config: BotConnection, meetingId: number, signal?: AbortSignal): Promise<BotProcessedNotes> {
  if (!Number.isSafeInteger(meetingId) || meetingId < 1) throw new Error('Invalid meeting identity.');
  let body;
  try {
    body = await read(config, `/transcripts/by-id/${meetingId}/processed-notes`, signal);
  } catch (error) {
    if (error instanceof ReadError && error.routeMissing)
      throw new Error('TINA Gateway chưa hỗ trợ processed-notes. Cập nhật Gateway rồi thử lại.');
    throw error;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Unsupported processed-notes response.');
  const view = body.view && typeof body.view === 'object' && body.view.id === 'copilot-notes' ? body.view : null;
  const rawNotes = view?.doc?.notes;
  const notes = Array.isArray(rawNotes) ? rawNotes.filter((note: any) => note && typeof note === 'object' && !Array.isArray(note)
    && typeof note.id === 'string' && note.id.trim().length > 0 && note.id.length <= 256
    && typeof note.text === 'string' && note.text.length <= 16000 && (note.text.trim() || note.withdrawn === true))
    .map((note: any): BotProcessedNote => ({
      id: note.id.trim(), text: note.text,
      segmentId: Array.isArray(note.evidence) && typeof note.evidence[0]?.segment_id === 'string'
        && note.evidence[0].segment_id.length <= 256 && note.evidence[0].segment_id.trim()
        ? note.evidence[0].segment_id : note.id.trim(),
      ...(typeof note.speaker === 'string' ? { speaker: note.speaker.slice(0, 128) } : {}),
      ...(typeof note.chapter === 'string' ? { chapter: note.chapter.slice(0, 512) } : {}),
      ...(typeof note.t === 'number' && Number.isFinite(note.t) ? { t: note.t } : {}),
      stale: note.stale === true, withdrawn: note.withdrawn === true,
    })) : [];
  const rawStatus = view?.status;
  const status: BotProcessedNotes['status'] = ['disabled', 'failed', 'pending', 'current', 'stale'].includes(rawStatus)
    ? rawStatus : body.enabled === true ? 'pending' : 'disabled';
  return {
    configured: body.configured === true, enabled: body.enabled === true, finished: body.finished === true,
    publicationRevision: Number.isSafeInteger(body.publication_revision) && body.publication_revision >= 0 ? body.publication_revision : 0,
    status, notes,
  };
}

/** Stop the exact Bot run associated with a platform/native meeting identity. */
export async function stopBotMeeting(config: BotConnection, meeting: Pick<BotMeeting, 'platform' | 'nativeMeetingId'>,
  signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(15000);
  const response = await botFetch(config, `/bots/${encodeURIComponent(meeting.platform)}/${encodeURIComponent(meeting.nativeMeetingId)}`, {
    method: 'DELETE',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Sign in again to use TINA.');
    if (response.status === 403) throw new Error('This account cannot manage bots in this meeting.');
    throw new Error(`Could not stop the TINA Bot (${response.status}).`);
  }
}

/** Desktop's /bots response is an account-authorized SQLite archive listing. */
export async function listDesktopMeetings(config: DesktopConnection, signal?: AbortSignal): Promise<BotMeeting[]> {
  const body = await readGateway(config.gatewayUrl, config.apiKey, '/bots', signal, true);
  if (!Array.isArray(body?.meetings)) throw new Error('Unsupported Desktop archive response.');
  return body.meetings.filter((row: any) => Number.isSafeInteger(row.id) && row.id > 0
    && typeof row.platform === 'string' && /^[a-z0-9_-]{1,48}$/i.test(row.platform)
    && typeof row.native_meeting_id === 'string' && row.native_meeting_id.length > 0 && row.native_meeting_id.length <= 512)
    .map((row: any) => ({
      id: row.id, platform: row.platform, nativeMeetingId: row.native_meeting_id,
      title: typeof row.title === 'string' ? row.title : typeof row.data?.title === 'string' ? row.data.title : row.native_meeting_id,
      status: typeof row.status === 'string' ? row.status : 'unknown', startMs: epoch(row.start_time),
    }))
    .sort((a: BotMeeting, b: BotMeeting) => b.startMs - a.startMs).slice(0, 100);
}

export function botSegments(body: any, meeting: BotMeeting): TranscriptSegment[] {
  if (!body || body.id !== meeting.id || body.platform !== meeting.platform || body.native_meeting_id !== meeting.nativeMeetingId
      || !Array.isArray(body.segments)) throw new Error('Transcript does not match the selected meeting.');
  const rows = new Map<string, TranscriptSegment>();
  for (const [index, row] of body.segments.entries()) {
    if (!row || row.segment_id != null && typeof row.segment_id !== 'string' || typeof row.text !== 'string'
        || row.canonical_text != null && typeof row.canonical_text !== 'string'
        || row.revision != null && (!Number.isSafeInteger(row.revision) || row.revision < 0))
      throw new Error('Unsupported transcript segment.');
    const absolute = (value: unknown, seconds: unknown) => {
      const time = epoch(value);
      if (Number.isFinite(time)) return new Date(time).toISOString();
      const relative = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0;
      const start = epoch(body.start_time);
      const origin = relative > 100_000_000 ? 0 : Number.isFinite(start) ? start : meeting.startMs;
      if (!Number.isFinite(origin)) throw new Error('Transcript has no valid audio timestamp.');
      return new Date(origin + relative * 1000).toISOString();
    };
    // Legacy API rows can omit IDs; this fallback is only a local render key, never written back.
    const id = row.segment_id || `legacy:${meeting.id}:${index}`;
    rows.set(id, { ...row, segment_id: id, text: row.canonical_text ?? row.text,
      speaker: typeof row.speaker === 'string' ? row.speaker : '', completed: row.completed !== false,
      start_time: row.start, end_time: row.end,
      absolute_start_time: absolute(row.absolute_start_time, row.start),
      absolute_end_time: absolute(row.absolute_end_time, row.end ?? row.start) });
  }
  return [...rows.values()].sort((a, b) => Date.parse(a.absolute_start_time) - Date.parse(b.absolute_start_time));
}

export async function readBotTranscript(config: BotConnection, meeting: BotMeeting): Promise<TranscriptSegment[]> {
  return botSegments(await read(config, `/transcripts/by-id/${meeting.id}`), meeting);
}

export async function readBotSpeakerLinks(config: BotConnection, meetingId: number, signal: AbortSignal): Promise<Map<string, BotSpeakerLink>> {
  const links = new Map<string, BotSpeakerLink>();
  let body;
  try {
    body = await read(config, `/transcripts/by-id/${meetingId}/speakers`, signal);
  } catch (error) {
    if (error instanceof ReadError && [401, 403, 404].includes(error.status)) return links;
    throw error;
  }
  if (body?.meeting_id !== meetingId || !Array.isArray(body.speakers)) return links;
  for (const row of body.speakers) {
    if (row?.source !== 'meet_dom' || row.status !== 'observed'
        || typeof row.speaker_id !== 'string' || !row.speaker_id || row.speaker_id.length > 128
        || typeof row.participant_id !== 'string' || !row.participant_id || row.participant_id.length > 512
        || !Number.isSafeInteger(row.revision) || row.revision < 1) continue;
    links.set(row.speaker_id, { participantId: row.participant_id, revision: row.revision });
  }
  return links;
}

// shortcut: poll full snapshots; use an exact-row delta feed when transcript size or concurrent viewers justify it.
/** Exact-row snapshots include Redis drafts and canonical edits, independently of Agent availability. */
export function watchBotTranscript(config: BotConnection, meeting: BotMeeting,
  update: (rows: TranscriptSegment[], status: string, replies?: VoiceReply[], voiceStatus?: unknown) => void, error: (message: string, denied: boolean) => void): () => void {
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let replies: VoiceReply[] = [], voiceInFlight = false;
  let voiceStatus: unknown;
  let snapshot: { rows: TranscriptSegment[]; status: string } | undefined;
  const refreshVoice = async () => {
    voiceInFlight = true;
    try {
      const voice = await read(config, `/meetings/${meeting.id}/voice-assistant`, request.signal);
      replies = voiceReplies(voice.replies);
      voiceStatus = voice;
    } catch { replies = []; voiceStatus = null; /* Voice permissions/outages never block the transcript feed. */ }
    finally {
      voiceInFlight = false;
      if (!request.signal.aborted && snapshot) update(snapshot.rows, snapshot.status, replies, voiceStatus);
    }
  };
  const poll = async () => {
    let retry = 1500;
    try {
      const body = await read(config, `/transcripts/by-id/${meeting.id}`, request.signal);
      const rows = botSegments(body, meeting);
      snapshot = { rows, status: typeof body.status === 'string' ? body.status : meeting.status };
      if (!request.signal.aborted) {
        update(rows, snapshot.status, replies, voiceStatus);
        if (meeting.platform === 'google_meet' && !voiceInFlight) void refreshVoice();
      }
    } catch (failure) {
      if (request.signal.aborted) return;
      const denied = failure instanceof ReadError && [401, 403, 404, 410].includes(failure.status);
      error(failure instanceof Error ? failure.message : 'Transcript unavailable.', denied);
      if (denied) { request.abort(); return; }
      retry = 3000;
    }
    if (!request.signal.aborted) timer = setTimeout(poll, retry);
  };
  void poll();
  return () => { request.abort(); if (timer) clearTimeout(timer); };
}

/** Read-only Desktop archive snapshots; exact platform/native IDs avoid cross-store numeric IDs. */
export function watchDesktopTranscript(config: DesktopConnection, meeting: BotMeeting,
  update: (rows: TranscriptSegment[], status: string) => void, error: (message: string, denied: boolean) => void): () => void {
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const path = `/transcripts/${encodeURIComponent(meeting.platform)}/${encodeURIComponent(meeting.nativeMeetingId)}`;
  const poll = async () => {
    let retry = 1500;
    try {
      const body = await readGateway(config.gatewayUrl, config.apiKey, path, request.signal, true);
      const rows = botSegments(body, meeting);
      if (!request.signal.aborted) update(rows, typeof body.status === 'string' ? body.status : meeting.status);
    } catch (failure) {
      if (request.signal.aborted) return;
      const denied = failure instanceof ReadError && [401, 403, 404, 410].includes(failure.status);
      error(failure instanceof Error ? failure.message : 'Transcript unavailable.', denied);
      if (denied) return;
      retry = 3000;
    }
    if (!request.signal.aborted) timer = setTimeout(poll, retry);
  };
  void poll();
  return () => { request.abort(); if (timer) clearTimeout(timer); };
}
