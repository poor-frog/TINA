/** meetingsFilter — pure date-grouping, multi-dimensional filtering, and duration helpers for
 *  the Production Meetings Notebook (`MeetingsView.tsx`). Exported for direct unit testing. */
import { meetingPhase, type MeetingMock } from "../surfaces/meetingModel";

export type DateRangePreset = "any" | "today" | "7d" | "14d" | "30d";
export type DurationPreset = "any" | "under15" | "15to30" | "30to60" | "over60";

export interface MeetingFilterState {
  platforms: string[];
  participants: string[];
  dateRange: DateRangePreset;
  dateFrom: string; // YYYY-MM-DD or ""
  dateTo: string;   // YYYY-MM-DD or ""
  duration: DurationPreset;
  hasRecordingOnly: boolean;
}

export const EMPTY_MEETING_FILTERS: MeetingFilterState = {
  platforms: [],
  participants: [],
  dateRange: "any",
  dateFrom: "",
  dateTo: "",
  duration: "any",
  hasRecordingOnly: false,
};

export interface MeetingDayGroup {
  key: string;
  label: string;
  tone: "live" | "upcoming" | "recorded";
  items: MeetingMock[];
}

export function meetingTimestampMs(m: MeetingMock): number | null {
  const raw = m.start_time || m.scheduled_at;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function meetingDurationMins(m: MeetingMock): number | null {
  if (!m.start_time || !m.end_time) return null;
  const start = Date.parse(m.start_time);
  const end = Date.parse(m.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.max(1, Math.round((end - start) / 60_000));
}

export function formatShortDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

export function meetingParticipantNames(m: MeetingMock): string[] {
  const names = new Set<string>();
  for (const p of m.participants) {
    const clean = p.name?.trim();
    if (clean) names.add(clean);
  }
  for (const a of m.attendees ?? []) {
    const clean = (a.name || a.email || "").trim();
    if (clean) names.add(clean);
  }
  return [...names];
}

export function extractFilterFacets(meetings: MeetingMock[]): {
  platforms: string[];
  participants: string[];
} {
  const platformSet = new Set<string>();
  const participantSet = new Set<string>();
  for (const m of meetings) {
    if (m.platform?.trim()) platformSet.add(m.platform.trim());
    for (const name of meetingParticipantNames(m)) participantSet.add(name);
  }
  return {
    platforms: [...platformSet].sort((a, b) => a.localeCompare(b)),
    participants: [...participantSet].sort((a, b) => a.localeCompare(b)),
  };
}

export function countActiveFilters(f: MeetingFilterState): number {
  return (
    f.platforms.length +
    f.participants.length +
    (f.dateRange !== "any" || Boolean(f.dateFrom || f.dateTo) ? 1 : 0) +
    (f.duration !== "any" ? 1 : 0) +
    (f.hasRecordingOnly ? 1 : 0)
  );
}

function startOfLocalDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDayHeading(ms: number, now: Date = new Date()): string {
  const targetDay = startOfLocalDayMs(new Date(ms));
  const today = startOfLocalDayMs(now);
  const diffDays = Math.round((targetDay - today) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  if (diffDays === 1) return "Tomorrow";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function matchesMeetingFilters(
  m: MeetingMock,
  filters: MeetingFilterState,
  now: Date = new Date(),
): boolean {
  if (filters.platforms.length > 0 && !filters.platforms.includes(m.platform)) {
    return false;
  }

  if (filters.participants.length > 0) {
    const names = meetingParticipantNames(m);
    if (!filters.participants.some((target) => names.includes(target))) {
      return false;
    }
  }

  if (filters.hasRecordingOnly && !m.has_recording) {
    return false;
  }

  if (filters.duration !== "any") {
    const mins = meetingDurationMins(m);
    if (mins === null) return false;
    if (filters.duration === "under15" && mins >= 15) return false;
    if (filters.duration === "15to30" && (mins < 15 || mins >= 30)) return false;
    if (filters.duration === "30to60" && (mins < 30 || mins >= 60)) return false;
    if (filters.duration === "over60" && mins < 60) return false;
  }

  if (filters.dateRange !== "any" || filters.dateFrom || filters.dateTo) {
    const ts = meetingTimestampMs(m);
    if (ts === null) return false;
    if (filters.dateFrom) {
      const fromMs = Date.parse(`${filters.dateFrom}T00:00:00`);
      if (Number.isFinite(fromMs) && ts < fromMs) return false;
    }
    if (filters.dateTo) {
      const toMs = Date.parse(`${filters.dateTo}T23:59:59.999`);
      if (Number.isFinite(toMs) && ts > toMs) return false;
    }
    if (filters.dateRange === "today") {
      const todayStart = startOfLocalDayMs(now);
      const todayEnd = todayStart + 86_400_000 - 1;
      if (ts < todayStart || ts > todayEnd) return false;
    } else if (filters.dateRange === "7d" || filters.dateRange === "14d" || filters.dateRange === "30d") {
      const days = filters.dateRange === "7d" ? 7 : filters.dateRange === "14d" ? 14 : 30;
      const cutoff = now.getTime() - days * 86_400_000;
      if (ts < cutoff || ts > now.getTime() + 86_400_000) return false;
    }
  }

  return true;
}

/** Group meetings into Live Now pinned at top, Upcoming grouped by date (soonest first), and
 *  Recorded meetings grouped by calendar day (newest first). */
export function groupMeetingsByDate(meetings: MeetingMock[], now: Date = new Date()): MeetingDayGroup[] {
  const groups: MeetingDayGroup[] = [];

  const live = meetings.filter((m) => meetingPhase(m) === "live");
  if (live.length > 0) {
    groups.push({ key: "live-now", label: "Live now", tone: "live", items: live });
  }

  const upcoming = meetings
    .filter((m) => meetingPhase(m) === "prep")
    .sort((a, b) => {
      const ta = meetingTimestampMs(a);
      const tb = meetingTimestampMs(b);
      if (ta !== null && tb !== null) return ta - tb;
      if (ta !== null) return -1;
      if (tb !== null) return 1;
      return (a.title_custom || a.title).localeCompare(b.title_custom || b.title);
    });

  const upcomingByDay = new Map<string, { label: string; items: MeetingMock[] }>();
  for (const m of upcoming) {
    const ts = meetingTimestampMs(m);
    const key = ts !== null ? `up:${localDayKey(ts)}` : "up:unscheduled";
    const label = ts !== null ? `Upcoming · ${formatDayHeading(ts, now)}` : "Upcoming · Unscheduled";
    const bucket = upcomingByDay.get(key);
    if (bucket) bucket.items.push(m);
    else upcomingByDay.set(key, { label, items: [m] });
  }
  for (const [key, bucket] of upcomingByDay.entries()) {
    groups.push({ key, label: bucket.label, tone: "upcoming", items: bucket.items });
  }

  const recorded = meetings
    .filter((m) => meetingPhase(m) === "post")
    .sort((a, b) => {
      const ta = meetingTimestampMs(a);
      const tb = meetingTimestampMs(b);
      if (ta !== null && tb !== null) return tb - ta;
      if (ta !== null) return -1;
      if (tb !== null) return 1;
      return Number(b.id) - Number(a.id);
    });

  const recordedByDay = new Map<string, { label: string; items: MeetingMock[] }>();
  for (const m of recorded) {
    const ts = meetingTimestampMs(m);
    const key = ts !== null ? `rec:${localDayKey(ts)}` : "rec:earlier";
    const label = ts !== null ? formatDayHeading(ts, now) : "Earlier recordings";
    const bucket = recordedByDay.get(key);
    if (bucket) bucket.items.push(m);
    else recordedByDay.set(key, { label, items: [m] });
  }
  for (const [key, bucket] of recordedByDay.entries()) {
    groups.push({ key, label: bucket.label, tone: "recorded", items: bucket.items });
  }

  return groups;
}
