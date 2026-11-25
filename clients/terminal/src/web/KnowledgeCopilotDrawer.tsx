"use client";
/** KnowledgeCopilotDrawer — Friendly inline Ask Tina AI side panel docked beside the Knowledge Hub.
 *  Streams live SSE answers grounded on the open page or space, offers 1-click Summarize / Find action items /
 *  Suggest links actions, supports seeded prompts from uploaded files or Connections Map, and auto-refreshes on save. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
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

function makeSessionId(slug?: string): string {
  const safe = (slug || "personal").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 28);
  return `kb-${safe}-${Date.now().toString(36)}`;
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
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setPhase(null);
    setSession(makeSessionId(slug));
    setMessages([]);
  }, [slug]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, phase]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

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

      const controller = new AbortController();
      abortRef.current = controller;

      const groundedPrompt = docPath
        ? `[Context: Space "${workspaceName}"${slug ? ` (slug: ${slug})` : ""}, open page "${docPath}"${isReadOnly ? " (view-only)" : ""}]\n\n${prompt}`
        : `[Context: Space "${workspaceName}"${slug ? ` (slug: ${slug})` : ""}]\n\n${prompt}`;

      try {
        await streamChatTurn(
          {
            prompt: groundedPrompt,
            session,
            active: docPath ? { kind: "doc", path: docPath, slug } : undefined,
            context: { tz, surface: "web-knowledge-copilot", docPath, slug },
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
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId ? { ...m, ops: [...(m.ops ?? []), tool] } : m,
                ),
              );
            },
            onCommit: (sha) => {
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
        abortRef.current = null;
        setBusy(false);
        setPhase(null);
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

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const text = input;
    setInput("");
    void sendPrompt(text);
  };

  if (!open) return null;

  const targetLabel = docTitle || (docPath ? friendlyPageTitle(docPath) : workspaceName);

  return (
    <aside className={styles.copilotDrawer} aria-label="Ask Tina assistant">
      <div className={styles.copilotHead}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <WebIcon name="tinaAsk" size={16} />
          <div style={{ minWidth: 0 }}>
            <div className={styles.copilotTitle}>Ask Tina</div>
            <div className={styles.copilotSub} title={devView && docPath ? docPath : targetLabel}>
              {docPath ? `Reading ${targetLabel}` : `Space · ${workspaceName}`}
            </div>
          </div>
        </div>
        <div className={styles.railHeadActions}>
          {onOpenFullAsk && (
            <button
              type="button"
              className={styles.tinyBtn}
              title="Open full-screen Ask Tina"
              onClick={() =>
                onOpenFullAsk(
                  docPath
                    ? `Help me work on "${targetLabel}" in ${workspaceName}.`
                    : `Help me explore ${workspaceName}.`,
                )
              }
            >
              <WebIcon name="externalLink" size={12} />
            </button>
          )}
          <button
            type="button"
            className={styles.tinyBtn}
            title="Start a new chat"
            onClick={() => {
              abortRef.current?.abort();
              setMessages([]);
              setSession(makeSessionId(slug));
            }}
          >
            <WebIcon name="refresh" size={12} />
          </button>
          <button type="button" className={styles.tinyBtn} aria-label="Close Ask Tina" onClick={onClose}>
            <WebIcon name="close" size={12} />
          </button>
        </div>
      </div>

      <div className={styles.copilotQuickBar}>
        <button
          type="button"
          className={styles.chip}
          disabled={busy}
          onClick={() =>
            void sendPrompt(
              docPath
                ? `Summarize "${targetLabel}" in clear bullet points with key decisions and open questions.`
                : `Give me an overview of the most important pages in ${workspaceName}.`,
            )
          }
        >
          {docPath ? "Summarize page" : "Summarize space"}
        </button>
        <button
          type="button"
          className={styles.chip}
          disabled={busy}
          onClick={() =>
            void sendPrompt(
              docPath
                ? `List all action items and owners mentioned in "${targetLabel}"${isReadOnly ? " (do not modify view-only pages)" : ""}.`
                : `List open tasks and follow-ups across ${workspaceName}.`,
            )
          }
        >
          Find action items
        </button>
        <button
          type="button"
          className={styles.chip}
          disabled={busy}
          onClick={() =>
            void sendPrompt(
              docPath
                ? `Suggest related pages in ${workspaceName} to link with "${targetLabel}" and ways to make this page clearer.`
                : `Suggest which pages in ${workspaceName} are related and should be connected.`,
            )
          }
        >
          Suggest links
        </button>
      </div>

      <div className={styles.copilotFeed}>
        {messages.length === 0 && (
          <div className={styles.copilotEmpty}>
            <WebIcon name="sparkleSmall" size={20} />
            <p>
              Ask anything about <strong>{targetLabel}</strong>, compare with past meetings, or ask Tina to draft
              updates — changes appear here automatically.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`${styles.copilotMsg} ${m.role === "user" ? styles.copilotMsgUser : styles.copilotMsgAgent}`}
          >
            {m.role === "user" ? (
              <div>{m.text}</div>
            ) : (
              <>
                {devView && m.ops && m.ops.length > 0 && (
                  <div className={styles.copilotOps}>
                    {m.ops.map((op, i) => (
                      <span key={`${op}-${i}`} className={styles.wsTag}>
                        {op}
                      </span>
                    ))}
                  </div>
                )}
                {m.text ? (
                  <div className={styles.docProse} style={{ fontSize: 13 }}>
                    <Markdown>{m.text}</Markdown>
                  </div>
                ) : !m.error ? (
                  <span className={styles.cardSub}>
                    {phase === "working" ? "Reading your library…" : "Thinking…"}
                  </span>
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
                {m.error && <div className={styles.copilotErr}>{m.error}</div>}
              </>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className={styles.copilotComposer} onSubmit={handleSubmit}>
        <textarea
          className={styles.copilotInput}
          rows={2}
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
          <span className={styles.cardSub} style={{ fontSize: 11 }}>
            {busy ? "Tina is writing…" : "Enter to send · Shift+Enter new line"}
          </span>
          {busy ? (
            <button
              type="button"
              className={`${styles.tinyBtn} ${styles.btnDanger}`}
              onClick={() => abortRef.current?.abort()}
            >
              <WebIcon name="stop" size={11} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              className={`${styles.tinyBtn} ${styles.btnPrimary}`}
              disabled={!input.trim()}
            >
              <WebIcon name="sendUp" size={11} />
              <span>Send</span>
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
