"use client";
/** KnowledgeCopilotDrawer — Refined inline Ask Tina AI side panel docked beside the Knowledge Hub.
 *  Streams live SSE answers grounded on the open page or space, presents tactile empty-state starter
 *  cards that collapse into compact follow-up chips during conversation, supports copyable replies,
 *  seeded prompts from uploaded files or Connections Map, and auto-refreshes on workspace commits. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { WebIcon, type WebIconName } from "./Icons";
import { AgentActivitySteps, normalizeAgentToolName } from "./AgentActivitySteps";
import { LucianThinkingText } from "./lucian/LucianThinkingText";
import {
  LucianMentionChips,
  LucianMentionPopover,
  LucianMentionTriggerButton,
  compileMentionContext,
  type MentionTarget,
} from "./lucian/LucianMentionPicker";
import {
  LucianSlashPopover,
  LucianSlashTriggerButton,
  compileSlashPrompt,
  type SlashCommandDef,
  type SlashCommandId,
} from "./lucian/LucianSlashPicker";
import { useChatComposerPickers } from "./lucian/useChatComposerPickers";
import { buildMentionCatalog, saveReplyToKnowledge } from "./chatComposerUtils";
import { emitWebToast } from "./lucian/webToast";
import { friendlyPageTitle } from "./knowledgeFriendly";
import { Markdown } from "../ui-kit/Markdown";
import { streamChatTurn, type ChatPhase } from "../surfaces/chatStream";
import type { FocusPayload } from "../surfaces/chatContext";
import { listWorkspaceTree, readActiveSet } from "../surfaces/workspaceApi";
import styles from "./knowledgeView.module.css";

const COPILOT_SLASH_IDS: readonly SlashCommandId[] = [
  "research",
  "draft",
  "tasks",
  "schedule",
  "save",
  "new",
];

interface CopilotMsg {
  id: string;
  role: "user" | "agent";
  text: string;
  ops?: string[];
  commit?: string;
  error?: string;
  mentions?: MentionTarget[];
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

const KNOWLEDGE_WRITE_TOOLS = new Set(["create_wiki", "update_wiki", "delete_wiki", "move_wiki", "Write", "Edit", "FileChange"]);

function toolPhaseLabel(tool: string): string {
  switch (normalizeAgentToolName(tool)) {
    case "list_wiki":
    case "Glob":
      return "Browsing your library…";
    case "search_wiki":
    case "Grep":
      return "Searching your library…";
    case "read_wiki":
    case "Read":
      return "Reading page…";
    case "create_wiki":
    case "Write":
      return "Creating page in Knowledge…";
    case "update_wiki":
    case "Edit":
    case "FileChange":
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
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const [workspaceDocs, setWorkspaceDocs] = useState<string[]>([]);
  const [spaces, setSpaces] = useState<Array<{ slug: string; name?: string | null }>>([]);
  const [mentionedItems, setMentionedItems] = useState<MentionTarget[]>([]);
  const [includeSchedule, setIncludeSchedule] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const messagesRef = useRef<CopilotMsg[]>([]);
  const savingIdsRef = useRef<Record<string, boolean>>({});
  const submitRef = useRef<() => void>(() => undefined);
  const instantSlashRef = useRef<(cmd: SlashCommandDef) => void>(() => undefined);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const mentionCatalog = useMemo(
    () =>
      buildMentionCatalog({
        spaces,
        workspaceDocs,
        includeScheduleOption: true,
        includeTasksShortcut: true,
      }),
    [spaces, workspaceDocs],
  );

  const handlePickMentionExtra = useCallback((item: MentionTarget) => {
    if (item.kind === "schedule") setIncludeSchedule(true);
  }, []);

  const handleRemoveMentionExtra = useCallback((item: MentionTarget) => {
    if (item.kind === "schedule") setIncludeSchedule(false);
  }, []);

  const pickers = useChatComposerPickers({
    value: input,
    setValue: setInput,
    textareaRef: inputRef,
    mentionCatalog,
    mentionLimit: 8,
    allowedSlashIds: COPILOT_SLASH_IDS,
    mentionedTargets: mentionedItems,
    setMentionedTargets: setMentionedItems,
    onPickMentionExtra: handlePickMentionExtra,
    onRemoveMentionExtra: handleRemoveMentionExtra,
    onInstantSlash: (cmd) => instantSlashRef.current(cmd),
    onSubmit: () => submitRef.current(),
  });
  const closePickers = pickers.closePickers;

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setPhase(null);
    setActiveTool(null);
    setSession(makeSessionId(slug));
    setMessages([]);
    setMentionedItems([]);
    closePickers();
    setIncludeSchedule(false);
  }, [closePickers, slug]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listWorkspaceTree({ slug })
      .then((files) => {
        if (alive && Array.isArray(files)) setWorkspaceDocs(files);
      })
      .catch(() => undefined);
    void readActiveSet()
      .then((res) => {
        if (alive && Array.isArray(res?.active)) {
          setSpaces(res.active.map((w) => ({ slug: w.slug, name: w.name })));
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, slug]);

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

  const saveCopilotReply = useCallback(
    async (replyText: string, msgId?: string) => {
      if (isReadOnly) {
        emitWebToast({ message: "Space này đang ở chế độ chỉ đọc (view-only).", tone: "info" });
        return;
      }
      const lockKey = msgId || "__slash_save__";
      if (savingIdsRef.current[lockKey]) return;
      savingIdsRef.current = { ...savingIdsRef.current, [lockKey]: true };
      setSavingIds(savingIdsRef.current);
      try {
        const { path } = await saveReplyToKnowledge({
          replyText,
          titleHint: docTitle || undefined,
          slug: slug && slug !== "_global" ? slug : undefined,
        });
        if (msgId) {
          setSavedId(msgId);
          window.setTimeout(() => setSavedId((cur) => (cur === msgId ? null : cur)), 2000);
        }
        emitWebToast({ message: `Đã lưu vào Knowledge: ${path}`, tone: "success" });
        onWorkspaceMutated();
      } catch (err) {
        emitWebToast({
          message: err instanceof Error ? err.message : "Could not save reply.",
          tone: "error",
        });
      } finally {
        const next = { ...savingIdsRef.current };
        delete next[lockKey];
        savingIdsRef.current = next;
        setSavingIds(next);
      }
    },
    [docTitle, isReadOnly, onWorkspaceMutated, slug],
  );

  const sendPrompt = useCallback(
    async (rawText: string, opts?: { mentions?: MentionTarget[] }) => {
      const prompt = rawText.trim();
      if (!prompt || abortRef.current) return;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

      const compiled = compileSlashPrompt(prompt, { tz, docPath });
      if (compiled.kind === "instant") {
        if (compiled.commandId === "new") {
          setMessages([]);
          setSession(makeSessionId(slug));
          setBusy(false);
          setPhase(null);
          setActiveTool(null);
          setMentionedItems([]);
          setIncludeSchedule(false);
          emitWebToast({ message: "Đã mở cuộc trò chuyện mới", tone: "info" });
        } else if (compiled.commandId === "schedule") {
          setIncludeSchedule((cur) => {
            const next = !cur;
            if (!next) {
              setMentionedItems((prev) => prev.filter((m) => m.kind !== "schedule"));
            }
            emitWebToast({
              message: next ? "Đã bật ngữ cảnh lịch họp hôm nay" : "Đã tắt ngữ cảnh lịch họp hôm nay",
              tone: "info",
            });
            return next;
          });
        } else if (compiled.commandId === "save") {
          const lastAgent = [...messagesRef.current].reverse().find((m) => m.role === "agent" && m.text.trim());
          if (!lastAgent) {
            emitWebToast({ message: "Chưa có câu trả lời nào của Tina để lưu.", tone: "info" });
          } else {
            void saveCopilotReply(lastAgent.text, lastAgent.id);
          }
        }
        return;
      }
      if (compiled.kind === "error") {
        emitWebToast({ message: compiled.message, tone: "error" });
        return;
      }

      const mentionCtx = compileMentionContext(opts?.mentions ?? []);
      const userId = `cu-${Date.now()}`;
      const agentId = `ca-${Date.now() + 1}`;

      setMessages((prev) => [
        ...prev,
        {
          id: userId,
          role: "user",
          text: compiled.displayPrompt,
          mentions: opts?.mentions?.length ? opts.mentions : undefined,
        },
        { id: agentId, role: "agent", text: "", ops: [] },
      ]);
      setBusy(true);
      setPhase("connecting");
      setActiveTool(null);
      let mutatedInTurn = false;
      let commitSeen = false;

      const controller = new AbortController();
      abortRef.current = controller;

      const contextHeader = docPath
        ? `[Context: Space "${workspaceName}"${slug ? ` (slug: ${slug})` : ""}, open page "${docPath}"${isReadOnly ? " (view-only)" : ""}]`
        : `[Context: Space "${workspaceName}"${slug ? ` (slug: ${slug})` : ""}]`;
      const groundedPrompt = [contextHeader, mentionCtx.contextBlock, compiled.wirePrompt]
        .filter(Boolean)
        .join("\n\n");

      const focusPayload: FocusPayload | null = docPath
        ? { kind: "file", ref: `@file:${docPath}` }
        : slug && slug !== "_global"
          ? { kind: "workspace", slug }
          : mentionCtx.fallbackFocus;
      const effectiveIncludeSchedule = includeSchedule || mentionCtx.includeSchedule;

      try {
        await streamChatTurn(
          {
            prompt: groundedPrompt,
            session,
            active: focusPayload ?? undefined,
            research: compiled.research || undefined,
            context: {
              tz,
              surface: { list: "files", tab: { kind: docPath ? "doc" : "workspace" } },
              focus: focusPayload,
              ...(effectiveIncludeSchedule ? { include: { schedule: true } } : {}),
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
              if (KNOWLEDGE_WRITE_TOOLS.has(normalizeAgentToolName(tool))) mutatedInTurn = true;
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
    [docPath, workspaceName, slug, isReadOnly, session, onWorkspaceMutated, includeSchedule, saveCopilotReply],
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

  const submitCopilot = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const precheck = compileSlashPrompt(trimmed, { tz, docPath });
    if (precheck.kind === "error") {
      emitWebToast({ message: precheck.message, tone: "error" });
      return;
    }
    const text = input;
    const activeMentions = mentionedItems;
    setInput("");
    closePickers();
    if (precheck.kind !== "instant") {
      setMentionedItems([]);
    }
    void sendPrompt(text, { mentions: activeMentions });
  }, [busy, closePickers, docPath, input, mentionedItems, sendPrompt]);

  submitRef.current = submitCopilot;
  instantSlashRef.current = (cmd) => {
    void sendPrompt(cmd.command);
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    submitCopilot();
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
                  const userMsg = messages[i];
                  if (userMsg?.role === "user") {
                    void sendPrompt(userMsg.text, { mentions: userMsg.mentions });
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
                        {!isReadOnly && (
                          <button
                            type="button"
                            className={styles.copilotCopyBtn}
                            aria-label="Save response to Knowledge"
                            title="Save response as a Knowledge page"
                            disabled={Boolean(savingIds[m.id])}
                            onClick={() => void saveCopilotReply(m.text, m.id)}
                          >
                            <WebIcon name={savedId === m.id ? "check" : "fileText"} size={12} />
                            <span>
                              {savingIds[m.id] ? "Saving…" : savedId === m.id ? "Saved" : "Save"}
                            </span>
                          </button>
                        )}
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
          <LucianMentionPopover
            open={pickers.mentionOpen}
            listboxId={pickers.mentionListboxId}
            query={pickers.mentionMatch?.query ?? ""}
            items={pickers.filteredMentions}
            activeIndex={pickers.mentionActiveIdx}
            onHoverIndex={pickers.setMentionActiveIdx}
            onPick={pickers.pickMention}
          />
          <LucianSlashPopover
            open={pickers.slashOpen}
            listboxId={pickers.slashListboxId}
            items={pickers.filteredSlashCommands}
            activeIndex={pickers.slashActiveIdx}
            onHoverIndex={pickers.setSlashActiveIdx}
            onPick={pickers.pickSlashCommand}
          />
          <LucianMentionChips
            mentions={mentionedItems}
            onRemove={pickers.removeMentionChip}
          />
          <textarea
            ref={inputRef}
            className={styles.copilotInput}
            rows={1}
            role="combobox"
            aria-label="Ask Tina a question"
            aria-autocomplete="list"
            aria-expanded={pickers.mentionOpen || pickers.slashOpen}
            aria-controls={
              pickers.mentionOpen
                ? pickers.mentionListboxId
                : pickers.slashOpen
                  ? pickers.slashListboxId
                  : undefined
            }
            aria-activedescendant={pickers.activeDescendantId}
            placeholder={`Ask about ${targetLabel}… (@ mention, / commands)`}
            value={input}
            onChange={(e) => {
              const next = e.target.value;
              setInput(next);
              pickers.syncPickers(next, e.target.selectionStart ?? next.length);
            }}
            onClick={(e) => pickers.syncPickers(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onKeyUp={(e) => {
              if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) {
                pickers.syncPickers(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
              }
            }}
            onBlur={pickers.handleBlur}
            onKeyDown={pickers.handleKeyDown}
          />
          <div className={styles.copilotComposerBar}>
            <div className={styles.copilotTriggerGroup}>
              <LucianMentionTriggerButton
                onClick={pickers.triggerMention}
                disabled={busy}
                expanded={pickers.mentionOpen}
              />
              <LucianSlashTriggerButton
                onClick={pickers.triggerSlash}
                disabled={busy}
                expanded={pickers.slashOpen}
              />
              {includeSchedule && !mentionedItems.some((m) => m.kind === "schedule") ? (
                <button
                  type="button"
                  className={styles.copilotSchedBadge}
                  title="Today's schedule attached (click to remove)"
                  onClick={() => {
                    setIncludeSchedule(false);
                    setMentionedItems((prev) => prev.filter((m) => m.kind !== "schedule"));
                  }}
                >
                  <span>Today</span>
                  <span aria-hidden="true">×</span>
                </button>
              ) : (
                <div className={styles.copilotComposerContext} title={targetLabel}>
                  <span className={styles.copilotContextDot} aria-hidden="true" />
                  <span className={styles.copilotContextText}>
                    {busy ? "Tina is writing…" : targetLabel}
                  </span>
                </div>
              )}
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
