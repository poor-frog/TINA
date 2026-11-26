"use client";
import { useEffect, useMemo, useState } from "react";
import { applyTheme, getTheme } from "../app/theme";
import { LucianCommandPalette, type LucianCommandItem } from "./lucian/LucianCommandPalette";
import { emitWebToast } from "./lucian/webToast";
import { friendlyPageTitle } from "./knowledgeFriendly";
import type { MeetingMock } from "../surfaces/meetingModel";
import { searchWorkspaceContent, type WorkspaceSearchHit } from "../surfaces/workspaceApi";
import type { WebNavView } from "./Sidebar";

export function WebGlobalSearch({
  open,
  meetings,
  meetingsOnly,
  canOpenTerminal,
  terminalHref,
  onClose,
  onOpenMeeting,
  onOpenKnowledgeDoc,
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
  onOpenKnowledgeDoc?: (docPath: string, wsSlug?: string) => void;
  onNavigate: (view: Exclude<WebNavView, "meeting">) => void;
  onOpenCapture: () => void;
}) {
  const [query, setQuery] = useState("");
  const [wikiHits, setWikiHits] = useState<Array<WorkspaceSearchHit & { wsSlug?: string; wsLabel: string }>>([]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setWikiHits([]);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || meetingsOnly) {
      setWikiHits([]);
      return;
    }
    const q = query.trim();
    if (q.length < 2) {
      setWikiHits([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void Promise.all([
        searchWorkspaceContent(q)
          .then((r) => r.hits.map((h) => ({ ...h, wsSlug: undefined, wsLabel: "My Space" })))
          .catch(() => []),
        searchWorkspaceContent(q, { slug: "_global" })
          .then((r) => r.hits.map((h) => ({ ...h, wsSlug: "_global", wsLabel: "Templates & Guides" })))
          .catch(() => []),
      ]).then(([own, glob]) => {
        if (!alive) return;
        const dedup = new Map<string, WorkspaceSearchHit & { wsSlug?: string; wsLabel: string }>();
        for (const h of [...own, ...glob]) {
          const key = `${h.wsSlug || ""}:${h.path}`;
          if (!dedup.has(key)) dedup.set(key, h);
        }
        setWikiHits([...dedup.values()].slice(0, 6));
      });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, meetingsOnly, query]);

  const items = useMemo<LucianCommandItem[]>(() => {
    const q = query.trim().toLowerCase();

    const knowledgeHits: LucianCommandItem[] = wikiHits.map((h) => ({
      id: `kb:${h.wsSlug || "personal"}:${h.path}:${h.line}`,
      group: "Knowledge",
      label: friendlyPageTitle(h.path),
      detail: `${h.wsLabel} · ${h.text}`,
      icon: "bookOpen",
      gradient: "linear-gradient(140deg,#22C3A6,#0EA5E9)",
      run: () => {
        if (onOpenKnowledgeDoc) onOpenKnowledgeDoc(h.path, h.wsSlug);
        else onNavigate("knowledge");
        onClose();
      },
    }));

    const meetingHits: LucianCommandItem[] = meetings
      .filter((m) => {
        if (!q) return true;
        return `${m.title} ${m.title_custom ?? ""} ${m.native_id ?? ""} ${m.platform}`.toLowerCase().includes(q);
      })
      .slice(0, 8)
      .map((m) => ({
        id: `m:${m.id}`,
        group: "Meetings",
        label: m.title_custom || m.title,
        detail: `${m.platform} · ${m.when}`,
        icon: "video",
        gradient: "linear-gradient(140deg,#176B5B,#10B981)",
        run: () => {
          onOpenMeeting(m.id);
          onClose();
        },
      }));

    const rawActions: LucianCommandItem[] = [
      {
        id: "act:capture",
        group: "Commands",
        label: "Capture or schedule a meeting",
        detail: "Send TINA bot to Google Meet, Zoom, Teams, Jitsi, or Discord",
        icon: "capture",
        shortcut: "Bot",
        run: () => {
          onClose();
          onOpenCapture();
        },
      },
      ...(!meetingsOnly
        ? [
            {
              id: "act:ask",
              group: "Commands",
              label: "Ask Tina",
              detail: "Chat across meetings and workspace knowledge",
              icon: "tinaAsk" as const,
              run: () => {
                onNavigate("ask");
                onClose();
              },
            },
            {
              id: "act:knowledge",
              group: "Commands",
              label: "Open Knowledge",
              detail: "My Space, Team Spaces, Templates & Guides, and Connections Map",
              icon: "bookOpen" as const,
              run: () => {
                onNavigate("knowledge");
                onClose();
              },
            },
            {
              id: "act:tasks",
              group: "Commands",
              label: "Open Tasks",
              detail: "Workspace action items and task files",
              icon: "listChecks" as const,
              run: () => {
                onNavigate("tasks");
                onClose();
              },
            },
            {
              id: "act:routines",
              group: "Commands",
              label: "Open Routines",
              detail: "Scheduled autonomous agents",
              icon: "skills" as const,
              run: () => {
                onNavigate("routines");
                onClose();
              },
            },
          ]
        : []),
      {
        id: "act:theme",
        group: "Commands",
        label: "Toggle light / dark mode",
        detail: "Switch between Obsidian Dark and Porcelain Light themes",
        icon: "sparkleSmall",
        run: () => {
          const next = getTheme() === "dark" ? "light" : "dark";
          applyTheme(next);
          emitWebToast(`Switched to ${next} mode`);
          onClose();
        },
      },
      {
        id: "act:settings",
        group: "Commands",
        label: "Open Settings",
        detail: "Models, transcription ASR, calendars, tokens, and voice",
        icon: "settings",
        run: () => {
          onNavigate("settings");
          onClose();
        },
      },
      ...(canOpenTerminal
        ? [
            {
              id: "act:terminal",
              group: "Commands",
              label: "Open TINA Terminal (Dev Workbench)",
              detail: terminalHref,
              icon: "terminal" as const,
              run: () => {
                window.location.href = terminalHref;
              },
            },
          ]
        : []),
    ];

    const actions = rawActions.filter((a) => !q || `${a.label} ${a.detail}`.toLowerCase().includes(q));
    return [...knowledgeHits, ...meetingHits, ...actions];
  }, [
    query,
    meetings,
    wikiHits,
    meetingsOnly,
    canOpenTerminal,
    terminalHref,
    onOpenMeeting,
    onOpenKnowledgeDoc,
    onClose,
    onOpenCapture,
    onNavigate,
  ]);

  if (!open) return null;

  return (
    <div className="tina-web-backdrop" role="dialog" aria-modal="true" aria-label="Search" onClick={onClose}>
      <LucianCommandPalette query={query} onQueryChange={setQuery} items={items} onClose={onClose} />
    </div>
  );
}
