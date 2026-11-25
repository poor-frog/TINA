"use client";
import { useEffect, useMemo, useState } from "react";
import { WebIcon } from "./Icons";
import type { MeetingMock } from "../surfaces/meetingModel";
import type { WebNavView } from "./Sidebar";

interface SearchHit {
  id: string;
  label: string;
  detail: string;
  kind: "meeting" | "action";
  run: () => void;
}

export function WebGlobalSearch({
  open,
  meetings,
  meetingsOnly,
  canOpenTerminal,
  terminalHref,
  onClose,
  onOpenMeeting,
  onNavigate,
  onOpenCapture,
}: {
  open: boolean;
  meetings: MeetingMock[];
  meetingsOnly: boolean;
  canOpenTerminal: boolean;
  terminalHref: string;
  onClose: () => void;
  onOpenMeeting: (meetingId: string) => void;
  onNavigate: (view: Exclude<WebNavView, "meeting">) => void;
  onOpenCapture: () => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    const meetingHits: SearchHit[] = meetings
      .filter((m) => {
        if (!q) return true;
        return `${m.title} ${m.title_custom ?? ""} ${m.native_id ?? ""} ${m.platform}`.toLowerCase().includes(q);
      })
      .slice(0, 8)
      .map((m) => ({
        id: `m:${m.id}`,
        label: m.title_custom || m.title,
        detail: `${m.platform} · ${m.when}`,
        kind: "meeting",
        run: () => {
          onOpenMeeting(m.id);
          onClose();
        },
      }));

    const rawActions: SearchHit[] = [
      {
        id: "act:capture",
        label: "Capture or schedule a meeting",
        detail: "Send TINA bot to Google Meet, Zoom, Teams, Jitsi, or Discord",
        kind: "action",
        run: () => {
          onClose();
          onOpenCapture();
        },
      },
      ...(!meetingsOnly
        ? [
            {
              id: "act:ask",
              label: "Ask Tina",
              detail: "Chat across meetings and workspace knowledge",
              kind: "action" as const,
              run: () => {
                onNavigate("ask");
                onClose();
              },
            },
            {
              id: "act:knowledge",
              label: "Open Knowledge Hub",
              detail: "Personal & Shared Wiki, Platform Guide (_global), Knowledge Graph & GitHub Sync",
              kind: "action" as const,
              run: () => {
                onNavigate("knowledge");
                onClose();
              },
            },
            {
              id: "act:tasks",
              label: "Open Tasks",
              detail: "Workspace action items and task files",
              kind: "action" as const,
              run: () => {
                onNavigate("tasks");
                onClose();
              },
            },
            {
              id: "act:routines",
              label: "Open Routines",
              detail: "Scheduled autonomous agents",
              kind: "action" as const,
              run: () => {
                onNavigate("routines");
                onClose();
              },
            },
          ]
        : []),
      {
        id: "act:settings",
        label: "Open Settings",
        detail: "Models, transcription ASR, calendars, tokens, and voice",
        kind: "action",
        run: () => {
          onNavigate("settings");
          onClose();
        },
      },
      ...(canOpenTerminal
        ? [
            {
              id: "act:terminal",
              label: "Open TINA Terminal (Dev Workbench)",
              detail: terminalHref,
              kind: "action" as const,
              run: () => {
                window.location.href = terminalHref;
              },
            },
          ]
        : []),
    ];
    const actions = rawActions.filter((a) => !q || `${a.label} ${a.detail}`.toLowerCase().includes(q));

    return [...meetingHits, ...actions];
  }, [query, meetings, meetingsOnly, canOpenTerminal, terminalHref, onOpenMeeting, onClose, onOpenCapture, onNavigate]);

  if (!open) return null;

  return (
    <div className="tina-web-backdrop" role="dialog" aria-modal="true" aria-label="Search" onClick={onClose}>
      <div className="tina-web-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--tw-line-soft)" }}>
          <WebIcon name="search" size={16} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings or jump to a view…"
            aria-label="Search query"
            style={{ flex: 1, border: 0, outline: 0, background: "transparent", color: "var(--tw-text)", fontSize: 14 }}
          />
          <button type="button" className="tina-web-icon-btn" aria-label="Close search" onClick={onClose}>
            <WebIcon name="close" size={15} />
          </button>
        </div>

        <div style={{ maxHeight: 420, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              onClick={hit.run}
              className="tina-web-feed-row"
              style={{ minHeight: 46, padding: "8px 12px" }}
            >
              <WebIcon name={hit.kind === "meeting" ? "video" : "sparkleSmall"} size={15} />
              <span className="tina-web-feed-main">
                <span className="tina-web-feed-title">{hit.label}</span>
                <span className="tina-web-feed-meta">{hit.detail}</span>
              </span>
            </button>
          ))}
          {hits.length === 0 && (
            <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--tw-text-4)", fontSize: 13 }}>
              No matching meetings or commands.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
