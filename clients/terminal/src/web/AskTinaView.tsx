"use client";
/** AskTinaView — Full-page Production AI Assistant backed by TINA's resumable SSE `/api/chat`,
 *  MCP Tool Approval cards (`/api/chat/approval`), real `/routine` prompt compilation, Copy/Share
 *  message actions, parsed context pills, and searchable `/api/sessions` history. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { WebIcon, type WebIconName } from "./Icons";
import { Markdown } from "../ui-kit/Markdown";
import { startStreamingDictation, type StreamingDictation } from "../ui-kit/micDictation";
import { listSessions, sessionHistory, type SessionSummary } from "../surfaces/sessionsApi";
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

function formatSessionStamp(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diffMin = Math.floor((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

function agentPhaseLabel(phase: ChatPhase | null, hasText: boolean): string {
  if (hasText) return "Writing…";
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

  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<AbortController | null>(null);
  const dictRef = useRef<StreamingDictation | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
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

  const sendMessage = useCallback(
    async (rawPrompt: string, meetingOverrideId?: string) => {
      const displayPrompt = rawPrompt.trim();
      if (!displayPrompt || abortRef.current || historyRef.current) return;

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

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy || historyLoading) return;
    const text = draft;
    setDraft("");
    void sendMessage(text);
  };

  const lastMessageId = messages[messages.length - 1]?.id;

  return (
    <div className="tina-web-ask">
      <aside className="tina-web-ask-sessions" aria-label="Chat sessions">
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

        <div className="tina-web-channels-title">
          {sessionQuery.trim()
            ? `Matches (${filteredSessions.length})`
            : `Recent conversations (${sessions.length})`}
        </div>

        <div className="tina-web-ask-session-list">
          {filteredSessions.map((s) => {
            const stamp = formatSessionStamp(s.last_active || s.created);
            return (
              <button
                key={s.session}
                type="button"
                className={`tina-web-session-row ${activeSession === s.session ? "active" : ""}`}
                onClick={() => void openSession(s.session)}
              >
                <span className="tina-web-session-icon" aria-hidden="true">
                  <WebIcon name="tinaAsk" size={13} />
                </span>
                <span className="tina-web-session-copy">
                  <strong>{s.title || s.session}</strong>
                  {stamp && <small>{stamp}</small>}
                </span>
              </button>
            );
          })}

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
        <div className="tina-web-ask-scroll">
          <div className="tina-web-ask-thread">
            {sessionError && (
              <div role="alert" className="tina-web-msg-error">
                <WebIcon name="alertTriangle" size={15} />
                <span>{sessionError}</span>
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
              messages.map((msg) => {
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
                      <div className="tina-web-msg-bubble">{parsed.body}</div>
                    </div>
                  );
                }

                const isStreamingThis = busy && msg.id === lastMessageId;

                return (
                  <div key={msg.id} className="tina-web-msg agent">
                    <div className="tina-web-agent-head">
                      <span className="tina-web-agent-avatar" aria-hidden="true">
                        <WebIcon name="tinaAsk" size={14} />
                      </span>
                      <span className="tina-web-agent-name">Tina</span>
                      {isStreamingThis && (
                        <span className="tina-web-agent-phase">
                          <span className="tina-web-agent-phase-dot" aria-hidden="true" />
                          <span>{agentPhaseLabel(phase, Boolean(msg.text))}</span>
                        </span>
                      )}
                    </div>

                    <div className="tina-web-agent-content">
                      <div className="tina-web-msg-bubble">
                        {msg.ops && msg.ops.length > 0 && (
                          <div className="tina-web-ops-list">
                            {msg.ops.map((op, i) => (
                              <span key={`${op}-${i}`} className="tina-web-op-chip">
                                <WebIcon name="zap" size={11} />
                                <span>{op}</span>
                              </span>
                            ))}
                          </div>
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
                              {phase === "reconnecting"
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

                        {msg.commit && (
                          <div className="tina-web-commit-pill">
                            <WebIcon name="check" size={12} />
                            <span>Workspace updated ({msg.commit.slice(0, 7)})</span>
                          </div>
                        )}

                        {msg.error && (
                          <div role="alert" className="tina-web-msg-error">
                            <WebIcon name="alertTriangle" size={14} />
                            <span>{msg.error}</span>
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

        <div className="tina-web-ask-footer">
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
              placeholder="Ask Tina about any meeting, or type /routine to schedule an agent…"
              aria-label="Message Ask Tina"
            />
            <div className="tina-web-ask-bar">
              <div className="tina-web-ask-scope-wrap">
                <WebIcon name={selectedMeetingId ? "video" : "layers"} size={13} />
                <select
                  className="tina-web-ask-select"
                  aria-label="Ground on meeting"
                  value={selectedMeetingId}
                  onChange={(e) => setSelectedMeetingId(e.target.value)}
                >
                  <option value="">All workspace &amp; meetings</option>
                  {meetings.slice(0, 20).map((m) => (
                    <option key={m.id} value={m.id}>
                      Meeting: {m.title_custom || m.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="tina-web-ask-bar-right">
                {phase && (
                  <span className="tina-web-ask-live-pill">
                    <span className="tina-web-agent-phase-dot" aria-hidden="true" />
                    <span>
                      {phase === "connecting"
                        ? "Starting agent…"
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
                    <WebIcon name="stop" size={13} />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="tina-web-ask-send-btn"
                    aria-label="Send"
                    disabled={!draft.trim() || historyLoading}
                  >
                    <WebIcon name="sendUp" size={14} strokeWidth={2.2} />
                    <span>Send</span>
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
