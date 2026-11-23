import { botFetch, type BotConnection } from './bot-transcript';
import type { TranscriptSegment } from './transcript-rendering';

export type TranscriptLanguage = 'vi' | 'en' | 'bilingual';
export interface TranslationGroup {
  group_id: string; members: { segment_id: string; source_text: string; revision?: number }[];
  source_text: string; translated_text: string | null; ready: boolean;
  speaker_id: string; speaker_name: string; start_ms: number; end_ms: number;
  status?: 'waiting' | 'pending' | 'running' | 'retrying' | 'failed' | 'complete';
  retry_after?: number; attempts?: number; error_code?: string;
}
export interface TranslationSnapshot {
  version: 'meeting-translation.v2';
  meeting_id: number; status: 'pending' | 'running' | 'paused' | 'complete';
  total: number; completed: number; retry_after: number; groups: TranslationGroup[];
  can_advance?: boolean; service_error?: string;
}

export interface PhraseTranslation { text: string | null; ready: boolean; sourceParts?:string[]; sourceIds?: string[]; status?: TranslationGroup['status'] }

/** Render backend-owned phrase boundaries; reject a stale group if any visible source changed. */
export function translationSegments<T extends TranscriptSegment & { speaker_id?: string; revision?: number }>(segments: T[], groups: TranslationGroup[]): (T & { translation?: PhraseTranslation })[] {
  const current = new Map(segments.filter(s => s.segment_id).map(s => [s.segment_id!, s]));
  const byMember = new Map<string, TranslationGroup>();
  for (const group of groups) {
    const known = group.members.filter(member => current.has(member.segment_id));
    if (!known.length || known.some(member => {
      const row = current.get(member.segment_id)!;
      return row.completed === false || row.text !== member.source_text
        || (member.revision != null && row.revision != null && member.revision !== row.revision)
        || !!(row.speaker_id && group.speaker_id && row.speaker_id !== group.speaker_id);
    })) continue;
    for (const member of group.members) byMember.set(member.segment_id, group);
  }
  const seen = new Set<string>();
  const result: (T & { translation?: PhraseTranslation })[] = [];
  for (const segment of segments) {
    const group = segment.segment_id ? byMember.get(segment.segment_id) : undefined;
    if (!group) { result.push(segment); continue; }
    if (seen.has(group.group_id)) continue;
    seen.add(group.group_id);
    result.push({ ...segment, segment_id: group.group_id, text: group.source_text,
      absolute_start_time: group.start_ms > 100_000_000_000 ? new Date(group.start_ms).toISOString() : segment.absolute_start_time,
      absolute_end_time: group.end_ms > 100_000_000_000 ? new Date(group.end_ms).toISOString() : segment.absolute_end_time,
      translation: { text: group.translated_text, ready: group.ready, status: group.status,
        sourceParts: group.members.map(member => member.source_text),
        sourceIds: group.members.filter(member => current.has(member.segment_id)).map(member => member.segment_id) } });
  }
  return result;
}

/** Same authenticated backend cache as Terminal; provider keys never reach the extension. */
export const LIVE_POLL_DELAY_MS = 1200;
export const ERROR_POLL_DELAY_MS = 10000;
export type TranslationHandle = (() => void) & { nudge: () => void };

export function watchTranslation(config: BotConnection, meetingId: number,
  update: (snapshot: TranslationSnapshot) => void, error: () => void, retry = false,
  priority: () => string[] = () => []): TranslationHandle {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let advancing = false;
  let polling = false;
  let queuedNudge = false;
  let force = retry;
  const read = async (method = 'GET', retry = false) => {
    const response = await botFetch(config, `/agent/meeting-translations/${meetingId}`, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      ...(method === 'POST' ? { body: JSON.stringify({ retry, segment_ids: priority().slice(0, 128) }) } : {}),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(method === 'POST' ? 90000 : 10000)]),
    });
    if (!response.ok) throw new Error('Translation unavailable');
    const snapshot = await response.json() as TranslationSnapshot;
    if (snapshot.version !== 'meeting-translation.v2' || snapshot.meeting_id !== meetingId || !Array.isArray(snapshot.groups)) throw new Error('Invalid translation');
    if (!abort.signal.aborted) update(snapshot);
    return snapshot;
  };
  const schedule = (delay: number) => {
    if (abort.signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(poll, delay);
  };
  const advanceLoop = async (initialForce: boolean, initialCompleted: number) => {
    if (advancing || abort.signal.aborted) return;
    advancing = true;
    let retryNow = initialForce;
    let lastCompleted = initialCompleted;
    try {
      while (!abort.signal.aborted) {
        const next = await read('POST', retryNow);
        retryNow = false;
        const currentCompleted = next.completed ?? 0;
        if (next.status === 'complete' || next.can_advance === false || next.retry_after > 0 || currentCompleted <= lastCompleted) break;
        lastCompleted = currentCompleted;
      }
    } catch {
      if (!abort.signal.aborted) error();
    } finally {
      advancing = false;
      if (queuedNudge && !abort.signal.aborted) {
        queuedNudge = false;
        schedule(0);
      }
    }
  };
  const poll = async () => {
    if (polling || abort.signal.aborted) {
      queuedNudge = true;
      return;
    }
    polling = true;
    let delay = LIVE_POLL_DELAY_MS;
    try {
      const state = await read();
      if (!advancing && state.status !== 'complete' && (state.can_advance !== false || force) && (state.retry_after === 0 || force)) {
        const retryNow = force; force = false;
        void advanceLoop(retryNow, state.completed ?? 0);
      }
    } catch {
      if (!abort.signal.aborted) error();
      delay = ERROR_POLL_DELAY_MS;
    } finally {
      polling = false;
    }
    if (queuedNudge && !abort.signal.aborted) {
      queuedNudge = false;
      schedule(0);
    } else {
      schedule(delay);
    }
  };
  void poll();
  const stop = (() => { abort.abort(); clearTimeout(timer); }) as TranslationHandle;
  stop.nudge = () => {
    if (abort.signal.aborted) return;
    if (polling || advancing) { queuedNudge = true; return; }
    schedule(0);
  };
  return stop;
}
