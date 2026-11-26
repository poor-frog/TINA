"use client";
/** AskTinaView — Full-page Production AI Assistant backed by TINA's resumable SSE `/api/chat`,
 *  MCP Tool Approval cards (`/api/chat/approval`), real `/routine` prompt compilation, Copy/Share
 *  message actions, parsed context pills, and searchable `/api/sessions` history. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { WebIcon, type WebIconName } from "./Icons";
import { AgentActivitySteps, describeAgentTool } from "./AgentActivitySteps";
import { Markdown } from "../ui-kit/Markdown";
import { startStreamingDictation, type StreamingDictation } from "../ui-kit/micDictation";
import { deleteSession, listSessions, sessionHistory, type SessionSummary } from "../surfaces/sessionsApi";
import { streamChatTurn, type ChatPhase } from "../surfaces/chatStream";
import { routineCreationPrompt, stripContextBlocks } from "../surfaces/chat";
import { presentError } from "../surfaces/apiClient";
import type { MeetingMock } from "../surfaces/meetingModel";
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

export type AskTinaPrompt = { text: string; mode: "send" | "draft"; meetingId?: string };

interface StarterCard {
  id: string;
  icon: WebIconName;
  title: string;
  prompt: string;
  badge?: string;
}

const STARTERS: StarterCard[] = [
  {
    id: "brief",
    icon: "fileText",
    title: "Latest meeting brief",
    prompt: "Summarize key decisions and action items from my latest meeting.",
  },
  {
    id: "tasks",
    icon: "listChecks",
    title: "Open follow-ups",
    prompt: "What tasks are still open across my meetings?",
  },
  {
    id: "routine",
    icon: "skills",
    title: "Schedule a routine",
    badge: "/routine",
    prompt: "/routine Every weekday at 9:00 AM, prepare a short daily meeting brief.",
  },
];

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

/** Extract leading `[Context: ...]` metadata prepended by Knowledge/Meeting deep-links
 *  into human-friendly chips so raw bracket headers never clutter user chat bubbles. */
function parseUserContext(raw: string): { badges: string[]; body: string } {
  const match = raw.match(/^\s*\[Context:\s*([^\]]+)\]\s*(?:\r?\n)+([\s\S]*)$/);
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

export function AskTinaView({
  meetings,
  initialPrompt,
  onConsumeInitialPrompt,
}: {
  meetings: MeetingMock[];
  initialPrompt: AskTinaPrompt | null;
  onConsumeInitialPrompt: () => void;
}) {
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
  const [actionFeedback, setActionFeedback] = useState<Record<string, string>>({});
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<string | null>(null);
  const [deletingSessions, setDeletingSessions] = useState<Record<string, boolean>>({});
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);

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
    void listSessions()
      .then((rows) => {
        setSessions(rows);
        setSessionError(null);
      })
      .catch((err) => setSessionError(presentError(err).headline));
  }, []);

  useEffect(() => {
    loadSessionList();
    return () => {
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
      `${s.title || ""} ${s.session} ${formatSessionStamp(s.last_active || s.created)}`
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

  const activeConversationTitle = useMemo(() => {
    const match = sessions.find((s) => s.session === activeSession);
    if (match?.title) return match.title;
    return messages.length > 0 ? "Ask Tina" : "New conversation";
  }, [sessions, activeSession, messages.length]);

  const sendMessage = useCallback(
    async (rawPrompt: string, meetingOverrideId?: string) => {
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

      const effectiveMeetingId = meetingOverrideId ?? selectedMeetingId;
      const meeting = meetings.find((m) => m.id === effectiveMeetingId);
      const activeContext = meeting
        ? {
            kind: "meeting" as const,
            meeting_id: meeting.id,
            platform: meeting.platform === "Google Meet" ? "google_meet" : meeting.platform.toLowerCase(),
            native_id: meeting.native_id || meeting.id,
            status: meeting.live_status,
            title: meeting.title_custom || meeting.title,
          }
        : undefined;

      try {
        await streamChatTurn(
          {
            prompt: wirePrompt,
            session: activeSession,
            active: activeContext,
            context: {
              tz,
              surface: activeContext ? { list: "meetings", tab: { kind: "meeting" } } : { list: "ask" },
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
    const { text, mode, meetingId } = initialPrompt;
    const draftOnly = mode === "draft" || text.startsWith("/routine");
    if (!draftOnly && (busy || historyLoading)) return;
    onConsumeInitialPrompt();
    if (meetingId) setSelectedMeetingId(meetingId);
    if (draftOnly) {
      setDraft(text);
    } else if (text.trim()) {
      void sendMessage(text, meetingId);
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
        onError: (msg) => setSessionError(msg),
      });
    } catch (err) {
      setDictating(false);
      setSessionError(err instanceof Error ? err.message : "Microphone dictation is unavailable.");
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
    } catch {
      setTransientFeedback(msgId, "Copy unavailable");
    }
  };

  const shareMessage = async (msgId: string, text: string) => {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ title: "Ask Tina response", text });
        setTransientFeedback(msgId, "Shared");
      } else {
        await navigator.clipboard.writeText(text);
        setTransientFeedback(msgId, "Copied to share");
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        setTransientFeedback(msgId, "Share unavailable");
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
    void sendMessage(text);
  };

  const lastMessageId = messages[messages.length - 1]?.id;
  const showSlashHint = draft.startsWith("/") && !/^\/routine\s+\S/i.test(draft);

  const renderSessionRow = (s: SessionSummary) => {
    const stamp = formatSessionStamp(s.last_active || s.created);
    const label = s.title || s.session;
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

          {filteredSessions.length === 0 && (
            <div className="tina-web-ask-sessions-empty">
              {sessions.length === 0
                ? "Conversations appear here after your first question."
                : "No conversations match that search."}
            </div>
          )}
        </div>
      </aside>

      <section className="tina-web-ask-main">
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
            {sessionError && (
              <div role="alert" className="tina-web-msg-error">
                <WebIcon name="alertTriangle" size={15} />
                <span className="tina-web-msg-error-text">{sessionError}</span>
              </div>
            )}

            {historyLoading ? (
              <div className="tina-web-ask-loading" role="status">
                <span className="tina-web-typing-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span>Loading conversation…</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="tina-web-ask-hero">
                <div className="tina-web-ask-hero-badge" aria-hidden="true">
                  <WebIcon name="tinaAsk" size={24} />
                </div>
                <div className="tina-web-ask-hero-pill">
                  <WebIcon name="sparkleSmall" size={13} />
                  <span>Grounded in your meetings &amp; workspace</span>
                </div>
                <h1 className="tina-web-ask-hero-title">What would you like to know?</h1>
                <p className="tina-web-ask-hero-sub">
                  Ask across past meetings, draft follow-ups, create tasks, or schedule a recurring{" "}
                  <code>/routine</code>.
                </p>

                <div className="tina-web-ask-starter-grid">
                  {STARTERS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="tina-web-ask-starter-card"
                      disabled={historyLoading}
                      onClick={() => (s.prompt.startsWith("/routine") ? setDraft(s.prompt) : void sendMessage(s.prompt))}
                    >
                      <span className="tina-web-ask-starter-top">
                        <span className="tina-web-ask-starter-icon" aria-hidden="true">
                          <WebIcon name={s.icon} size={16} />
                        </span>
                        {s.badge && <code className="tina-web-ask-starter-tag">{s.badge}</code>}
                        <span className="tina-web-ask-starter-arrow" aria-hidden="true">
                          <WebIcon name="chevronRight" size={14} />
                        </span>
                      </span>
                      <span className="tina-web-ask-starter-title">{s.title}</span>
                      <span className="tina-web-ask-starter-prompt">{s.prompt}</span>
                    </button>
                  ))}
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
                        ) : !msg.approvals?.length && !msg.error ? (
                          <div className="tina-web-thinking" role="status">
                            <span className="tina-web-typing-dots" aria-hidden="true">
                              <span />
                              <span />
                              <span />
                            </span>
                            <span>
                              {lastOp
                                ? describeAgentTool(lastOp).active
                                : phase === "reconnecting"
                                  ? "Reconnecting to agent…"
                                  : phase === "working"
                                    ? "Reading your workspace…"
                                    : "Thinking…"}
                            </span>
                          </div>
                        ) : null}

                        {msg.approvals && msg.approvals.length > 0 && (
                          <div className="tina-web-approval-stack">
                            {msg.approvals.map((approval) => (
                              <WebToolApprovalCard
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
            <textarea
              ref={composerRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
              placeholder="Ask Tina about any meeting, workspace, or type /routine…"
              aria-label="Message Ask Tina"
            />
            <div className="tina-web-ask-bar">
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
                <button
                  type="button"
                  className={`tina-web-icon-btn ${dictating ? "recording" : ""}`}
                  aria-label={dictating ? "Stop dictation" : "Voice input"}
                  title={dictating ? "Stop dictation" : "Dictate with microphone"}
                  onClick={() => void toggleMic()}
                >
                  <WebIcon name="mic" size={16} />
                </button>
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

function WebToolApprovalCard({
  approval,
  onDecision,
}: {
  approval: ToolApprovalState;
  onDecision: (approvalId: string, decision: ToolApprovalDecision) => void;
}) {
  const isPending = approval.status === "pending";
  const isSubmitting = approval.status === "submitting";
  const resolvedLabel =
    approval.status === "approved"
      ? "Approved for this call"
      : approval.status === "denied"
        ? "Denied"
        : approval.status === "expired"
          ? "Approval expired; the tool was not called"
          : approval.status === "cancelled"
            ? "Approval cancelled"
            : "";

  return (
    <section
      className={`tina-web-approval-card ${approval.status}`}
      aria-label={`Approval required: ${approval.title}`}
    >
      <div className="tina-web-approval-head">
        <WebIcon name="zap" size={13} />
        <span>Approval required</span>
        <code>
          {approval.server}/{approval.tool}
        </code>
      </div>
      <div className="tina-web-approval-title">{approval.title}</div>
      {approval.description && <div className="tina-web-approval-desc">{approval.description}</div>}
      {approval.message && <div className="tina-web-approval-msg">{approval.message}</div>}

      {approval.parameters.length > 0 && (
        <dl className="tina-web-approval-params">
          {approval.parameters.map((param) => (
            <div key={param.name} className="tina-web-approval-param-row">
              <dt>{param.display_name}</dt>
              <dd>{param.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {isPending && (
        <div className="tina-web-approval-actions">
          <button
            type="button"
            className="tina-web-btn-primary"
            onClick={() => onDecision(approval.approval_id, "approve")}
          >
            <WebIcon name="check" size={13} />
            <span>Approve once</span>
          </button>
          <button
            type="button"
            className="tina-web-btn-danger-ghost"
            onClick={() => onDecision(approval.approval_id, "deny")}
          >
            <WebIcon name="close" size={13} />
            <span>Deny</span>
          </button>
        </div>
      )}

      {isSubmitting && (
        <div role="status" className="tina-web-approval-status">
          Sending decision…
        </div>
      )}
      {resolvedLabel && (
        <div role="status" className="tina-web-approval-status">
          {resolvedLabel}
        </div>
      )}
      {approval.error && (
        <div role="alert" className="tina-web-approval-error">
          {approval.error}
        </div>
      )}
    </section>
  );
}
