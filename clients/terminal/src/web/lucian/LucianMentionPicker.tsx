"use client";
// Lucian UX/UI Prompt #451 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#451
import "./lucian-451.css";

export interface MentionTarget {
  id: string;
  kind: "meeting" | "page" | "space";
  label: string;
  role: string;
  gradientA: string;
  gradientB: string;
  meetingId?: string;
  docPath?: string;
  spaceSlug?: string;
}

export interface MentionMatch {
  anchor: number;
  query: string;
}

const ROW_H = 38;

/** Detects an active `@query` right before the caret (identical rule to Lucian #451). */
export function detectMentionAtCursor(value: string, cursor: number): MentionMatch | null {
  const before = value.slice(0, Math.max(0, cursor));
  const match = /(^|\s)@([^\s@]{0,24})$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { anchor: cursor - query.length - 1, query };
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

function renderHighlighted(text: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
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
      title="Mention a meeting, knowledge page, or space (@)"
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
        <span key={item.id} className="u451-m is-pop">
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
