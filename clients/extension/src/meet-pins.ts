import { botBase, type BotConnection, type BotMeeting } from './bot-transcript';
import type { TranscriptSegment } from './transcript-rendering';

export const pinLabelLimit = 80;

export interface MeetingPin {
  segmentId: string;
  timeMs: number;
  label: string;
}

export function pinSource(segment: TranscriptSegment): MeetingPin | undefined {
  const id = segment.segment_id;
  const timeMs = Date.parse(segment.absolute_start_time);
  if (!id?.trim() || id.length > 256 || id.startsWith('legacy:') || segment.completed === false
    || !segment.text.trim() || !Number.isFinite(timeMs)) return;
  return { segmentId: id, timeMs, label: '' };
}

export async function pinScope(config: BotConnection, meeting: BotMeeting): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    botBase(config.botGatewayUrl), config.account?.id, meeting.id, meeting.platform, meeting.nativeMeetingId,
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `tina.meetingPins.v1.${fingerprint}.`;
}

function pinKey(prefix: string, segmentId: string): string {
  return prefix + segmentId;
}

export function pinsFromStorage(prefix: string, values: Record<string, unknown>): MeetingPin[] {
  return Object.entries(values).flatMap(([key, item]) => {
    if (!key.startsWith(prefix) || !item || typeof item !== 'object') return [];
    const pin = item as Partial<MeetingPin>;
    if (typeof pin.segmentId !== 'string' || !pin.segmentId || pin.segmentId.length > 256
      || key !== pinKey(prefix, pin.segmentId) || typeof pin.timeMs !== 'number'
      || !Number.isFinite(pin.timeMs) || Math.abs(pin.timeMs) > 8.64e15 || typeof pin.label !== 'string') return [];
    return [{ segmentId: pin.segmentId, timeMs: pin.timeMs, label: pin.label.slice(0, pinLabelLimit) }];
  }).sort((a, b) => a.timeMs - b.timeMs || a.segmentId.localeCompare(b.segmentId));
}

export async function readPins(prefix: string): Promise<MeetingPin[]> {
  return pinsFromStorage(prefix, await chrome.storage.local.get(null));
}

export async function writePin(prefix: string, pin: MeetingPin, remove = false): Promise<void> {
  const key = pinKey(prefix, pin.segmentId);
  if (remove) await chrome.storage.local.remove(key);
  else await chrome.storage.local.set({ [key]: pin });
}
