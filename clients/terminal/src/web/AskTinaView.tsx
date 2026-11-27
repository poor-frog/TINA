"use client";
/** AskTinaView — Full-page Production AI Assistant backed by TINA's resumable SSE `/api/chat`,
 *  MCP Tool Approval cards (`/api/chat/approval`), real `/routine` prompt compilation, Copy/Share
 *  message actions, parsed context pills, and searchable `/api/sessions` history. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import { AgentActivitySteps, describeAgentTool } from "./AgentActivitySteps";
import { LucianThinkingText } from "./lucian/LucianThinkingText";
import { LucianToolApprovalCard } from "./lucian/LucianToolApprovalCard";
import { LucianVoiceInputButton } from "./lucian/LucianVoiceInputButton";
import { LucianSkeletonList } from "./lucian/LucianSkeletonCard";
import {
  LucianMentionChips,
  LucianMentionPopover,
  LucianMentionTriggerButton,
  detectMentionAtCursor,
  findMentionBeforeCursor,
  type MentionMatch,
  type MentionTarget,
} from "./lucian/LucianMentionPicker";
import { emitWebToast } from "./lucian/webToast";
import { Markdown } from "../ui-kit/Markdown";
import { startStreamingDictation, type StreamingDictation } from "../ui-kit/micDictation";
import { deleteSession, listSessions, sessionHistory, type SessionSummary } from "../surfaces/sessionsApi";
import { listWorkspaceTree, readActiveSet } from "../surfaces/workspaceApi";
import { streamChatTurn, type ChatPhase } from "../surfaces/chatStream";
import { routineCreationPrompt, stripContextBlocks } from "../surfaces/chat";
import { ApiError, presentError } from "../surfaces/apiClient";
import type { MeetingFocus } from "../surfaces/chatContext";
import { meetingPhase, type MeetingMock } from "../surfaces/meetingModel";
import type { ToolApprovalDecision, ToolApprovalState } from "../workbench/toolApproval";

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  ops?: string[];
  approvals?: ToolApprovalState[];
  commit?: string;
  error?: string;
}

export type AskTinaPrompt = {
  text: string;
  mode: "send" | "draft";
  meetingId?: string;
  focus?: MeetingFocus;
};

function newSessionId(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function parseSessionMs(stamp?: string | number | null): number {
  if (stamp == null || stamp === "") return 0;
  const ms =
    typeof stamp === "number"
      ? stamp > 1e12
        ? stamp
        : stamp * 1000
      : /^\d+(?:\.\d+)?$/.test(stamp.trim())
        ? Number(stamp) > 1e12
          ? Number(stamp)
          : Number(stamp) * 1000
        : Date.parse(stamp);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function formatSessionStamp(stamp?: string | number | null): string {
  const ms = parseSessionMs(stamp);
  if (!ms) return "";
  const diffMin = Math.floor((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type SessionTimeBucket = "Today" | "Yesterday" | "Previous 7 days" | "Older";

function sessionTimeBucket(stamp?: string | number | null): SessionTimeBucket {
  const ms = parseSessionMs(stamp);
  if (!ms) return "Older";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startToday) return "Today";
  if (ms >= startToday - 86_400_000) return "Yesterday";
  if (ms >= startToday - 7 * 86_400_000) return "Previous 7 days";
  return "Older";
}

function conversationTitle(title?: string | null): string {
  if (!title) return "Untitled conversation";
  // Older servers saved a flattened prefix, sometimes with the whole question truncated.
  const prefix = /^\s*\[Context: Space "/;
  if (!prefix.test(title)) return title;
  const body = parseUserContext(title).body;
  if (body !== title) return body;
  const question = title.match(/^\s*\[Context: Space ".*?\]\s+(.+)$/)?.[1];
  return question && question !== "…" ? question : "Untitled conversation";
}

/** Extract leading `[Context: ...]` metadata prepended by Knowledge/Meeting deep-links
 *  into human-friendly chips so raw bracket headers never clutter user chat bubbles. */
function parseUserContext(raw: string): { badges: string[]; body: string } {
  const match = raw.match(/^\s*\[Context:\s*([^\r\n]+)\]\s*(?:\r?\n)+([\s\S]*)$/);
  if (!match) return { badges: [], body: raw };
  const meta = match[1].trim();
  const body = match[2].trim();
  if (!body) return { badges: [], body: raw };

  const badges: string[] = [];
  const spaceMatch = meta.match(/Space\s+"([^"]+)"/i);
  if (spaceMatch) badges.push(`Space · ${spaceMatch[1]}`);
  const pageMatch = meta.match(/open page\s+"([^"]+)"/i);
  if (pageMatch) {
    const file = pageMatch[1].split("/").pop() || pageMatch[1];
    badges.push(file);
  }
  if (badges.length === 0) {
    badges.push(meta.replace(/\s*\(slug:[^)]*\)/gi, "").trim());
  }
  return { badges, body };
}

function agentPhaseLabel(phase: ChatPhase | null, hasText: boolean, lastOp?: string): string {
  if (hasText) return "Writing…";
  if (lastOp) return describeAgentTool(lastOp).active;
  if (phase === "connecting") return "Starting agent…";
  if (phase === "reconnecting") return "Reconnecting…";
  if (phase === "working") return "Working…";
  if (phase === "stalled") return "Still working…";
  return "Thinking…";
}

function friendlyMentionPageLabel(path: string): string {
  const base = path.split("/").pop() || path;
  return base
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function AskTinaView({
  meetings,
  initialPrompt,
  onConsumeInitialPrompt,
}: {
  meetings: MeetingMock[];
  initialPrompt: AskTinaPrompt | null;
  onConsumeInitialPrompt: () => void;
}) {
  const mentionListboxId = useId();
  const starterId = useId();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [activeSession, setActiveSession] = useState<string>(() => newSessionId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [selectedMeetingId, setSelectedMeetingId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [phase, setPhase] = useState<ChatPhase | null>(null);
  const [dictating, setDictating] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionListError, setSessionListError] = useState<string | null>(null);
  const [sessionListLoading, setSessionListLoading] = useState(true);
  const [actionFeedback, setActionFeedback] = useState<Record<string, string>>({});
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<string | null>(null);
  const [deletingSessions, setDeletingSessions] = useState<Record<string, boolean>>({});
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [workspaceDocs, setWorkspaceDocs] = useState<string[]>([]);
  const [activeSpaces, setActiveSpaces] = useState<Array<{ slug: string; name?: string | null }>>([]);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0);
  const [mentionDismissedAnchor, setMentionDismissedAnchor] = useState(-1);
  const [mentionedTargets, setMentionedTargets] = useState<MentionTarget[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<AbortController | null>(null);
  const dictRef = useRef<StreamingDictation | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const scopeWrapRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  const loadSessionList = useCallback(() => {
    setSessionListLoading(true);
    void listSessions()
      .then((rows) => {
        setSessions(rows);
        setSessionListError(null);
      })
      .catch((err: unknown) => {
        const { headline } = presentError(err);
        const unavailable = err instanceof ApiError && err.status === 404 &&
          err.detail === "agent endpoints are disabled in meetings mode";
        setSessionListError(unavailable ? "Chat history is unavailable for this account." : headline);
      })
      .finally(() => setSessionListLoading(false));
  }, []);

  useEffect(() => {
    loadSessionList();
    let mounted = true;
    void listWorkspaceTree()
      .then((files) => {
        if (mounted && Array.isArray(files)) setWorkspaceDocs(files);
      })
      .catch(() => undefined);
    void readActiveSet()
      .then((res) => {
        if (mounted && Array.isArray(res?.active)) {
          setActiveSpaces(res.active.map((m) => ({ slug: m.slug, name: m.name })));
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      abortRef.current?.abort();
      abortRef.current = null;
      historyRef.current?.abort();
      historyRef.current = null;
      dictRef.current?.cancel();
    };
  }, [loadSessionList]);

  useEffect(() => {
    if (!scopeMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (scopeWrapRef.current && !scopeWrapRef.current.contains(e.target as Node)) {
        setScopeMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScopeMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [scopeMenuOpen]);

  const handleThreadScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 96;
    isNearBottomRef.current = nearBottom;
    setShowScrollDown(!nearBottom && el.scrollHeight > el.clientHeight + 120);
  }, []);

  const scrollToBottom = useCallback(() => {
    isNearBottomRef.current = true;
    setShowScrollDown(false);
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, phase]);

  // Smooth auto-growing composer textarea up to 180px
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const filteredSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      `${conversationTitle(s.title)} ${s.session} ${formatSessionStamp(s.last_active || s.created)}`
        .toLowerCase()
        .includes(q),
    );
  }, [sessions, sessionQuery]);

  const groupedSessions = useMemo(() => {
    const order: SessionTimeBucket[] = ["Today", "Yesterday", "Previous 7 days", "Older"];
    const map = new Map<SessionTimeBucket, SessionSummary[]>();
    for (const s of filteredSessions) {
      const bucket = sessionTimeBucket(s.last_active || s.created);
      const list = map.get(bucket) ?? [];
      list.push(s);
      map.set(bucket, list);
    }
    return order
      .map((bucket) => ({ bucket, items: map.get(bucket) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [filteredSessions]);

  const selectedMeeting = useMemo(
    () => meetings.find((m) => m.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId],
  );

  const latestRecording = meetings.reduce<MeetingMock | undefined>((latest, meeting) => {
    if (meeting.status !== "past" || !meeting.has_recording) return latest;
    const stamp = meeting.end_time ?? meeting.start_time ?? "";
    const latestStamp = latest?.end_time ?? latest?.start_time ?? "";
    return !latest || stamp > latestStamp ? meeting : latest;
  }, undefined);

  const suggestedMeeting = selectedMeeting ?? latestRecording;

  const allMentionTargets = useMemo<MentionTarget[]>(() => {
    const out: MentionTarget[] = [];
    const seen = new Set<string>();

    for (const m of meetings.slice(0, 12)) {
      const label = (m.title_custom || m.title || "").trim();
      if (!label) continue;
      const key = `meeting:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        kind: "meeting",
        label,
        role: "Meeting",
        gradientA: "#7CCBFF",
        gradientB: "#3B6CF0",
        meetingId: m.id,
      });
    }

    for (const space of activeSpaces.slice(0, 8)) {
      const label = (space.name || space.slug || "").trim();
      if (!label) continue;
      const key = `space:${space.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        kind: "space",
        label,
        role: "Space",
        gradientA: "#D2C2FF",
        gradientB: "#7458F0",
        spaceSlug: space.slug,
      });
    }

    for (const file of workspaceDocs.filter((p) => /\.md$/i.test(p)).slice(0, 16)) {
      const label = friendlyMentionPageLabel(file);
      if (!label) continue;
      const key = `page:${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        kind: "page",
        label,
        role: "Page",
        gradientA: "#8EE3BE",
        gradientB: "#139A72",
        docPath: file,
      });
    }

    return out;
  }, [meetings, activeSpaces, workspaceDocs]);

  const filteredMentions = useMemo(() => {
    if (!mentionMatch) return [];
    const q = mentionMatch.query.trim().toLowerCase();
    const list = q
      ? allMentionTargets.filter(
          (item) =>
            item.label.toLowerCase().includes(q) ||
            item.role.toLowerCase().includes(q) ||
            (item.docPath && item.docPath.toLowerCase().includes(q)),
        )
      : allMentionTargets;
    return list.slice(0, 8);
  }, [allMentionTargets, mentionMatch]);

  const mentionOpen = Boolean(mentionMatch && filteredMentions.length > 0);

  const syncMentionState = useCallback(
    (nextValue: string, cursorPos: number) => {
      const match = detectMentionAtCursor(nextValue, cursorPos);
      if (!match) {
        setMentionDismissedAnchor(-1);
        setMentionMatch(null);
        return;
      }
      if (match.anchor === mentionDismissedAnchor) return;
      setMentionMatch((prev) => {
        if (!prev || prev.anchor !== match.anchor) setMentionActiveIdx(0);
        return match;
      });
    },
    [mentionDismissedAnchor],
  );

  const pickMention = useCallback(
    (target: MentionTarget) => {
      const el = composerRef.current;
      const cursor = el?.selectionStart ?? draft.length;
      const anchor = mentionMatch?.anchor ?? cursor;
      const insertion = `@${target.label} `;
      const nextValue = draft.slice(0, anchor) + insertion + draft.slice(cursor);
      const nextPos = anchor + insertion.length;

      setDraft(nextValue);
      setMentionMatch(null);
      setMentionDismissedAnchor(-1);
      setMentionedTargets((prev) => (prev.some((x) => x.id === target.id) ? prev : [...prev, target]));
      if (target.kind === "meeting" && target.meetingId) {
        setSelectedMeetingId(target.meetingId);
      }
      window.requestAnimationFrame(() => {
        if (!composerRef.current) return;
        composerRef.current.focus();
        composerRef.current.setSelectionRange(nextPos, nextPos);
      });
    },
    [draft, mentionMatch],
  );

  const insertAtMentionTrigger = useCallback(() => {
    const el = composerRef.current;
    if (mentionOpen && mentionMatch && mentionMatch.query === "") {
      setMentionDismissedAnchor(mentionMatch.anchor);
      setMentionMatch(null);
      el?.focus({ preventScroll: true });
      return;
    }
    const focused = el && document.activeElement === el;
    const start = focused ? (el.selectionStart ?? draft.length) : draft.length;
    const end = focused ? (el.selectionEnd ?? draft.length) : draft.length;
    const existing = start === end ? detectMentionAtCursor(draft, start) : null;
    if (existing && existing.query === "") {
      setMentionDismissedAnchor(-1);
      setMentionActiveIdx(0);
      setMentionMatch(existing);
      el?.focus({ preventScroll: true });
      return;
    }
    const before = draft.slice(0, start);
    const ins = (before && !/\s$/.test(before) ? " " : "") + "@";
    const nextValue = before + ins + draft.slice(end);
    const nextPos = start + ins.length;
    setDraft(nextValue);
    setMentionDismissedAnchor(-1);
    setMentionActiveIdx(0);
    setMentionMatch({ anchor: nextPos - 1, query: "" });
    el?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (!composerRef.current) return;
      composerRef.current.focus({ preventScroll: true });
      composerRef.current.setSelectionRange(nextPos, nextPos);
    });
  }, [draft, mentionMatch, mentionOpen]);

  const removeMentionChip = useCallback((id: string) => {
    setMentionedTargets((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target?.kind === "meeting" && target.meetingId && target.meetingId === selectedMeetingId) {
        setSelectedMeetingId("");
      }
      if (target) {
        setDraft((cur) => cur.replace(new RegExp(`@${target.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s?`, "g"), "").trimStart());
      }
      return prev.filter((x) => x.id !== id);
    });
  }, [selectedMeetingId]);

  const activeConversationTitle = useMemo(() => {
    const match = sessions.find((s) => s.session === activeSession);
    if (!match) return messages.length > 0 ? "Ask Tina" : "New conversation";
    const title = conversationTitle(match.title);
    if (title !== "Untitled conversation") return title;
    const question = messages.find((message) => message.role === "user");
    return question ? parseUserContext(question.text).body.slice(0, 60) : "New conversation";
  }, [sessions, activeSession, messages]);

  const sendMessage = useCallback(
    async (rawPrompt: string, meetingOverrideId?: string, focusOverride?: MeetingFocus) => {
      const displayPrompt = rawPrompt.trim();
      if (!displayPrompt || abortRef.current || historyRef.current) return;

      isNearBottomRef.current = true;
      setShowScrollDown(false);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const wirePrompt = /^\/routine(?:\s|$)/i.test(displayPrompt)
        ? routineCreationPrompt(displayPrompt, tz)
        : displayPrompt;

      const userId = `u-${Date.now()}`;
      const agentId = `a-${Date.now() + 1}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text: displayPrompt },
        { id: agentId, role: "agent", text: "", ops: [], approvals: [] },
      ]);
      setBusy(true);
      setPhase("connecting");

      const controller = new AbortController();
      abortRef.current = controller;

      const effectiveMeetingId = meetingOverrideId ?? focusOverride?.meeting_id ?? selectedMeetingId;
      const meeting = meetings.find((m) => m.id === effectiveMeetingId);
      const activeContext: MeetingFocus | undefined = meeting
        ? {
            kind: "meeting",
            meeting_id: meeting.id,
            platform: meeting.platform === "Google Meet" ? "google_meet" : meeting.platform.toLowerCase(),
            native_id: meeting.native_id || meeting.id,
            status: meeting.live_status,
            title: meeting.title_custom || meeting.title,
            ...(meeting.scheduled_at ? { scheduled_at: meeting.scheduled_at } : {}),
            ...(meeting.workspace_id ? { workspace_id: meeting.workspace_id } : {}),
            ...(focusOverride ?? {}),
          }
        : focusOverride;
      const isPrep =
        (meeting ? meetingPhase(meeting) === "prep" : false) ||
        activeContext?.status === "idle" ||
        activeContext?.status === "scheduled";

      try {
        await streamChatTurn(
          {
            prompt: wirePrompt,
            session: activeSession,
            active: activeContext,
            context: {
              tz,
              surface: activeContext
                ? { list: "meetings", tab: { kind: isPrep ? "meetingPrep" : "meeting" } }
                : { list: "ask" },
              focus: activeContext ?? null,
            },
          },
          {
            onStarting: () => {
              if (!controller.signal.aborted) setPhase("connecting");
            },
            onStatus: (nextPhase) => {
              if (!controller.signal.aborted) setPhase(nextPhase);
            },
            onDelta: (chunk) => {
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, text: m.text + chunk } : m)),
              );
            },
            onReply: (replyText) => {
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, text: replyText } : m)),
              );
            },
            onTool: (tool) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId ? { ...m, ops: [...(m.ops ?? []), tool] } : m,
                ),
              );
            },
            onApprovalRequest: (request) => {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== agentId) return m;
                  if (m.approvals?.some((a) => a.approval_id === request.approval_id)) return m;
                  return {
                    ...m,
                    approvals: [...(m.approvals ?? []), { ...request, status: "pending" }],
                  };
                }),
              );
            },
            onApprovalResolved: (resolved) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId
                    ? {
                        ...m,
                        approvals: m.approvals?.map((a) =>
                          a.approval_id === resolved.approval_id
                            ? { ...a, status: resolved.outcome, error: undefined }
                            : a,
                        ),
                      }
                    : m,
                ),
              );
              emitWebToast({
                message:
                  resolved.outcome === "approved"
                    ? "Tool action approved"
                    : resolved.outcome === "denied"
                      ? "Tool action denied"
                      : `Tool approval ${resolved.outcome}`,
                tone: resolved.outcome === "approved" ? "success" : "info",
              });
            },
            onCommit: (sha) => {
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, commit: sha || "saved" } : m)),
              );
              window.dispatchEvent(new Event("tina:tasks-changed"));
            },
            onRejected: () => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId
                    ? { ...m, error: "Workspace governance rejected changes from this turn." }
                    : m,
                ),
              );
            },
            onModelFailure: (reply) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId
                    ? { ...m, error: reply || "Model inference failed. Check Settings → Models." }
                    : m,
                ),
              );
            },
            onError: (msg) => {
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, error: msg } : m)),
              );
            },
          },
          { signal: controller.signal },
        );
      } catch (err) {
        if (!controller.signal.aborted) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === agentId ? { ...m, error: presentError(err).headline } : m,
            ),
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(false);
          setPhase(null);
          loadSessionList();
        }
      }
    },
    [activeSession, loadSessionList, meetings, selectedMeetingId],
  );

  const respondToApproval = async (approvalId: string, decision: ToolApprovalDecision) => {
    const turn = messagesRef.current.find(
      (m) => m.role === "agent" && m.approvals?.some((a) => a.approval_id === approvalId),
    );
    const approval = turn?.approvals?.find((a) => a.approval_id === approvalId);
    if (!turn || !approval || approval.status !== "pending") return;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === turn.id
          ? {
              ...m,
              approvals: m.approvals?.map((a) =>
                a.approval_id === approvalId ? { ...a, status: "submitting", error: undefined } : a,
              ),
            }
          : m,
      ),
    );

    try {
      const response = await fetch("/api/chat/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: activeSession,
          approval_id: approvalId,
          turn_id: approval.turn_id,
          decision,
        }),
      });
      if (!response.ok) throw new Error(`Approval response failed (${response.status})`);
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === turn.id
            ? {
                ...m,
                approvals: m.approvals?.map((a) =>
                  a.approval_id === approvalId && a.status === "submitting"
                    ? { ...a, status: "pending", error: "Could not send your decision. Try again." }
                    : a,
                ),
              }
            : m,
        ),
      );
    }
  };

  useEffect(() => {
    if (!initialPrompt) return;
    const { text, mode, meetingId, focus } = initialPrompt;
    const draftOnly = mode === "draft" || text.startsWith("/routine");
    if (!draftOnly && (busy || historyLoading)) return;
    onConsumeInitialPrompt();
    const resolvedMeetingId = meetingId ?? focus?.meeting_id;
    if (resolvedMeetingId) setSelectedMeetingId(resolvedMeetingId);
    if (draftOnly) {
      setDraft(text);
    } else if (text.trim()) {
      void sendMessage(text, resolvedMeetingId, focus);
    }
  }, [initialPrompt, onConsumeInitialPrompt, sendMessage, busy, historyLoading]);

  const switchSession = (sessionId: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    historyRef.current?.abort();
    historyRef.current = null;
    setActiveSession(sessionId);
    setMessages([]);
    setSessionError(null);
    setBusy(false);
    setPhase(null);
    setHistoryLoading(false);
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (deletingSessions[sessionId] || clearingAll) return;
    setDeletingSessions((cur) => ({ ...cur, [sessionId]: true }));
    setSessionError(null);
    try {
      await deleteSession(sessionId);
      setSessions((prev) => prev.filter((row) => row.session !== sessionId));
      setConfirmDeleteSession((cur) => (cur === sessionId ? null : cur));
      if (activeSession === sessionId) {
        switchSession(newSessionId());
      }
      emitWebToast({ message: "Conversation deleted", tone: "info" });
    } catch (err) {
      setSessionError(presentError(err).headline);
    } finally {
      setDeletingSessions((cur) => {
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
    }
  };

  const handleClearAllSessions = async () => {
    if (clearingAll || sessions.length === 0) return;
    const targets = sessions.map((s) => s.session);
    setClearingAll(true);
    setSessionError(null);
    try {
      const results = await Promise.allSettled(
        targets.map(async (id) => {
          await deleteSession(id);
          return id;
        }),
      );
      const deletedIds = new Set<string>();
      let firstError: unknown = null;
      for (const res of results) {
        if (res.status === "fulfilled") {
          deletedIds.add(res.value);
        } else if (firstError === null) {
          firstError = res.reason;
        }
      }
      if (deletedIds.size > 0) {
        setSessions((prev) => prev.filter((row) => !deletedIds.has(row.session)));
        if (deletedIds.has(activeSession)) {
          switchSession(newSessionId());
        }
        emitWebToast({
          message: `Cleared ${deletedIds.size} ${deletedIds.size === 1 ? "conversation" : "conversations"}`,
          tone: "info",
        });
      }
      setConfirmClearAll(false);
      setConfirmDeleteSession(null);
      if (firstError !== null) {
        setSessionError(presentError(firstError).headline);
        loadSessionList();
      }
    } finally {
      setClearingAll(false);
    }
  };

  const openSession = async (sessionId: string) => {
    switchSession(sessionId);
    const controller = new AbortController();
    historyRef.current = controller;
    setHistoryLoading(true);
    try {
      const hist = await sessionHistory(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      setMessages(
        hist.turns.map((t, idx) => ({
          id: `${sessionId}-${idx}`,
          role: t.role === "user" ? "user" : "agent",
          text: stripContextBlocks(t.text || ""),
          commit: typeof t.commit === "string" ? t.commit : undefined,
        })),
      );
    } catch (err) {
      if (!controller.signal.aborted) setSessionError(presentError(err).headline);
    } finally {
      if (historyRef.current === controller) {
        historyRef.current = null;
        setHistoryLoading(false);
      }
    }
  };

  const cancelMic = useCallback(() => {
    if (!dictRef.current) {
      setDictating(false);
      return;
    }
    const active = dictRef.current;
    dictRef.current = null;
    setDictating(false);
    active.cancel();
  }, []);

  const toggleMic = async () => {
    if (dictRef.current) {
      const active = dictRef.current;
      dictRef.current = null;
      setDictating(false);
      const finalText = await active.stop().catch(() => "");
      if (finalText.trim()) setDraft(finalText.trim());
      return;
    }
    try {
      setDictating(true);
      dictRef.current = await startStreamingDictation({
        onUpdate: (confirmed, pending) => {
          const text = [confirmed, pending].filter(Boolean).join(" ").trim();
          if (text) setDraft(text);
        },
        onError: (msg) => {
          setSessionError(msg);
          emitWebToast({ message: msg, tone: "error" });
        },
      });
    } catch (err) {
      setDictating(false);
      const msg = err instanceof Error ? err.message : "Microphone dictation is unavailable.";
      setSessionError(msg);
      emitWebToast({ message: msg, tone: "error" });
    }
  };

  const setTransientFeedback = (msgId: string, label: string) => {
    setActionFeedback((cur) => ({ ...cur, [msgId]: label }));
    window.setTimeout(() => {
      setActionFeedback((cur) => {
        if (cur[msgId] !== label) return cur;
        const next = { ...cur };
        delete next[msgId];
        return next;
      });
    }, 2200);
  };

  const copyMessage = async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setTransientFeedback(msgId, "Copied");
      emitWebToast("Copied response to clipboard");
    } catch {
      setTransientFeedback(msgId, "Copy unavailable");
      emitWebToast({ message: "Copy unavailable", tone: "error" });
    }
  };

  const shareMessage = async (msgId: string, text: string) => {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ title: "Ask Tina response", text });
        setTransientFeedback(msgId, "Shared");
        emitWebToast("Shared response");
      } else {
        await navigator.clipboard.writeText(text);
        setTransientFeedback(msgId, "Copied to share");
        emitWebToast("Copied response to share");
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        setTransientFeedback(msgId, "Share unavailable");
        emitWebToast({ message: "Share unavailable", tone: "error" });
      }
    }
  };

  const retryFromMessage = useCallback(
    (agentIndex: number) => {
      if (busy || historyLoading) return;
      for (let i = agentIndex - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          void sendMessage(messages[i].text);
          return;
        }
      }
    },
    [busy, historyLoading, messages, sendMessage],
  );

  const editUserMessage = useCallback((rawText: string) => {
    const clean = parseUserContext(rawText).body;
    setDraft(clean);
    composerRef.current?.focus();
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy || historyLoading) return;
    const text = draft;
    setDraft("");
    setMentionMatch(null);
    setMentionedTargets([]);
    void sendMessage(text);
  };

  const emptyConversation = !historyLoading && messages.length === 0;
  const draftStarter = (text: string) => {
    setDraft(text);
    setMentionMatch(null);
    setMentionedTargets([]);
    composerRef.current?.focus();
  };
  const historyIssue = sessionListError && (
    <div className="tina-web-ask-history-issue">
      <span role="alert">{sessionListError}</span>
      <button type="button" onClick={loadSessionList} disabled={sessionListLoading}>
        {sessionListLoading ? "Checking…" : "Retry history"}
      </button>
    </div>
  );

  const lastMessageId = messages[messages.length - 1]?.id;
  const showSlashHint = draft.startsWith("/") && !/^\/routine\s+\S/i.test(draft);

  const renderSessionRow = (s: SessionSummary) => {
    const stamp = formatSessionStamp(s.last_active || s.created);
    const label = conversationTitle(s.title);
    const isDeleting = Boolean(deletingSessions[s.session]);
    const isConfirming = confirmDeleteSession === s.session;
    return (
      <div
        key={s.session}
        className={`tina-web-session-item ${activeSession === s.session ? "active" : ""} ${isConfirming ? "confirming" : ""}`}
      >
        <button
          type="button"
          className={`tina-web-session-row ${activeSession === s.session ? "active" : ""}`}
          onClick={() => {
            setConfirmDeleteSession(null);
            setConfirmClearAll(false);
            void openSession(s.session);
          }}
        >
          <span className="tina-web-session-icon" aria-hidden="true">
            <WebIcon name="tinaAsk" size={13} />
          </span>
          <span className="tina-web-session-copy">
            <strong>{label}</strong>
            {stamp && <small>{stamp}</small>}
          </span>
        </button>

        {isConfirming ? (
          <div className="tina-web-session-confirm" role="group" aria-label={`Confirm delete ${label}`}>
            <button
              type="button"
              className="tina-web-session-confirm-del"
              disabled={isDeleting}
              onClick={() => void handleDeleteSession(s.session)}
            >
              {isDeleting ? "…" : "Delete"}
            </button>
            <button
              type="button"
              className="tina-web-session-confirm-cancel"
              aria-label="Cancel delete"
              disabled={isDeleting}
              onClick={() => setConfirmDeleteSession(null)}
            >
              <WebIcon name="close" size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="tina-web-session-delete-btn"
            aria-label={`Delete conversation ${label}`}
            title="Delete conversation"
            disabled={isDeleting || clearingAll}
            onClick={() => {
              setConfirmClearAll(false);
              setConfirmDeleteSession(s.session);
            }}
          >
            <WebIcon name="trash" size={13} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="tina-web-ask">
      <aside
        className={`tina-web-ask-sessions ${sidebarCollapsed ? "collapsed" : ""}`}
        aria-label="Chat sessions"
        aria-hidden={sidebarCollapsed || undefined}
      >
        <button
          type="button"
          className="tina-web-ask-new-btn"
          onClick={() => switchSession(newSessionId())}
        >
          <WebIcon name="plus" size={15} />
          <span>New conversation</span>
        </button>

        <label className="tina-web-settings-search tina-web-ask-search">
          <WebIcon name="search" size={14} />
          <input
            type="search"
            aria-label="Search conversations"
            placeholder="Search chats…"
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
          />
          {sessionQuery && (
            <button
              type="button"
              aria-label="Clear chat search"
              className="tina-web-ask-clear-btn"
              onClick={() => setSessionQuery("")}
            >
              <WebIcon name="close" size={12} />
            </button>
          )}
        </label>

        <div className="tina-web-ask-sessions-head">
          <div className="tina-web-channels-title">
            {sessionQuery.trim()
              ? `Matches (${filteredSessions.length})`
              : `Recent conversations (${sessions.length})`}
          </div>
          {!sessionQuery.trim() && sessions.length > 0 && (
            confirmClearAll ? (
              <div className="tina-web-session-confirm" role="group" aria-label="Confirm clear all conversations">
                <button
                  type="button"
                  className="tina-web-session-confirm-del"
                  disabled={clearingAll}
                  onClick={() => void handleClearAllSessions()}
                >
                  {clearingAll ? "Clearing…" : "Delete all"}
                </button>
                <button
                  type="button"
                  className="tina-web-session-confirm-cancel"
                  aria-label="Cancel clear all"
                  disabled={clearingAll}
                  onClick={() => setConfirmClearAll(false)}
                >
                  <WebIcon name="close" size={12} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="tina-web-ask-clear-all-btn"
                aria-label="Clear all conversations"
                title="Delete all old conversations"
                disabled={clearingAll}
                onClick={() => {
                  setConfirmDeleteSession(null);
                  setConfirmClearAll(true);
                }}
              >
                Clear all
              </button>
            )
          )}
        </div>

        <div
          className="tina-web-ask-session-list"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setConfirmDeleteSession(null);
              setConfirmClearAll(false);
            }
          }}
        >
          {sessionQuery.trim()
            ? filteredSessions.map(renderSessionRow)
            : groupedSessions.map((group) => (
                <div key={group.bucket} role="group" aria-label={group.bucket}>
                  <div className="tina-web-ask-session-group-label">{group.bucket}</div>
                  {group.items.map(renderSessionRow)}
                </div>
              ))}

          {!sidebarCollapsed && historyIssue}
          {!sessionListError && sessionListLoading && sessions.length === 0 && (
            <div role="status" className="tina-web-ask-sessions-empty">Loading conversations…</div>
          )}
          {!sessionListError && !sessionListLoading && filteredSessions.length === 0 && (
            <div className="tina-web-ask-sessions-empty">
              {sessions.length === 0
                ? "Conversations appear here after your first question."
                : "No conversations match that search."}
            </div>
          )}
        </div>
      </aside>

      <section className="tina-web-ask-main" data-empty={emptyConversation || undefined}>
        <header className="tina-web-ask-topbar">
          <div className="tina-web-ask-topbar-left">
            <button
              type="button"
              className="tina-web-ask-topbar-btn"
              aria-label="Toggle chat history"
              aria-pressed={!sidebarCollapsed}
              title={sidebarCollapsed ? "Show chat history" : "Hide chat history"}
              onClick={() => setSidebarCollapsed((v) => !v)}
            >
              <WebIcon name="sidebar" size={16} />
            </button>
            {sidebarCollapsed && (
              <button
                type="button"
                className="tina-web-ask-topbar-btn"
                aria-label="Start new conversation"
                title="New conversation"
                onClick={() => switchSession(newSessionId())}
              >
                <WebIcon name="plus" size={16} />
              </button>
            )}
            <span className="tina-web-ask-topbar-title">{activeConversationTitle}</span>
          </div>

          <div className="tina-web-ask-topbar-right">
            {selectedMeeting && (
              <span className="tina-web-ask-topbar-scope">
                <WebIcon name="video" size={12} />
                <span>{selectedMeeting.title_custom || selectedMeeting.title}</span>
                <button
                  type="button"
                  aria-label="Clear meeting focus"
                  title="Ask across all workspace & meetings"
                  onClick={() => setSelectedMeetingId("")}
                >
                  <WebIcon name="close" size={11} />
                </button>
              </span>
            )}
          </div>
        </header>

        <div ref={scrollRef} className="tina-web-ask-scroll" onScroll={handleThreadScroll}>
          <div className="tina-web-ask-thread">
            {sidebarCollapsed && historyIssue}
            {sessionError && (
              <div role="alert" className="tina-web-msg-error">
                <WebIcon name="alertTriangle" size={15} />
                <span className="tina-web-msg-error-text">{sessionError}</span>
              </div>
            )}

            {historyLoading ? (
              <div className="tina-web-ask-loading" style={{ padding: "12px 0" }}>
                <LucianSkeletonList count={3} variant="chat" label="Loading conversation…" />
              </div>
            ) : messages.length === 0 ? (
              <div className="tina-web-ask-hero">
                <h1 className="tina-web-ask-hero-title">
                  {selectedMeeting ? "Ask about this meeting" : "Ask Tina"}
                </h1>
                <p className="tina-web-ask-hero-sub">
                  {selectedMeeting
                    ? "Ask about what was said or decided in this meeting."
                    : "Ask questions about your meeting transcripts and workspace documents."}
                </p>
                <div className="tina-web-ask-starter-grid" role="group" aria-label="Suggested prompts">
                  {suggestedMeeting && (
                    <button
                      type="button"
                      className="tina-web-ask-starter-card tina-web-ask-starter-meeting"
                      aria-labelledby={`${starterId}-summary`}
                      aria-describedby={`${starterId}-summary-description`}
                      onClick={() => void sendMessage("What decisions and action items came out of this meeting?", suggestedMeeting.id)}
                    >
                      <WebIcon name="fileText" size={18} />
                      <span className="tina-web-ask-starter-copy">
                        <strong id={`${starterId}-summary`}>
                          {selectedMeeting ? "Summarize this meeting" : `Summarize ${suggestedMeeting.title_custom || suggestedMeeting.title}`}
                        </strong>
                        <span id={`${starterId}-summary-description`}>Get the key decisions and next steps.</span>
                      </span>
                      <WebIcon name="chevronRight" size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="tina-web-ask-starter-card"
                    aria-labelledby={`${starterId}-follow-ups`}
                    aria-describedby={`${starterId}-follow-ups-description`}
                    onClick={() => draftStarter("What follow-up actions were agreed on, and who owns them?")}
                  >
                    <WebIcon name="listChecks" size={18} />
                    <span className="tina-web-ask-starter-copy">
                      <strong id={`${starterId}-follow-ups`}>Find follow-up actions</strong>
                      <span id={`${starterId}-follow-ups-description`}>Review next steps and their owners.</span>
                    </span>
                    <WebIcon name="chevronRight" size={16} />
                  </button>
                  <button
                    type="button"
                    className="tina-web-ask-starter-card"
                    aria-labelledby={`${starterId}-routine`}
                    aria-describedby={`${starterId}-routine-description`}
                    onClick={() => draftStarter("/routine ")}
                  >
                    <WebIcon name="skills" size={18} />
                    <span className="tina-web-ask-starter-copy">
                      <strong id={`${starterId}-routine`}>Schedule a routine</strong>
                      <span id={`${starterId}-routine-description`}>Choose a schedule for a recurring task.</span>
                    </span>
                    <WebIcon name="chevronRight" size={16} />
                  </button>
                </div>
              </div>
            ) : (
              messages.map((msg, msgIndex) => {
                if (msg.role === "user") {
                  const parsed = parseUserContext(msg.text);
                  return (
                    <div key={msg.id} className="tina-web-msg user">
                      {parsed.badges.length > 0 && (
                        <div className="tina-web-msg-context-row" aria-label="Message context">
                          {parsed.badges.map((badge, idx) => (
                            <span key={`${badge}-${idx}`} className="tina-web-msg-context-pill">
                              <WebIcon name={badge.startsWith("Space") ? "layers" : "fileText"} size={11} />
                              <span>{badge}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="tina-web-msg-user-row">
                        <button
                          type="button"
                          className="tina-web-msg-user-edit"
                          aria-label="Edit message"
                          title="Edit and resend"
                          disabled={busy}
                          onClick={() => editUserMessage(msg.text)}
                        >
                          <WebIcon name="edit" size={13} />
                        </button>
                        <div className="tina-web-msg-bubble">{parsed.body}</div>
                      </div>
                    </div>
                  );
                }

                const isLatest = msg.id === lastMessageId;
                const isStreamingThis = busy && isLatest;
                const lastOp = msg.ops && msg.ops.length > 0 ? msg.ops[msg.ops.length - 1] : undefined;

                return (
                  <div key={msg.id} className={`tina-web-msg agent ${isLatest ? "latest" : ""}`}>
                    <div className="tina-web-agent-head">
                      <span className="tina-web-agent-avatar" aria-hidden="true">
                        <WebIcon name="tinaAsk" size={13} />
                      </span>
                      <span className="tina-web-agent-name">Tina</span>
                      {isStreamingThis && (
                        <span className="tina-web-agent-phase">
                          <span className="tina-web-agent-phase-dot" aria-hidden="true" />
                          <span>{agentPhaseLabel(phase, Boolean(msg.text), lastOp)}</span>
                        </span>
                      )}
                    </div>

                    <div className="tina-web-agent-content">
                      <div className="tina-web-msg-bubble">
                        {msg.ops && msg.ops.length > 0 && (
                          <AgentActivitySteps
                            ops={msg.ops}
                            streaming={isStreamingThis && !msg.text}
                            commit={msg.commit}
                          />
                        )}

                        {msg.text ? (
                          <div className="tina-web-agent-prose">
                            <Markdown>{msg.text}</Markdown>
                          </div>
                        ) : !msg.approvals?.length && !msg.error && !(msg.ops && msg.ops.length > 0) ? (
                          <LucianThinkingText
                            label={
                              phase === "reconnecting"
                                ? "Reconnecting to agent…"
                                : phase === "working"
                                  ? "Reading your workspace…"
                                  : "Thinking…"
                            }
                            lines={[
                              selectedMeeting
                                ? `Grounded on meeting: ${selectedMeeting.title_custom || selectedMeeting.title}`
                                : "Searching across meetings & knowledge spaces",
                              phase === "reconnecting"
                                ? "Restoring stream connection…"
                                : "Preparing response & verifying context",
                            ]}
                          />
                        ) : null}

                        {msg.approvals && msg.approvals.length > 0 && (
                          <div className="tina-web-approval-stack">
                            {msg.approvals.map((approval) => (
                              <LucianToolApprovalCard
                                key={approval.approval_id}
                                approval={approval}
                                onDecision={(id, decision) => void respondToApproval(id, decision)}
                              />
                            ))}
                          </div>
                        )}

                        {msg.commit && !(msg.ops && msg.ops.length > 0) && (
                          <div className="tina-web-commit-pill">
                            <WebIcon name="check" size={12} />
                            <span>Workspace updated ({msg.commit.slice(0, 7)})</span>
                          </div>
                        )}

                        {msg.error && (
                          <div role="alert" className="tina-web-msg-error">
                            <WebIcon name="alertTriangle" size={15} />
                            <span className="tina-web-msg-error-text">{msg.error}</span>
                            {!busy && (
                              <button
                                type="button"
                                className="tina-web-msg-retry-inline"
                                onClick={() => retryFromMessage(msgIndex)}
                              >
                                <WebIcon name="refresh" size={12} />
                                <span>Retry</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {msg.text && !isStreamingThis && (
                        <div className="tina-web-msg-actions" role="group" aria-label="Response actions">
                          <button
                            type="button"
                            className="tina-web-msg-action-btn"
                            aria-label={actionFeedback[msg.id] === "Copied" ? "Copied" : "Copy response"}
                            title="Copy response"
                            onClick={() => void copyMessage(msg.id, msg.text)}
                          >
                            <WebIcon name={actionFeedback[msg.id] === "Copied" ? "check" : "copy"} size={13} />
                            <span>{actionFeedback[msg.id] === "Copied" ? "Copied" : "Copy"}</span>
                          </button>
                          <button
                            type="button"
                            className="tina-web-msg-action-btn"
                            aria-label="Retry response"
                            title="Regenerate response"
                            disabled={busy}
                            onClick={() => retryFromMessage(msgIndex)}
                          >
                            <WebIcon name="refresh" size={13} />
                            <span>Retry</span>
                          </button>
                          <button
                            type="button"
                            className="tina-web-msg-action-btn"
                            aria-label="Share response"
                            title="Share response"
                            onClick={() => void shareMessage(msg.id, msg.text)}
                          >
                            <WebIcon name="share" size={13} />
                            <span>Share</span>
                          </button>
                          {actionFeedback[msg.id] && actionFeedback[msg.id] !== "Copied" && (
                            <span role="status" className="tina-web-msg-feedback">
                              {actionFeedback[msg.id]}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={endRef} />
          </div>
        </div>

        {showScrollDown && messages.length > 0 && (
          <button
            type="button"
            className="tina-web-ask-scroll-down"
            aria-label="Scroll to latest message"
            title="Scroll to latest message"
            onClick={scrollToBottom}
          >
            <WebIcon name="chevronDown" size={16} />
          </button>
        )}

        <div className="tina-web-ask-footer">
          {showSlashHint && (
            <div className="tina-web-ask-slash-hint">
              <button
                type="button"
                className="tina-web-ask-slash-btn"
                onClick={() => {
                  setDraft("/routine Every weekday at 9:00 AM, ");
                  composerRef.current?.focus();
                }}
              >
                <WebIcon name="skills" size={13} />
                <code>/routine</code>
                <span>Schedule a recurring Tina agent</span>
              </button>
            </div>
          )}

          <form className="tina-web-ask-form" onSubmit={onSubmit}>
            <LucianMentionPopover
              open={mentionOpen}
              listboxId={mentionListboxId}
              query={mentionMatch?.query ?? ""}
              items={filteredMentions}
              activeIndex={mentionActiveIdx}
              onHoverIndex={setMentionActiveIdx}
              onPick={pickMention}
            />
            <LucianMentionChips mentions={mentionedTargets} onRemove={removeMentionChip} />
            <textarea
              ref={composerRef}
              rows={1}
              value={draft}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={mentionOpen}
              aria-controls={mentionListboxId}
              aria-activedescendant={mentionOpen ? `${mentionListboxId}-opt-${Math.min(mentionActiveIdx, Math.max(0, filteredMentions.length - 1))}` : undefined}
              onChange={(e) => {
                const next = e.target.value;
                setDraft(next);
                syncMentionState(next, e.target.selectionStart ?? next.length);
              }}
              onClick={(e) => {
                const target = e.currentTarget;
                syncMentionState(target.value, target.selectionStart ?? target.value.length);
              }}
              onKeyUp={(e) => {
                if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) {
                  const target = e.currentTarget;
                  syncMentionState(target.value, target.selectionStart ?? target.value.length);
                }
              }}
              onBlur={(e) => {
                const next = e.relatedTarget as HTMLElement | null;
                if (next?.closest?.(".u451-pop, .u451-at")) return;
                setMentionMatch(null);
              }}
              onKeyDown={(e) => {
                if (mentionOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  setMentionActiveIdx((cur) => (cur + (e.key === "ArrowDown" ? 1 : -1) + filteredMentions.length) % filteredMentions.length);
                  return;
                }
                if (mentionOpen && (e.key === "Enter" || e.key === "Tab")) {
                  e.preventDefault();
                  const chosen = filteredMentions[Math.min(mentionActiveIdx, filteredMentions.length - 1)];
                  if (chosen) pickMention(chosen);
                  return;
                }
                if (mentionOpen && e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (mentionMatch) setMentionDismissedAnchor(mentionMatch.anchor);
                  setMentionMatch(null);
                  return;
                }
                if (e.key === "Backspace") {
                  const el = e.currentTarget;
                  const selStart = el.selectionStart ?? 0;
                  const selEnd = el.selectionEnd ?? 0;
                  if (selStart === selEnd && selStart > 0) {
                    const token = findMentionBeforeCursor(
                      draft,
                      selStart,
                      allMentionTargets.map((t) => t.label),
                    );
                    if (token) {
                      e.preventDefault();
                      const nextValue = draft.slice(0, selStart - token.length) + draft.slice(selStart);
                      const nextPos = selStart - token.length;
                      setDraft(nextValue);
                      const strippedLabel = token.slice(1);
                      setMentionedTargets((prev) => prev.filter((t) => t.label !== strippedLabel));
                      window.requestAnimationFrame(() => {
                        if (!composerRef.current) return;
                        composerRef.current.setSelectionRange(nextPos, nextPos);
                        syncMentionState(nextValue, nextPos);
                      });
                      return;
                    }
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
              placeholder={selectedMeeting ? "Ask about this meeting…" : "Ask a question or type @ to add context…"}
              aria-label="Message Ask Tina"
            />
            <div className="tina-web-ask-bar">
              <div className="tina-web-ask-bar-left">
                <LucianMentionTriggerButton
                  onClick={insertAtMentionTrigger}
                  disabled={busy || historyLoading}
                  expanded={mentionOpen}
                />
                <div ref={scopeWrapRef} className="tina-web-ask-scope-popover-wrap">
                  <button
                    type="button"
                    className={`tina-web-ask-scope-trigger ${selectedMeeting ? "active" : ""}`}
                    aria-label="Ground on meeting"
                    aria-haspopup="listbox"
                    aria-expanded={scopeMenuOpen}
                    onClick={() => setScopeMenuOpen((v) => !v)}
                  >
                    <WebIcon name={selectedMeeting ? "video" : "layers"} size={13} />
                    <span className="tina-web-ask-scope-label">
                      {selectedMeeting
                        ? `Meeting: ${selectedMeeting.title_custom || selectedMeeting.title}`
                        : "All workspace & meetings"}
                    </span>
                    <WebIcon name="chevronDown" size={12} />
                  </button>

                  {scopeMenuOpen && (
                    <div className="tina-web-ask-scope-menu" role="listbox" aria-label="Context scope">
                      <button
                        type="button"
                        role="option"
                        aria-selected={!selectedMeetingId}
                        className={`tina-web-ask-scope-option ${!selectedMeetingId ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedMeetingId("");
                          setScopeMenuOpen(false);
                        }}
                      >
                        <WebIcon name="layers" size={13} />
                        <span className="tina-web-ask-scope-option-text">All workspace &amp; meetings</span>
                        {!selectedMeetingId && <WebIcon name="check" size={13} />}
                      </button>

                      {meetings.length > 0 && (
                        <>
                          <div className="tina-web-ask-scope-section">Recent meetings</div>
                          {meetings.slice(0, 20).map((m) => {
                            const isSelected = m.id === selectedMeetingId;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                className={`tina-web-ask-scope-option ${isSelected ? "selected" : ""}`}
                                onClick={() => {
                                  setSelectedMeetingId(m.id);
                                  setScopeMenuOpen(false);
                                }}
                              >
                                <WebIcon name="video" size={13} />
                                <span className="tina-web-ask-scope-option-text">
                                  {m.title_custom || m.title}
                                </span>
                                {isSelected && <WebIcon name="check" size={13} />}
                              </button>
                            );
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="tina-web-ask-bar-right">
                {phase && (
                  <span className="tina-web-ask-live-pill">
                    <span className="tina-web-agent-phase-dot" aria-hidden="true" />
                    <span>
                      {phase === "connecting"
                        ? "Starting…"
                        : phase === "reconnecting"
                          ? "Reconnecting…"
                          : "Working…"}
                    </span>
                  </span>
                )}
                <LucianVoiceInputButton
                  recording={dictating}
                  disabled={historyLoading}
                  onToggle={() => void toggleMic()}
                  onCancel={cancelMic}
                />
                {busy ? (
                  <button
                    type="button"
                    className="tina-web-ask-stop-btn"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <WebIcon name="stop" size={12} />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="tina-web-ask-send-btn"
                    aria-label="Send"
                    title="Send message (Enter)"
                    disabled={!draft.trim() || historyLoading}
                  >
                    <WebIcon name="sendUp" size={15} strokeWidth={2.2} />
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
