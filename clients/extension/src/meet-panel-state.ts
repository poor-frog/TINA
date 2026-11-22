import type { BotMeeting } from './bot-transcript';

export const TERMINAL_BOT_STATUSES = new Set(['completed', 'failed', 'stopped', 'ended', 'past']);

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
