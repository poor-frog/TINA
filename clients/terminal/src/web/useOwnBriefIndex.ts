"use client";
/** useOwnBriefIndex — Lightweight single-fetch index of private brief notes under
 *  `kg/entities/meeting/*.md` so HomeView and MeetingsView can render accurate
 *  "No brief yet" / "Brief ready" indicators on upcoming meetings without N+1 requests. */
import { useCallback, useEffect, useState } from "react";
import { findBriefNote } from "../surfaces/briefNote";
import { listWorkspaceTree, readActiveSet } from "../surfaces/workspaceApi";
import type { MeetingMock } from "../surfaces/meetingModel";

export const BRIEF_CHANGED_EVENT = "tina:brief-changed";
const POLL_MS = 60_000;

export function notifyBriefChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(BRIEF_CHANGED_EVENT));
  }
}

export interface OwnBriefIndex {
  loaded: boolean;
  files: string[];
  hasBrief: (meeting: Pick<MeetingMock, "id" | "native_id" | "title" | "title_custom" | "workspace_id">) => boolean;
}

export function useOwnBriefIndex(enabled: boolean): OwnBriefIndex {
  const [files, setFiles] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setFiles([]);
      setLoaded(false);
      return;
    }
    let alive = true;
    let serial = 0;

    const load = async () => {
      const ticket = ++serial;
      try {
        const active = await readActiveSet();
        const mounts = active.active.filter((m) => m.role === "private" && m.write);
        const trees = await Promise.all(
          mounts.map((mount) => listWorkspaceTree({ slug: mount.slug }).catch(() => [] as string[])),
        );
        if (!alive || ticket !== serial) return;
        const merged = Array.from(
          new Set(trees.flat().filter((p) => p.startsWith("kg/entities/meeting/") && p.endsWith(".md"))),
        );
        setFiles(merged);
        setLoaded(true);
      } catch {
        /* fail quiet — avoid false "No brief yet" pills when workspace API is unreachable */
      }
    };

    void load();
    const onRefresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onChanged = () => {
      void load();
    };
    const timer = window.setInterval(onRefresh, POLL_MS);
    window.addEventListener("focus", onRefresh);
    window.addEventListener(BRIEF_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener(BRIEF_CHANGED_EVENT, onChanged);
    };
  }, [enabled]);

  const hasBrief = useCallback(
    (meeting: Pick<MeetingMock, "id" | "native_id" | "title" | "title_custom" | "workspace_id">) => {
      if (meeting.workspace_id) return true;
      return (
        findBriefNote(files, {
          title: meeting.title_custom || meeting.title,
          nativeId: meeting.native_id,
          meetingId: meeting.id,
        }) !== null
      );
    },
    [files],
  );

  return { loaded, files, hasBrief };
}
