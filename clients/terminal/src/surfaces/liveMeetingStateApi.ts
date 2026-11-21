export interface LiveMeetingEvidence {
  segment_id?: string;
  document_id?: string;
  path?: string;
  workspace_id?: string;
  sha256?: string;
  quote: string;
  start_ms?: number;
  speaker_name?: string;
}

export interface LiveMeetingItem {
  id: string;
  type: string;
  text: string;
  status: string;
  revision: number;
  human: boolean;
  provisional: boolean;
  stale: boolean;
  last_editor?: string;
  manual_fields?: string[];
  provenance?: { origin?: string; role?: string; model?: string };
  details?: Record<string, string | string[]>;
  evidence: LiveMeetingEvidence[];
}

export interface LiveMeetingStateSnapshot {
  configured: boolean;
  enabled: boolean;
  can_configure: boolean;
  readonly: boolean;
  revision: number;
  research_available?: boolean;
  source_notice?: boolean;
  participants?: Array<{ name: string; status: string }>;
  wiki_ref?: { workspace_id: string; path: string };
  active_topic?: string | null;
  links?: Array<{ from: string; to: string; kind: string; from_text: string; to_text: string; evidence: Array<{ quote: string; segment_id?: string; document_id?: string }> }>;
  goal?: { text: string; revision: number; human?: boolean; source?: string; tentative?: boolean; stale?: boolean; provenance?: { model?: string }; evidence?: LiveMeetingEvidence[] };
  config?: { fast_seconds: number; reason_seconds: number; timezone: string; eagerness: string; approval: string; approvers: number[]; quorum: number };
  items?: LiveMeetingItem[];
  archive_items?: LiveMeetingItem[];
  archive_offset?: number;
  archive_count?: number;
  archive_more?: boolean;
  activity_offset?: number;
  activity_count?: number;
  activity_more?: boolean;
  summaries?: { current: string; meeting: string; stale?: boolean; current_revision?: number; meeting_revision?: number; manual_fields?: string[]; current_provenance?: { origin?: string; model?: string }; meeting_provenance?: { origin?: string; model?: string } };
  final?: string;
  freshness?: Record<string, { status: string; error?: string; covered: number }>;
  proposals?: Array<{ id: string; item_id: string; patch: { text: string }; status: string; roster_changed?: boolean }>;
  activity?: Array<{ sequence: number; actor: string; kind: string; target_text?: string; status?: string; before?: { text?: string }; after?: { text?: string }; authorization_changed?: boolean; redacted?: boolean }>;
  wiki?: string;
}

export interface PlannedLiveAssistDraft {
  goal: string | null;
  agendaItems: Array<{ id: string; text: string }>;
  agendaEdits: Array<{ id: string; text: string; revision: number }>;
}

export const EMPTY_LIVE_ASSIST_DRAFT: PlannedLiveAssistDraft = { goal: null, agendaItems: [], agendaEdits: [] };
export const LIVE_ASSIST_DRAFT_TAB_KEY = "prep:draft";

const stateUrl = (meetingId: string) => `/api/transcripts/by-id/${encodeURIComponent(meetingId)}/state`;
const draftStorageKey = (key: string) => `tina.live-assist.planned.${key}`;

export async function readLiveMeetingState(meetingId: string, signal?: AbortSignal, archiveOffset = 0, activityOffset = 0): Promise<LiveMeetingStateSnapshot> {
  const response = await fetch(`${stateUrl(meetingId)}?archive_offset=${archiveOffset}&activity_offset=${activityOffset}`, { cache: "no-store", signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail || "Could not load meeting state");
  return value as LiveMeetingStateSnapshot;
}

export async function readAllLiveMeetingState(meetingId: string, signal?: AbortSignal, activityOffset = 0): Promise<LiveMeetingStateSnapshot> {
  const first = await readLiveMeetingState(meetingId, signal, 0, activityOffset);
  if (!first.configured || !first.archive_more) return first;
  let page = first;
  let archiveItems = first.archive_items || [];
  while (page.archive_more && (page.archive_offset || 0) < 50000) {
    page = await readLiveMeetingState(meetingId, signal, (page.archive_offset || 0) + 100, activityOffset);
    archiveItems = [...(page.archive_items || []), ...archiveItems];
  }
  return { ...first, items: [...archiveItems, ...(first.items || [])], archive_items: [], archive_more: false };
}

export function mergeLiveMeetingState(previous: LiveMeetingStateSnapshot | null, next: LiveMeetingStateSnapshot): LiveMeetingStateSnapshot {
  if (!previous?.configured || !next.configured) return next;
  const items = new Map((previous.items || []).map((item) => [item.id, item]));
  for (const item of [...(next.archive_items || []), ...(next.items || [])]) items.set(item.id, item);
  return { ...next, items: [...items.values()], archive_items: [], archive_more: false };
}

export async function postLiveMeetingStateAction(meetingId: string, action: string, payload: unknown): Promise<LiveMeetingStateSnapshot> {
  const response = await fetch(`${stateUrl(meetingId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail || "Live Assist update failed");
  return value as LiveMeetingStateSnapshot;
}

export function readPlannedLiveAssistDraft(key: string): PlannedLiveAssistDraft {
  if (typeof window === "undefined") return { ...EMPTY_LIVE_ASSIST_DRAFT, agendaItems: [] };
  try {
    const value = JSON.parse(window.localStorage.getItem(draftStorageKey(key)) || "null");
    if (!value || typeof value !== "object") return { ...EMPTY_LIVE_ASSIST_DRAFT, agendaItems: [] };
    return {
      goal: typeof value.goal === "string" ? value.goal : null,
      agendaItems: Array.isArray(value.agendaItems)
        ? value.agendaItems.filter((item: unknown): item is { id: string; text: string } =>
          !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { text?: unknown }).text === "string")
        : [],
      agendaEdits: Array.isArray(value.agendaEdits)
        ? value.agendaEdits.filter((item: unknown): item is { id: string; text: string; revision: number } =>
          !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { text?: unknown }).text === "string" && Number.isInteger((item as { revision?: unknown }).revision))
        : [],
    };
  } catch { return { ...EMPTY_LIVE_ASSIST_DRAFT, agendaItems: [] }; }
}

export function writePlannedLiveAssistDraft(key: string, draft: PlannedLiveAssistDraft): void {
  if (typeof window === "undefined") return;
  try {
    if (draft.goal === null && draft.agendaItems.length === 0 && draft.agendaEdits.length === 0) window.localStorage.removeItem(draftStorageKey(key));
    else window.localStorage.setItem(draftStorageKey(key), JSON.stringify(draft));
  } catch { /* storage may be unavailable */ }
}

export function movePlannedLiveAssistDraft(from: string, to: string): void {
  if (typeof window === "undefined" || from === to) return;
  try {
    const source = draftStorageKey(from);
    const value = window.localStorage.getItem(source);
    if (value) window.localStorage.setItem(draftStorageKey(to), value);
    window.localStorage.removeItem(source);
  } catch { /* keep the source draft if storage cannot be copied */ }
}
