"use client";
// Lucian UX/UI Prompt #451 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#451
import "./lucian-451.css";
import type { FocusPayload } from "../../surfaces/chatContext";

export type MentionKind = "meeting" | "page" | "file" | "space" | "schedule" | "task" | "person";

export interface MentionTarget {
  id: string;
  kind: MentionKind;
  label: string;
  role: string;
  gradientA: string;
  gradientB: string;
  meetingId?: string;
  docPath?: string;
  spaceSlug?: string;
  personEmail?: string;
  searchText?: string;
}

export interface MentionMatch {
  anchor: number;
  query: string;
}

const ROW_H = 38;

/** Strip Vietnamese & Latin diacritics for forgiving search ("hop" matches "Họp dự án"). */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .trim();
}

/** Detects an active `@query` right before the caret (supports optional kind prefix like `@page:foo`). */
export function detectMentionAtCursor(value: string, cursor: number): MentionMatch | null {
  const before = value.slice(0, Math.max(0, cursor));
  const match = /(^|\s)@([^\s@]{0,32})$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { anchor: cursor - query.length - 1, query };
}

const PREFIX_TO_KINDS: Record<string, MentionKind[]> = {
  meeting: ["meeting"],
  meetings: ["meeting"],
  hop: ["meeting"],
  page: ["page", "file"],
  pages: ["page", "file"],
  doc: ["page", "file"],
  file: ["page", "file"],
  space: ["space"],
  spaces: ["space"],
  task: ["task"],
  tasks: ["task"],
  viec: ["task"],
  person: ["person"],
  people: ["person"],
  member: ["person"],
  schedule: ["schedule"],
  today: ["schedule"],
  lich: ["schedule"],
};

/** Filter and rank mention targets with Vietnamese diacritic-insensitive matching and optional `kind:query` prefix. */
export function filterMentionTargets(
  targets: MentionTarget[],
  rawQuery: string,
  limit = 10,
): MentionTarget[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) return targets.slice(0, limit);

  let kindFilter: MentionKind[] | null = null;
  let term = trimmed;
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const prefix = normalizeSearchText(trimmed.slice(0, colonIdx));
    if (PREFIX_TO_KINDS[prefix]) {
      kindFilter = PREFIX_TO_KINDS[prefix];
      term = trimmed.slice(colonIdx + 1).trim();
    }
  }

  const normalizedTerm = normalizeSearchText(term);
  const scored: Array<{ item: MentionTarget; score: number; idx: number }> = [];

  for (let idx = 0; idx < targets.length; idx++) {
    const item = targets[idx];
    if (kindFilter && !kindFilter.includes(item.kind)) continue;
    if (!normalizedTerm) {
      scored.push({ item, score: 1, idx });
      continue;
    }
    const labelNorm = normalizeSearchText(item.label);
    const roleNorm = normalizeSearchText(item.role);
    const pathNorm = item.docPath ? normalizeSearchText(item.docPath) : "";
    const extraNorm = item.searchText ? normalizeSearchText(item.searchText) : "";
    const emailNorm = item.personEmail ? normalizeSearchText(item.personEmail) : "";

    let score = 0;
    if (labelNorm === normalizedTerm) score = 100;
    else if (labelNorm.startsWith(normalizedTerm)) score = 80;
    else if (labelNorm.includes(normalizedTerm)) score = 60;
    else if (roleNorm.startsWith(normalizedTerm)) score = 45;
    else if (pathNorm.includes(normalizedTerm) || emailNorm.includes(normalizedTerm) || extraNorm.includes(normalizedTerm)) {
      score = 30;
    } else if (roleNorm.includes(normalizedTerm)) {
      score = 20;
    }

    if (score > 0) scored.push({ item, score, idx });
  }

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, limit).map((s) => s.item);
}

/** Finds an inserted `@Label` token right before the caret so Backspace deletes the whole mention atomically. */
export function findMentionBeforeCursor(value: string, cursor: number, labels: string[]): string | null {
  if (cursor <= 0) return null;
  const before = value.slice(0, cursor);
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  for (const label of sorted) {
    const token = `@${label}`;
    if (before.endsWith(token)) return token;
  }
  return null;
}

export interface CompiledMentionContext {
  /** Extra grounded context lines (`@file:...`, Space slug, extra meetings, people) to append on the wire prompt. */
  contextBlock: string;
  /** Whether the user explicitly mentioned `@Today` / `@Schedule`. */
  includeSchedule: boolean;
  /** First mentioned meeting id, if any. */
  primaryMeetingId?: string;
  /** Best non-meeting focus payload when no meeting is focused. */
  fallbackFocus: FocusPayload | null;
}

/** Compile selected `@` mention chips into real backend-grounded context (`@file:`, workspace slug, schedule flag, meetings, people). */
export function compileMentionContext(targets: MentionTarget[]): CompiledMentionContext {
  if (targets.length === 0) {
    return { contextBlock: "", includeSchedule: false, fallbackFocus: null };
  }

  const lines: string[] = [];
  let includeSchedule = false;
  let primaryMeetingId: string | undefined;
  let fallbackFocus: FocusPayload | null = null;
  const seenFileRefs = new Set<string>();

  for (const t of targets) {
    if (t.kind === "schedule") {
      includeSchedule = true;
      if (!fallbackFocus) fallbackFocus = { kind: "today" };
      lines.push("- Schedule: include today's and upcoming meetings");
    } else if (t.kind === "meeting" && t.meetingId) {
      if (!primaryMeetingId) primaryMeetingId = t.meetingId;
      lines.push(`- Meeting: "${t.label}" (meeting_id: ${t.meetingId})`);
    } else if ((t.kind === "page" || t.kind === "file" || t.kind === "task") && t.docPath) {
      const ref = `@file:${t.docPath}`;
      if (!seenFileRefs.has(ref)) {
        seenFileRefs.add(ref);
        lines.push(`- ${ref} (${t.label})`);
      }
      if (!fallbackFocus) fallbackFocus = { kind: "file", ref };
    } else if (t.kind === "task") {
      lines.push("- Tasks: inspect open tasks under kg/entities/task/ in the workspace");
    } else if (t.kind === "space" && t.spaceSlug) {
      lines.push(`- Space: "${t.label}" (slug: ${t.spaceSlug})`);
      if (!fallbackFocus) fallbackFocus = { kind: "workspace", slug: t.spaceSlug };
    } else if (t.kind === "person") {
      if (t.docPath) {
        const ref = `@file:${t.docPath}`;
        if (!seenFileRefs.has(ref)) {
          seenFileRefs.add(ref);
          lines.push(`- Person: ${t.label} (${ref})`);
        }
        if (!fallbackFocus) fallbackFocus = { kind: "file", ref };
      } else {
        lines.push(`- Person: ${t.label}${t.personEmail ? ` (${t.personEmail})` : ""}`);
      }
    }
  }

  const contextBlock = lines.length > 0 ? `Referenced context:\n${lines.join("\n")}` : "";
  return { contextBlock, includeSchedule, primaryMeetingId, fallbackFocus };
}

function renderHighlighted(text: string, query: string) {
  const colonIdx = query.indexOf(":");
  const effective = colonIdx > 0 && PREFIX_TO_KINDS[normalizeSearchText(query.slice(0, colonIdx))]
    ? query.slice(colonIdx + 1)
    : query;
  const q = normalizeSearchText(effective);
  if (!q) return text;
  const rawIdx = text.toLowerCase().indexOf(effective.trim().toLowerCase());
  if (rawIdx >= 0 && effective.trim().length > 0) {
    const len = effective.trim().length;
    return (
      <>
        {text.slice(0, rawIdx)}
        <mark>{text.slice(rawIdx, rawIdx + len)}</mark>
        {text.slice(rawIdx + len)}
      </>
    );
  }
  // Diacritic-insensitive fallback match highlight
  const normChars = [...text].map((ch) => normalizeSearchText(ch) || ch.toLowerCase());
  const joined = normChars.join("");
  const matchIdx = joined.indexOf(q);
  if (matchIdx < 0) return text;
  return (
    <>
      {text.slice(0, matchIdx)}
      <mark>{text.slice(matchIdx, matchIdx + q.length)}</mark>
      {text.slice(matchIdx + q.length)}
    </>
  );
}

export function LucianMentionPopover({
  open,
  listboxId,
  query,
  items,
  activeIndex,
  onHoverIndex,
  onPick,
}: {
  open: boolean;
  listboxId: string;
  query: string;
  items: MentionTarget[];
  activeIndex: number;
  onHoverIndex: (idx: number) => void;
  onPick: (item: MentionTarget) => void;
}) {
  const safeIdx = items.length > 0 ? Math.min(Math.max(activeIndex, 0), items.length - 1) : 0;

  return (
    <div
      className={`ux u451-pop ${open && items.length > 0 ? "is-open" : ""}`}
      data-testid="lucian-mention-popover"
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="u451-lb" id={listboxId} role="listbox" aria-label="Mention meetings or knowledge">
        {items.length > 0 && (
          <i
            className="u451-pill"
            aria-hidden="true"
            style={{ "--u451-py": `${safeIdx * ROW_H}px` } as React.CSSProperties}
          />
        )}
        {items.map((item, idx) => {
          const isSelected = idx === safeIdx;
          const initial = (item.label.trim().charAt(0) || "@").toUpperCase();
          return (
            <div
              key={item.id}
              id={`${listboxId}-opt-${idx}`}
              role="option"
              aria-selected={isSelected}
              className="u451-o"
              onPointerMove={() => {
                if (idx !== activeIndex) onHoverIndex(idx);
              }}
              onClick={() => onPick(item)}
            >
              <span
                className="u451-av"
                aria-hidden="true"
                style={
                  {
                    "--u451-a": item.gradientA,
                    "--u451-b": item.gradientB,
                  } as React.CSSProperties
                }
              >
                {initial}
              </span>
              <span className="u451-nm">{renderHighlighted(item.label, query)}</span>
              <span className="u451-rl">{item.role}</span>
            </div>
          );
        })}
      </div>
      <p className="u451-live" role="status">
        {open ? (items.length > 0 ? `${items.length} suggestions` : "No matching items") : ""}
      </p>
    </div>
  );
}

export function LucianMentionTriggerButton({
  onClick,
  disabled = false,
  expanded = false,
}: {
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="ux u451-at"
      aria-label="Mention meeting or knowledge"
      aria-haspopup="listbox"
      aria-expanded={expanded}
      title="Mention meeting, page, space, task, person, or schedule (@)"
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3.7" />
        <path d="M15.7 12v1.3a2.5 2.5 0 0 0 5 0V12a8.7 8.7 0 1 0-3.4 6.9" />
      </svg>
    </button>
  );
}

export function LucianMentionChips({
  mentions,
  onRemove,
}: {
  mentions: MentionTarget[];
  onRemove: (id: string) => void;
}) {
  if (mentions.length === 0) return null;
  return (
    <div className="ux u451-chips" aria-label="Mentioned context">
      {mentions.map((item) => (
        <span key={item.id} className="u451-m is-pop" title={`${item.role}: ${item.docPath || item.label}`}>
          <span className="u451-m-kind">{item.role}</span>
          <span>@{item.label}</span>
          <button
            type="button"
            className="u451-m-rm"
            aria-label={`Remove mention ${item.label}`}
            onClick={() => onRemove(item.id)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
