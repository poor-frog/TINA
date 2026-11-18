import type { TranscriptSegment } from './transcript-rendering';
import { voiceReplies, voiceSources, type VoiceReply } from './voice-replies';

export interface BotConnection { botGatewayUrl: string; apiKey: string }
export interface DesktopConnection { gatewayUrl: string; apiKey: string }
export interface BotMeeting { id: number; platform: string; nativeMeetingId: string; title: string; status: string; startMs: number; joinFailureSummary?: string; autoRetry?: { state: string; attempt: number; max_attempts: number } }

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
  constructor(public status: number) { super(`Transcript API returned ${status}. Check access and the API key.`); }
}

async function readGateway(gatewayUrl: string, apiKey: string, path: string, signal?: AbortSignal, allowLocalWithoutKey = false): Promise<any> {
  const base = apiBase(gatewayUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
  if (!apiKey.trim() && (!allowLocalWithoutKey || !local)) throw new Error('Set your TINA API key in Settings.');
  const response = await fetch(base + path, {
    headers: apiKey.trim() ? { 'X-API-Key': apiKey } : {}, credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new ReadError(response.status);
  return response.json();
}

async function read(config: BotConnection, path: string, signal?: AbortSignal): Promise<any> {
  return readGateway(config.botGatewayUrl, config.apiKey, path, signal);
}

export async function readBotVoiceSources(config: BotConnection, meetingId: number, requestId: string, signal?: AbortSignal) {
  return voiceSources(await read(config, `/meetings/${meetingId}/voice-assistant/sources/${encodeURIComponent(requestId)}`, signal));
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
      autoRetry: row.data?.auto_retry && typeof row.data.auto_retry === 'object' ? row.data.auto_retry : undefined,
      joinFailureSummary: typeof row.data?.join_failure_summary === 'string' ? row.data.join_failure_summary.slice(0,300) : undefined,
    }));
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
