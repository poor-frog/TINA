"use client";
/** KnowledgeCopilotDrawer — Inline Ask Tina AI Copilot panel docked beside the open Knowledge document.
 *  Streams live SSE turns via `streamChatTurn` grounded on the active document & workspace, provides
 *  one-click Summarize / Extract Tasks / Suggest Links actions, and auto-refreshes the workspace on commit. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
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
  isReadOnly,
  onClose,
  onWorkspaceMutated,
  onOpenFullAsk,
}: {
  open: boolean;
  workspaceName: string;
  slug?: string;
  docPath: string | null;
  isReadOnly: boolean;
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
        ? `[Context: Workspace "${workspaceName}"${slug ? ` (slug: ${slug})` : ""}, open document "${docPath}"${isReadOnly ? " (read-only)" : ""}]\n\n${prompt}`
        : `[Context: Workspace "${workspaceName}"${slug ? ` (slug: ${slug})` : ""}]\n\n${prompt}`;

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
                  m.id === agentId ? { ...m, error: "Workspace governance rejected this edit." } : m,
                ),
              );
            },
            onModelFailure: (reply) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId ? { ...m, error: reply || "Model inference failed." } : m,
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

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const text = input;
    setInput("");
    void sendPrompt(text);
  };

  if (!open) return null;

  const targetLabel = docPath ? docPath.split("/").pop() || docPath : workspaceName;

  return (
    <aside className={styles.copilotDrawer} aria-label="Ask Tina Knowledge Copilot">
      <div className={styles.copilotHead}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <WebIcon name="tinaAsk" size={15} />
          <div style={{ minWidth: 0 }}>
            <div className={styles.copilotTitle}>Ask Tina Copilot</div>
            <div className={styles.copilotSub} title={docPath || workspaceName}>
              Grounded on {targetLabel}
            </div>
          </div>
        </div>
        <div className={styles.railHeadActions}>
          {onOpenFullAsk && (
            <button
              type="button"
              className={styles.tinyBtn}
              title="Open full-page Ask Tina"
              onClick={() =>
                onOpenFullAsk(
                  docPath
                    ? `Help me work on "${docPath}" in ${workspaceName}.`
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
            title="New conversation"
            onClick={() => {
              abortRef.current?.abort();
              setMessages([]);
              setSession(makeSessionId(slug));
            }}
          >
            <WebIcon name="refresh" size={12} />
          </button>
          <button type="button" className={styles.tinyBtn} aria-label="Close Copilot" onClick={onClose}>
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
                ? `Summarize "${docPath}" in bullet points with the main decisions, facts, and open questions.`
                : `Give me an overview of the key knowledge pages in ${workspaceName}.`,
            )
          }
        >
          Summarize
        </button>
        <button
          type="button"
          className={styles.chip}
          disabled={busy}
          onClick={() =>
            void sendPrompt(
              docPath
                ? `Extract concrete action items and owners from "${docPath}"${isReadOnly ? " (do not modify read-only files)" : ""}.`
                : `List open tasks and follow-ups across ${workspaceName}.`,
            )
          }
        >
          Extract Tasks
        </button>
        <button
          type="button"
          className={styles.chip}
          disabled={busy}
          onClick={() =>
            void sendPrompt(
              docPath
                ? `Suggest relevant [[wikilinks]] to connect "${docPath}" with other entities and recommend clarity improvements.`
                : `Suggest which pages in ${workspaceName} should be linked together in the Knowledge Graph.`,
            )
          }
        >
          Suggest Links
        </button>
      </div>

      <div className={styles.copilotFeed}>
        {messages.length === 0 && (
          <div className={styles.copilotEmpty}>
            <WebIcon name="sparkleSmall" size={20} />
            <p>
              Ask questions about <strong>{targetLabel}</strong>, compare with meeting notes, or ask Tina to draft
              edits — updates refresh here automatically.
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
                {m.ops && m.ops.length > 0 && (
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
                    {phase === "working" ? "Thinking & reading workspace…" : "Connecting to TINA agent…"}
                  </span>
                ) : null}
                {m.commit && (
                  <div className={styles.copilotCommit}>
                    <WebIcon name="check" size={12} />
                    <span>Updated workspace ({m.commit.slice(0, 7)}) — refreshed</span>
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
          aria-label="Ask Tina about this document"
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
            {busy ? (phase ? `Status: ${phase}` : "Running…") : "Enter to send · Shift+Enter newline"}
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
