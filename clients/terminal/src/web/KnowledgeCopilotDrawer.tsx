"use client";
/** KnowledgeCopilotDrawer — Refined inline Ask Tina AI side panel docked beside the Knowledge Hub.
 *  Streams live SSE answers grounded on the open page or space, presents tactile empty-state starter
 *  cards that collapse into compact follow-up chips during conversation, supports copyable replies,
 *  seeded prompts from uploaded files or Connections Map, and auto-refreshes on workspace commits. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { WebIcon, type WebIconName } from "./Icons";
import { AgentActivitySteps } from "./AgentActivitySteps";
import { LucianThinkingText } from "./lucian/LucianThinkingText";
import { emitWebToast } from "./lucian/webToast";
import { friendlyPageTitle } from "./knowledgeFriendly";
import { Markdown } from "../ui-kit/Markdown";
import { streamChatTurn, type ChatPhase } from "../surfaces/chatStream";
import styles from "./knowledgeView.module.css";

interface CopilotMsg {
  id: string;
  role: "user" | "agent";
  text: string;
  ops?: string[];
  commit?: string;
  error?: string;
}

interface QuickPromptItem {
  id: string;
  icon: WebIconName;
  title: string;
  shortLabel: string;
  subtitle: string;
  prompt: string;
}

function makeSessionId(slug?: string): string {
  const safe = (slug || "personal").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 28);
  return `kb-${safe}-${Date.now().toString(36)}`;
}

const KNOWLEDGE_WRITE_TOOLS = new Set(["create_wiki", "update_wiki", "delete_wiki", "move_wiki", "Write", "Edit"]);

function toolPhaseLabel(tool: string): string {
  switch (tool) {
    case "list_wiki":
      return "Browsing your library…";
    case "search_wiki":
      return "Searching your library…";
    case "read_wiki":
    case "Read":
      return "Reading page…";
    case "create_wiki":
    case "Write":
      return "Creating page in Knowledge…";
    case "update_wiki":
    case "Edit":
      return "Updating page in Knowledge…";
    case "delete_wiki":
      return "Deleting page in Knowledge…";
    case "move_wiki":
      return "Moving page in Knowledge…";
    case "reach_web_search":
    case "WebSearch":
      return "Searching the web…";
    case "reach_web_read":
    case "WebFetch":
      return "Reading web page…";
    case "reach_github_search":
    case "reach_github_read":
      return "Checking GitHub…";
    default:
      return "Working…";
  }
}

function phaseLabel(phase: ChatPhase | null, hasText = false, activeTool?: string | null): string {
  if (hasText) return "Writing…";
  if (activeTool) return toolPhaseLabel(activeTool);
  if (phase === "working") return "Reading your library…";
  if (phase === "reconnecting") return "Reconnecting…";
  if (phase === "stalled") return "Still working…";
  return "Thinking…";
}

export function KnowledgeCopilotDrawer({
  open,
  workspaceName,
  slug,
  docPath,
  docTitle,
  isReadOnly,
  devView = false,
  initialPrompt,
  onConsumeInitialPrompt,
  onClose,
  onWorkspaceMutated,
  onOpenFullAsk,
}: {
  open: boolean;
  workspaceName: string;
  slug?: string;
  docPath: string | null;
  docTitle?: string | null;
  isReadOnly: boolean;
  devView?: boolean;
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
  onClose: () => void;
  onWorkspaceMutated: () => void;
  onOpenFullAsk?: (prompt: string) => void;
}) {
  const [session, setSession] = useState<string>(() => makeSessionId(slug));
  const [messages, setMessages] = useState<CopilotMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ChatPhase | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setPhase(null);
    setActiveTool(null);
    setSession(makeSessionId(slug));
    setMessages([]);
  }, [slug]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, phase]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Auto-resize composer textarea cleanly up to 140px
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input, open]);

  const sendPrompt = useCallback(
    async (rawText: string) => {
      const prompt = rawText.trim();
      if (!prompt || abortRef.current) return;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const userId = `cu-${Date.now()}`;
      const agentId = `ca-${Date.now() + 1}`;

      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text: prompt },
        { id: agentId, role: "agent", text: "", ops: [] },
      ]);
      setBusy(true);
      setPhase("connecting");
      setActiveTool(null);
      let mutatedInTurn = false;
      let commitSeen = false;

      const controller = new AbortController();
      abortRef.current = controller;

      const groundedPrompt = docPath
        ? `[Context: Space "${workspaceName}"${slug ? ` (slug: ${slug})` : ""}, open page "${docPath}"${isReadOnly ? " (view-only)" : ""}]\n\n${prompt}`
        : `[Context: Space "${workspaceName}"${slug ? ` (slug: ${slug})` : ""}]\n\n${prompt}`;

      const focusPayload = docPath
        ? ({ kind: "file", ref: `@file:${docPath}` } as const)
        : slug && slug !== "_global"
          ? ({ kind: "workspace", slug } as const)
          : null;

      try {
        await streamChatTurn(
          {
            prompt: groundedPrompt,
            session,
            active: focusPayload ?? undefined,
            context: {
              tz,
              surface: { list: "files", tab: { kind: docPath ? "doc" : "workspace" } },
              focus: focusPayload,
            },
          },
          {
            onStarting: () => {
              if (!controller.signal.aborted) setPhase("connecting");
            },
            onStatus: (next) => {
              if (!controller.signal.aborted) setPhase(next);
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
              if (!controller.signal.aborted) setActiveTool(tool);
              if (KNOWLEDGE_WRITE_TOOLS.has(tool)) mutatedInTurn = true;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId ? { ...m, ops: [...(m.ops ?? []), tool] } : m,
                ),
              );
            },
            onCommit: (sha) => {
              commitSeen = true;
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, commit: sha || "saved" } : m)),
              );
              onWorkspaceMutated();
            },
            onRejected: () => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId ? { ...m, error: "This space does not allow that change." } : m,
                ),
              );
            },
            onModelFailure: (reply) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId ? { ...m, error: reply || "Tina could not complete that response." } : m,
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
      } finally {
        if (mutatedInTurn && !commitSeen && !controller.signal.aborted) {
          onWorkspaceMutated();
        }
        abortRef.current = null;
        setBusy(false);
        setPhase(null);
        setActiveTool(null);
      }
    },
    [docPath, workspaceName, slug, isReadOnly, session, onWorkspaceMutated],
  );

  // Auto-send seeded prompts (e.g., "Ask Tina to summarize this file" or from Connections Map)
  useEffect(() => {
    if (!open || !initialPrompt) return;
    const text = initialPrompt;
    onConsumeInitialPrompt?.();
    void sendPrompt(text);
  }, [open, initialPrompt, onConsumeInitialPrompt, sendPrompt]);

  const targetLabel = docTitle || (docPath ? friendlyPageTitle(docPath) : workspaceName);

  const quickPrompts = useMemo<QuickPromptItem[]>(
    () => [
      {
        id: "summarize",
        icon: "fileText",
        title: docPath ? "Summarize page" : "Summarize space",
        shortLabel: docPath ? "Summarize" : "Summarize space",
        subtitle: docPath
          ? "Key points, decisions & open questions"
          : "Overview of top pages and themes",
        prompt: docPath
          ? `Summarize "${targetLabel}" in clear bullet points with key decisions and open questions.`
          : `Give me an overview of the most important pages in ${workspaceName}.`,
      },
      {
        id: "actions",
        icon: "listChecks",
        title: "Find action items",
        shortLabel: "Action items",
        subtitle: docPath
          ? "Extract tasks, owners & next steps"
          : "Open tasks and follow-ups across pages",
        prompt: docPath
          ? `List all action items and owners mentioned in "${targetLabel}"${isReadOnly ? " (do not modify view-only pages)" : ""}.`
          : `List open tasks and follow-ups across ${workspaceName}.`,
      },
      {
        id: "links",
        icon: "network",
        title: "Suggest links",
        shortLabel: "Suggest links",
        subtitle: docPath
          ? "Related pages to connect & clarify"
          : "Discover pages that belong together",
        prompt: docPath
          ? `Suggest related pages in ${workspaceName} to link with "${targetLabel}" and ways to make this page clearer.`
          : `Suggest which pages in ${workspaceName} are related and should be connected.`,
      },
    ],
    [docPath, isReadOnly, targetLabel, workspaceName],
  );

  const handleCopy = useCallback(async (msgId: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(msgId);
      emitWebToast("Copied response to clipboard");
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedId((cur) => (cur === msgId ? null : cur));
      }, 1800);
    } catch {
      /* ignore clipboard denial */
    }
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const text = input;
    setInput("");
    void sendPrompt(text);
  };

  if (!open) return null;

  const lastMessageId = messages[messages.length - 1]?.id;

  return (
    <aside className={styles.copilotDrawer} aria-label="Ask Tina assistant">
      <header className={styles.copilotHead}>
        <div className={styles.copilotIdentity}>
          <span className={styles.copilotBrandIcon} aria-hidden="true">
            <WebIcon name="tinaAsk" size={16} />
          </span>
          <div className={styles.copilotHeadingMeta}>
            <div className={styles.copilotTitleRow}>
              <span className={styles.copilotTitle}>Ask Tina</span>
              {busy ? (
                <span className={styles.copilotLiveBadge}>
                  <span className={styles.copilotLiveDot} aria-hidden="true" />
                  Live
                </span>
              ) : isReadOnly ? (
                <span className={styles.copilotReadonlyPill}>View-only</span>
              ) : null}
            </div>
            <div className={styles.copilotSub} title={devView && docPath ? docPath : targetLabel}>
              <WebIcon name={docPath ? "fileText" : "layers"} size={11} />
              <span>{docPath ? `Reading ${targetLabel}` : `Space · ${workspaceName}`}</span>
            </div>
          </div>
        </div>

        <div className={styles.copilotHeadActions}>
          {onOpenFullAsk && (
            <button
              type="button"
              className={styles.copilotIconBtn}
              title="Open full-screen Ask Tina"
              aria-label="Open full-screen Ask Tina"
              onClick={() =>
                onOpenFullAsk(
                  docPath
                    ? `Help me work on "${targetLabel}" in ${workspaceName}.`
                    : `Help me explore ${workspaceName}.`,
                )
              }
            >
              <WebIcon name="externalLink" size={14} />
            </button>
          )}
          <button
            type="button"
            className={styles.copilotIconBtn}
            title="Start a new chat"
            aria-label="Start a new chat"
            disabled={messages.length === 0 && !busy}
            onClick={() => {
              abortRef.current?.abort();
              setMessages([]);
              setSession(makeSessionId(slug));
            }}
          >
            <WebIcon name="refresh" size={14} />
          </button>
          <button
            type="button"
            className={styles.copilotIconBtn}
            title="Close Ask Tina"
            aria-label="Close Ask Tina"
            onClick={onClose}
          >
            <WebIcon name="close" size={15} />
          </button>
        </div>
      </header>

      <div className={styles.copilotFeed}>
        {messages.length === 0 ? (
          <div className={styles.copilotEmpty}>
            <h3 className={styles.copilotHeroTitle}>
              {docPath ? `Ask about ${targetLabel}` : `How can I help with ${workspaceName}?`}
            </h3>
            <p className={styles.copilotHeroDesc}>
              {isReadOnly
                ? `Explore ${targetLabel}, cross-check past meetings, and surface answers instantly.`
                : `Compare notes with past meetings, find decisions, or draft edits — updates sync here automatically.`}
            </p>

            <div className={styles.copilotStarterList} role="group" aria-label="Suggested prompts">
              {quickPrompts.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.copilotStarterCard}
                  disabled={busy}
                  onClick={() => void sendPrompt(item.prompt)}
                >
                  <span className={styles.copilotStarterIcon} aria-hidden="true">
                    <WebIcon name={item.icon} size={15} />
                  </span>
                  <span className={styles.copilotStarterCopy}>
                    <span className={styles.copilotStarterTitle}>{item.title}</span>
                    <span className={styles.copilotStarterSub}>{item.subtitle}</span>
                  </span>
                  <span className={styles.copilotStarterArrow} aria-hidden="true">
                    <WebIcon name="chevronRight" size={14} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.copilotThread}>
            {messages.map((m, idx) => {
              const isStreamingThis = busy && m.role === "agent" && m.id === lastMessageId;

              if (m.role === "user") {
                return (
                  <div key={m.id} className={styles.copilotTurnUser}>
                    <div className={styles.copilotBubbleUser}>{m.text}</div>
                  </div>
                );
              }

              const retryPreviousPrompt = () => {
                if (busy) return;
                for (let i = idx - 1; i >= 0; i--) {
                  if (messages[i]?.role === "user") {
                    void sendPrompt(messages[i].text);
                    return;
                  }
                }
              };

              return (
                <div key={m.id} className={styles.copilotTurnAgent}>
                  <div className={styles.copilotAgentMeta}>
                    <span className={styles.copilotAgentAvatar} aria-hidden="true">
                      <WebIcon name="sparkleSmall" size={12} />
                    </span>
                    <span className={styles.copilotAgentName}>Tina</span>
                    {isStreamingThis && (
                      <span className={styles.copilotPhaseHint}>{phaseLabel(phase, Boolean(m.text), activeTool)}</span>
                    )}
                    {m.text && !isStreamingThis && (
                      <div className={styles.copilotAgentMetaActions}>
                        <button
                          type="button"
                          className={styles.copilotCopyBtn}
                          aria-label="Retry response"
                          title="Regenerate response"
                          disabled={busy}
                          onClick={retryPreviousPrompt}
                        >
                          <WebIcon name="refresh" size={12} />
                          <span>Retry</span>
                        </button>
                        <button
                          type="button"
                          className={styles.copilotCopyBtn}
                          aria-label="Copy response"
                          title={copiedId === m.id ? "Copied" : "Copy response"}
                          onClick={() => void handleCopy(m.id, m.text)}
                        >
                          <WebIcon name={copiedId === m.id ? "check" : "copy"} size={12} />
                          <span>{copiedId === m.id ? "Copied" : "Copy"}</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <div className={styles.copilotAgentBody}>
                    {m.ops && m.ops.length > 0 && (
                      <AgentActivitySteps
                        ops={m.ops}
                        streaming={isStreamingThis && !m.text}
                        commit={m.commit}
                        compact
                        showRawToolNames={devView}
                      />
                    )}

                    {m.text ? (
                      <div className={`${styles.docProse} ${styles.copilotProse}`}>
                        <Markdown>{m.text}</Markdown>
                      </div>
                    ) : !m.error && !(m.ops && m.ops.length > 0) ? (
                      <LucianThinkingText
                        compact
                        label={phaseLabel(phase, false, activeTool)}
                        lines={[
                          docPath ? `Reading ${targetLabel}` : `Grounding on ${workspaceName}`,
                          phase === "reconnecting"
                            ? "Reconnecting stream…"
                            : "Reviewing linked pages & meetings",
                        ]}
                      />
                    ) : null}

                    {m.commit && (
                      <div className={styles.copilotCommit}>
                        <WebIcon name="check" size={12} />
                        <span>
                          {devView
                            ? `Updated workspace (${m.commit.slice(0, 7)}) — refreshed`
                            : "Updated space · refreshed"}
                        </span>
                      </div>
                    )}

                    {m.error && (
                      <div className={styles.copilotErr} role="alert">
                        <WebIcon name="alertTriangle" size={13} />
                        <span>{m.error}</span>
                        {!busy && (
                          <button type="button" className={styles.copilotRetryInline} onClick={retryPreviousPrompt}>
                            <WebIcon name="refresh" size={11} />
                            <span>Retry</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className={styles.copilotDock}>
        {messages.length > 0 && (
          <div className={styles.copilotQuickStrip} role="group" aria-label="Quick follow-up prompts">
            {quickPrompts.map((item) => (
              <button
                key={item.id}
                type="button"
                className={styles.copilotQuickPill}
                disabled={busy}
                onClick={() => void sendPrompt(item.prompt)}
              >
                <WebIcon name={item.icon} size={12} />
                <span>{item.shortLabel}</span>
              </button>
            ))}
          </div>
        )}

        <form className={styles.copilotComposer} onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            className={styles.copilotInput}
            rows={1}
            aria-label="Ask Tina a question"
            placeholder={`Ask Tina about ${targetLabel}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />
          <div className={styles.copilotComposerBar}>
            <div className={styles.copilotComposerContext} title={targetLabel}>
              <span className={styles.copilotContextDot} aria-hidden="true" />
              <span className={styles.copilotContextText}>
                {busy ? "Tina is writing…" : targetLabel}
              </span>
            </div>

            <div className={styles.copilotComposerActions}>
              {!busy && (
                <span className={styles.copilotKeyHint} aria-hidden="true">
                  ↵
                </span>
              )}
              {busy ? (
                <button
                  type="button"
                  className={styles.copilotStopBtn}
                  aria-label="Stop"
                  title="Stop generating"
                  onClick={() => abortRef.current?.abort()}
                >
                  <WebIcon name="stop" size={12} />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className={styles.copilotSendBtn}
                  aria-label="Send"
                  title="Send message (Enter)"
                  disabled={!input.trim()}
                >
                  <WebIcon name="sendUp" size={14} strokeWidth={2.2} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </aside>
  );
}
