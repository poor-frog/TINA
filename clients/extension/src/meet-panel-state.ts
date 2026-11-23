import type { BotMeeting } from './bot-transcript';
import type { TranscriptSegment } from './transcript-rendering';
import { translationSegments, type TranslationGroup } from './translation';

export const TERMINAL_BOT_STATUSES = new Set(['completed', 'failed', 'stopped', 'ended', 'past']);

export interface MiniCaption {
  stt: string;
}

export function isTerminalBotStatus(status: string): boolean {
  return TERMINAL_BOT_STATUSES.has(status.toLowerCase());
}

export function isOwnedActiveBot(meeting: BotMeeting | null): boolean {
  return meeting?.shared === false && !isTerminalBotStatus(meeting.status);
}

/** Prefer an active owned run, while still supporting shared and saved transcripts. */
export function currentGoogleMeetBot(meetings: BotMeeting[], nativeMeetingId: string): BotMeeting | null {
  const matching = meetings
    .filter(meeting => meeting.platform === 'google_meet' && meeting.nativeMeetingId.toLowerCase() === nativeMeetingId.toLowerCase())
    .sort((a, b) => b.startMs - a.startMs);
  return matching.find(isOwnedActiveBot)
    ?? matching.find(meeting => !isTerminalBotStatus(meeting.status))
    ?? matching[0] ?? null;
}

const MINI_CAPTION_TARGET_WORDS = 28;
const MINI_CAPTION_MAX_CHARS = 280;

/** Extract a readable live STT utterance for the minimized comic thought bubble.
 * Combines short trailing fragments from the same speaker so the bubble stays understandable
 * instead of collapsing to single-word snippets. */
export function latestMiniCaption(
  segments: TranscriptSegment[],
  groups: TranslationGroup[],
): MiniCaption | null {
  const items = translationSegments(segments, groups).filter(item => item.text?.trim());
  if (!items.length) return null;
  const last = items[items.length - 1];
  const speakerOf = (row: TranscriptSegment) => row.speaker_id || row.speaker || '';
  const targetSpeaker = speakerOf(last);

  const window: typeof items = [last];
  let totalWords = last.text.trim().split(/\s+/).length;
  let totalChars = last.text.trim().length;
  for (let i = items.length - 2; i >= 0 && window.length < 4; i--) {
    if (totalWords >= MINI_CAPTION_TARGET_WORDS || totalChars >= MINI_CAPTION_MAX_CHARS) break;
    const candidate = items[i];
    if (targetSpeaker && speakerOf(candidate) && speakerOf(candidate) !== targetSpeaker) break;
    const nextText = candidate.text.trim();
    const nextWords = nextText.split(/\s+/).length;
    if (totalChars + nextText.length + 1 > MINI_CAPTION_MAX_CHARS) break;
    window.unshift(candidate);
    totalWords += nextWords;
    totalChars += nextText.length + 1;
  }

  return { stt: window.map(item => item.text.trim()).join(' ') };
}
