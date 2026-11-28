"use client";
/** Chat — the persistent right-rail agent window. Streams a real agent turn over /api/chat (SSE) into the
 *  turn timeline, surfacing each tool-call as a visible operation (read/search/edit/git/web) with status,
 *  then the message + commit / rejection badge. The composer carries the active center-tab reference. */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { useService, useStore, CommandServiceId } from "../platform";
import { LayoutServiceId, type ActiveTab } from "../workbench/layout";
import { THREAD_TAB_KIND } from "../workbench/shell";
import { registerCommand, type TabProps } from "../contributions";
import { meetingsOnly } from "../app/mode";
import { AgentWindow, Conversation, opIcon, type Turn, type Op } from "../workbench/agent-window";
import { Icon } from "../ui-kit";
import { startStreamingDictation, type StreamingDictation } from "../ui-kit/micDictation";
import { sessionTitle, type SessionSummary } from "./sessions";
import { listSessions } from "./sessionsApi";
import { streamChatTurn, type ChatPhase } from "./chatStream";
import { buildChatContext, focusTarget, readIncludeSchedule, scheduleEligible, writeIncludeSchedule, type FocusPayload } from "./chatContext";
import { useLiveMeetings } from "./liveMeetings";
import { meetingPhase, type MeetingMock, type MeetingPhase } from "./meetingModel";
import { ASK_CHAT_EVENT, ONBOARDING_KICKOFF_MARK, ONBOARDING_SEED_EVENT, ONBOARDING_GREETING, ONBOARDING_GROUNDING, ONBOARDING_REPLY_SEP, type AskChatDetail } from "../canvas/actions";

/** classify a tool name into one of the op icons so the operation line reads at a glance */
function toolOp(tool: string): Op {
  const t = tool.toLowerCase();
  // verb-first labels: the op line reads as what the agent is DOING, not an internal tool name
  const [icon, verb] = /read|cat|open/.test(t) ? [opIcon.read, "Reading"]
    : /glob|search|grep|find|ls\b/.test(t) ? [opIcon.search, "Searching"]
    : /edit|write|append/.test(t) ? [opIcon.edit, "Writing"]
    : /git|commit/.test(t) ? [opIcon.git, "Committing"]
    : /web|fetch|http/.test(t) ? [opIcon.web, "Browsing"]
    : /bash|exec|run/.test(t) ? [opIcon.tool, "Running"]
    : [opIcon.tool, tool];
  return { icon, label: verb === tool ? tool : `${verb} · ${tool}`, status: "done" };
}

/** the backend history turn shape (GET /api/sessions/:session/history) */
type HistoryTurn =
  | { role: "user"; text: string }
  | { role: "agent"; text: string; ops?: { label: string; tool?: string }[]; commit?: string };

type AgentTurn = Extract<Turn, { role: "agent" }>;
type ChatSessionState = {
  turns: Turn[];
  busy: boolean;
  loading: boolean;
  loaded: boolean;
  nextId: number;
  abort: AbortController | null;
};

const EMPTY_CHAT_STATE: ChatSessionState = { turns: [], busy: false, loading: false, loaded: false, nextId: 0, abort: null };
const chatSessions = new Map<string, ChatSessionState>();
const chatSubscribers = new Map<string, Set<() => void>>();

function chatStateKey(subject: string, session: string): string {
  return `${subject}\u0000${session}`;
}

function getChatState(key: string): ChatSessionState {
  let state = chatSessions.get(key);
  if (!state) {
    state = { ...EMPTY_CHAT_STATE };
    chatSessions.set(key, state);
  }
  return state;
}

function emitChatState(key: string): void {
  chatSubscribers.get(key)?.forEach((fn) => fn());
}

function updateChatState(key: string, fn: (state: ChatSessionState) => ChatSessionState): void {
  chatSessions.set(key, fn(getChatState(key)));
  emitChatState(key);
}

function subscribeChatState(key: string, cb: () => void): () => void {
  let subs = chatSubscribers.get(key);
  if (!subs) {
    subs = new Set();
    chatSubscribers.set(key, subs);
  }
  subs.add(cb);
  return () => {
    subs?.delete(cb);
    if (subs?.size === 0) chatSubscribers.delete(key);
  };
}

function patchAgentTurn(key: string, agentId: string, fn: (turn: AgentTurn) => AgentTurn): void {
  updateChatState(key, (state) => ({
    ...state,
    turns: state.turns.map((turn) => (turn.id === agentId && turn.role === "agent" ? fn(turn) : turn)),
  }));
}

/** map a backend op label (read/search/edit/git/web/tool) to a frontend Op (icon from opIcon) */
const OP_VERB: Record<string, string> = { read: "Reading", search: "Searching", edit: "Writing", git: "Committing", web: "Browsing", tool: "Working" };
export function historyOp(op: { label: string; tool?: string }): Op {
  if (op.tool) return toolOp(op.tool);
  return { icon: opIcon[op.label] ?? opIcon.tool, label: OP_VERB[op.label] ?? op.label, status: "done" };
}

type ReferenceToken = { kind: "file" | "meeting"; value: string; raw: string };
type ReferenceSegment = { kind: "text"; text: string } | { kind: "reference"; ref: ReferenceToken };
type ActiveReference = ReferenceToken;
const REFERENCE_RE = /@(file|meeting):([A-Za-z0-9._~%+@:/=-]+)/g;
const MAX_TEXTAREA_HEIGHT = 156;
const ATTACHMENT_ACCEPT = [
  "image/*", ".pdf", ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".log",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip",
].join(",");

type ComposerAttachment = { id: string; file: File; isImage: boolean; previewUrl?: string };
type UploadedWorkspaceFile = { name: string; path: string };

function resizeComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
  el.style.height = `${height}px`;
  el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
}

function attachmentPrompt(prompt: string, files: UploadedWorkspaceFile[]): string {
  if (files.length === 0) return prompt.trim();
  const attached = ["Attached files:", ...files.map((f) => `- @file:${f.path}`)].join("\n");
  return prompt.trim() ? `${prompt.trim()}\n\n${attached}` : attached;
}

function tokenizeReferences(text: string): ReferenceSegment[] {
  const parts: ReferenceSegment[] = [];
  REFERENCE_RE.lastIndex = 0;
  let last = 0;
  for (const m of text.matchAll(REFERENCE_RE)) {
    const index = m.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: text.slice(last, index) });
    parts.push({ kind: "reference", ref: { kind: m[1] as "file" | "meeting", value: m[2], raw: m[0] } });
    last = index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

function referenceTokens(text: string): ReferenceToken[] {
  const out: ReferenceToken[] = [];
  const seen = new Set<string>();
  for (const part of tokenizeReferences(text)) {
    if (part.kind !== "reference") continue;
    const key = `${part.ref.kind}:${part.ref.value}`;
    if (!seen.has(key)) { seen.add(key); out.push(part.ref); }
  }
  return out;
}

function fileLabel(path: string): string {
  return path.split("/").filter(Boolean).pop()?.replace(/\.md$/, "") || path;
}

function ReferenceChip({ refToken }: { refToken: ReferenceToken }) {
  const isFile = refToken.kind === "file";
  const label = isFile ? fileLabel(refToken.value) : refToken.value;
  return (
    <span title={refToken.raw}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, maxWidth: 220, verticalAlign: "baseline", margin: "0 2px", padding: "1px 7px 1px 5px", borderRadius: 6, border: "1px solid var(--line2)", background: isFile ? "var(--bluebg)" : "var(--accentbg)", color: isFile ? "var(--blue)" : "var(--accent)", fontSize: "0.92em", lineHeight: 1.45, whiteSpace: "nowrap" }}>
      <Icon name={isFile ? "file" : "cal"} size={11} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </span>
  );
}

function ReferenceText({ text }: { text: string }) {
  return <>{tokenizeReferences(text).map((part, i) => part.kind === "text"
    ? <span key={i}>{part.text}</span>
    : <ReferenceChip key={i} refToken={part.ref} />)}</>;
}

function appendReferenceToken(text: string, refToken: ReferenceToken | null): string {
  const body = text.trim();
  if (!refToken || body.includes(refToken.raw)) return body;
  return body ? `${body}\n\n${refToken.raw}` : refToken.raw;
}

function meetingTokenFromTitle(title: string): ReferenceToken {
  const value = (title.split("·").pop()?.trim() || title.trim() || "meeting").replace(/^["'\\]+|["'\\.)]+$/g, "");
  return { kind: "meeting", value, raw: `@meeting:${value}` };
}

// Server-side grounding preambles (kg-links, mount stack, meeting phase, schedule digest,
// workspace focus) are PART of the stored prompt — plumbing, not something the user typed.
// Each known block is stripped start→terminator so history shows only the user's words
// (fail-soft: an unrecognized shape renders untouched). Mirrors worker/engine.py + meeting_steering.py.
const CONTEXT_BLOCKS: Array<[RegExp, RegExp]> = [
  [/^## Referencing knowledge \(always\)/, /or use plain text\.\s*/],
  [/^## Your mounted workspaces/, /do not guess or invent mount paths\.\s*/],
  [/^<schedule[ >]/, /<\/schedule>\s*/],   // the digest opens with attributes (tz/now) — match them
  [/^The user's meeting schedule is in <schedule>/, /notes files or ask\.\s*/],
  [/^You are assisting in a live meeting/, /(?:<\/transcript>\s*|no transcript yet\.\s*)/],
  // the prep steering grew (proactive-research + example-entities + identity clauses); anchor on its
  // CURRENT tail. ("don't have prior context." now appears mid-block, so it can't be the terminator.)
  [/^You are helping the user PREPARE/, /starting blank\.\s*/],
  [/^The meeting "/, /(?:<\/transcript>\s*|invent its content\.\s*)/],
  [/^The user is looking at the workspace/, /(?:<\/readme>\s*|context is missing\.\s*)/],
];

// The server marks the grounding→user boundary with this sentinel (control_plane/api.py). When present,
// ONE cut removes every folded block regardless of wording drift; the regex blocks below are the
// fallback for chats stored before the sentinel shipped.
const CONTEXT_SENTINEL = "<!--tina:user-input-below-->";

export function stripContextBlocks(raw: string): string {
  const si = raw.lastIndexOf(CONTEXT_SENTINEL);
  if (si >= 0) {
    const after = raw.slice(si + CONTEXT_SENTINEL.length).trimStart();
    if (after) return after;   // everything up to & including the sentinel is server grounding
  }
  let text = raw;
  let guard = 0;
  outer: while (guard++ < 12) {
    for (const [start, end] of CONTEXT_BLOCKS) {
      if (start.test(text)) {
        const m = end.exec(text);
        if (m) { text = text.slice(m.index + m[0].length).trimStart(); continue outer; }
      }
    }
    break;
  }
  return text === raw ? raw : (text.trim() || raw);
}

function compactStoredUserText(text: string): string {
  const raw = stripContextBlocks(text.trim());
  // An onboarding first reply is stored as `<grounding>[reply]<user text>` — show only the user's text.
  if (raw.includes(ONBOARDING_KICKOFF_MARK)) {
    const i = raw.indexOf(ONBOARDING_REPLY_SEP);
    if (i >= 0) return raw.slice(i + ONBOARDING_REPLY_SEP.length).trim();
  }
  const legacyCopilot = raw.match(/^You are the copilot for a live meeting \("([^"]+)"\)\. The meeting transcript so far:[\s\S]*?\n?---\s*([\s\S]*)$/);
  if (legacyCopilot) {
    return appendReferenceToken(legacyCopilot[2], meetingTokenFromTitle(legacyCopilot[1]));
  }
  const activeMeeting = raw.match(/^Active meeting reference:\s*(@meeting:([A-Za-z0-9._~%+@:/=-]+))[\s\S]*?\n\n---\n([\s\S]*)$/);
  if (activeMeeting) {
    return appendReferenceToken(activeMeeting[3], { kind: "meeting", value: activeMeeting[2], raw: activeMeeting[1] });
  }
  const legacyMeeting = raw.match(/^Active meeting ([A-Za-z0-9._~%+@:/=-]+)\.[\s\S]*?\n\n---\n([\s\S]*)$/);
  if (legacyMeeting) {
    return appendReferenceToken(legacyMeeting[2], { kind: "meeting", value: legacyMeeting[1], raw: `@meeting:${legacyMeeting[1]}` });
  }
  const activeFile = raw.match(/^Active context: the user is viewing the workspace file ([^\n]+?)\. Read it[\s\S]*?\n\n---\n([\s\S]*)$/);
  if (activeFile) {
    return appendReferenceToken(activeFile[2], { kind: "file", value: activeFile[1], raw: `@file:${activeFile[1]}` });
  }
  // The default is the CONTEXT-STRIPPED text (sentinel/regex) — NOT the raw stored prompt. Returning
  // `text` here silently discarded the strip, leaking the whole grounding preamble into the bubble.
  return raw;
}



function ChatHeader({ subject, session, onSelectSession, onNewChat, onClose }: {
  subject: string;
  session: string;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  /** omitted in the v2 CENTER thread — the dockview tab chrome is the close affordance there */
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await listSessions();
        if (!cancelled) { setSessions(list); setError(null); }
      } catch (e) {
        // Fail loud: surface the backend error instead of silently showing an empty list.
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load sessions");
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [subject]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const list = await listSessions();
        if (!cancelled) { setSessions(list); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load sessions");
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [open, subject]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }  // consume: close-topmost beats nav.back
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const activeSummary = sessions.find((s) => s.session === session) ?? { session };
  const visibleSessions = sessions.some((s) => s.session === session) ? sessions : [activeSummary, ...sessions];
  const currentTitle = sessionTitle(activeSummary);
  const iconButton: CSSProperties = { width: 28, height: 28, borderRadius: 7, border: "1px solid transparent", background: "transparent", color: "var(--t3)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flex: "none" };

  return (
    <div ref={menuRef} style={{ height: 38, flex: "none", position: "relative", display: "flex", alignItems: "center", gap: 4, padding: "0 8px", borderBottom: "1px solid var(--line)", background: "var(--panel)", minWidth: 0 }}>
      <button
        aria-label="Switch chat session"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ flex: 1, minWidth: 0, height: 28, borderRadius: 7, border: "1px solid transparent", background: open ? "var(--panel2)" : "transparent", color: "var(--t1)", display: "flex", alignItems: "center", gap: 7, padding: "0 8px", cursor: "pointer" }}
      >
        <Icon name="msg" size={13} style={{ color: "var(--t3)" }} />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, lineHeight: 1 }}>{currentTitle}</span>
        <Icon name="chevR" size={12} style={{ color: "var(--t3)", transform: open ? "rotate(-90deg)" : "rotate(90deg)", transition: "transform .12s" }} />
      </button>
      <button aria-label="New chat" title="New chat" onClick={onNewChat} style={iconButton}><Icon name="plus" size={15} /></button>
      {onClose && <button aria-label="Close chat" title="Close chat" onClick={onClose} style={iconButton}><Icon name="x" size={14} /></button>}

      {open && (
        <div role="menu" style={{ position: "absolute", zIndex: 30, top: 36, left: 8, right: 8, maxHeight: 260, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "var(--panel)", boxShadow: "0 14px 34px rgba(0,0,0,.32)", padding: 4 }}>
          {error && <div role="alert" style={{ padding: "8px", color: "var(--danger)", fontSize: 12 }}>⚠ Couldn&apos;t load sessions — {error}</div>}
          {visibleSessions.map((s) => {
            const active = s.session === session;
            return (
              <button
                key={s.session}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { onSelectSession(s.session); setOpen(false); }}
                style={{ width: "100%", minWidth: 0, display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", border: "none", borderRadius: 6, background: active ? "var(--panel2)" : "transparent", color: active ? "var(--t1)" : "var(--t2)", cursor: "pointer", textAlign: "left", fontSize: 12.5 }}
              >
                <Icon name="msg" size={13} style={{ color: active ? "var(--t2)" : "var(--t3)" }} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionTitle(s)}</span>
              </button>
            );
          })}
          {visibleSessions.length === 0 && <div style={{ padding: "8px", color: "var(--t3)", fontSize: 12 }}>No recent sessions</div>}
        </div>
      )}
    </div>
  );
}

function ChatConversation({ turns, busy, empty, onApprovalDecision }: {
  turns: Turn[];
  busy?: boolean;
  empty?: ReactNode;
  onApprovalDecision?: (approvalId: string, decision: "approve" | "deny") => void;
}) {
  if (turns.length === 0 && empty) return <>{empty}</>;
  return (
    <>
      {turns.map((t, i) => t.role === "user"
        ? (
            <div key={t.id} style={{ marginBottom: 18, borderLeft: "2px solid var(--line2)", paddingLeft: 12, marginLeft: 2 }}>
              <div style={{ fontSize: "var(--ui-type-meta)", fontWeight: 600, color: "var(--t3)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                <span>You</span>
              </div>
              <div style={{ fontSize: "var(--ui-type-label)", color: "var(--t1)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                <ReferenceText text={t.text} />
              </div>
            </div>
          )
        : <Conversation key={t.id} turns={[t]} busy={!!busy && i === turns.length - 1}
            onApprovalDecision={onApprovalDecision} />)}
    </>
  );
}

function ComposerReferences({ text }: { text: string }) {
  const refs = referenceTokens(text);
  if (refs.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, minWidth: 0 }}>
      {refs.map((r) => <ReferenceChip key={`${r.kind}:${r.value}`} refToken={r} />)}
    </div>
  );
}

function AttachmentChips({ attachments, onRemove }: { attachments: ComposerAttachment[]; onRemove: (id: string) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, minWidth: 0 }}>
      {attachments.map((a) => (
        <span key={a.id} title={a.file.name}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 210, minWidth: 0, border: "1px solid var(--line2)", borderRadius: 7, background: "var(--panel2)", color: "var(--t2)", padding: "3px 5px", fontSize: 12, lineHeight: 1.2 }}>
          {a.previewUrl
            ? <img src={a.previewUrl} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: "cover", flex: "none", background: "var(--bg)" }} />
            : <span style={{ width: 24, height: 24, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", background: "var(--bg)", color: "var(--t3)" }}><Icon name="file" size={13} /></span>}
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.file.name || "upload"}</span>
          <button aria-label={`Remove ${a.file.name || "attachment"}`} title="Remove" type="button" onClick={() => onRemove(a.id)}
            style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", display: "flex", padding: 1, flex: "none" }}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

function referenceContext(text: string): string {
  const refs = referenceTokens(text);
  if (refs.length === 0) return "";
  const lines = [
    "Referenced context:",
    "The user included these paste-safe reference tokens. Resolve them before answering when relevant.",
  ];
  for (const ref of refs) {
    if (ref.kind === "file") {
      lines.push(
        `- token: ${ref.raw}`,
        "  kind: file",
        `  workspace_path: ${ref.value}`,
        "  instruction: Read this workspace-relative path before relying on it.",
      );
    } else {
      const notesPath = `kg/entities/meeting/${ref.value}.md`;
      lines.push(
        `- token: ${ref.raw}`,
        "  kind: meeting",
        `  native_id: ${ref.value}`,
        "  platform: google_meet",
        `  notes_workspace_path: ${notesPath}`,
        `  transcript_api_path: /api/transcripts/google_meet/${ref.value}`,
        "  instruction: Use notes_workspace_path first; fetch or identify the transcript only when needed. Keep the visible chat compact: refer to the token instead of pasting the transcript.",
      );
    }
  }
  return lines.join("\n");
}

function promptWithReferences(prompt: string, userText: string): string {
  const context = referenceContext(userText);
  return context ? `${prompt.trim()}\n\n---\n${context}` : prompt.trim();
}

function activeReference(tab: ActiveTab | null): ActiveReference | null {
  if (!tab) return null;
  const path = typeof tab.params.path === "string" ? tab.params.path : null;
  if ((tab.kind === "doc" || tab.kind === "file") && path) return { kind: "file", value: path, raw: `@file:${path}` };
  const meetingId = typeof tab.params.meetingId === "string" ? tab.params.meetingId : null;
  // A PREP tab focuses its meeting too — the chat enters "Preparing" mode for it (W3/W4).
  if ((tab.kind === "meeting" || tab.kind === "meetingPrep") && meetingId) return { kind: "meeting", value: meetingId, raw: `@meeting:${meetingId}` };
  return null;
}

// ── chat MODE (design-spec meeting-lifecycle-v2, W3): the composer states its meeting phase ────────
const MODE_CHIP: Record<MeetingPhase, { label: string; color: string; bg: string }> = {
  prep: { label: "Preparing", color: "var(--accent)", bg: "var(--accentbg)" },
  live: { label: "In meeting", color: "var(--green)", bg: "var(--greenbg)" },
  post: { label: "Recap", color: "var(--violet)", bg: "var(--violetbg)" },
};
const MODE_PLACEHOLDER: Record<MeetingPhase, string> = {
  prep: "Ask me to build the agenda, research attendees, or draft the brief…",
  live: "Ask about what's being said…",
  post: "Ask for the recap, decisions, or follow-up drafts…",
};
const meetingLabel = (m: MeetingMock) => m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "");

function activeContextPrompt(ref: ActiveReference | null, meeting: MeetingMock | undefined): string {
  if (!ref) return "";
  if (ref.kind === "file") {
    return `Active context: the user is viewing the workspace file ${ref.value}. Read it with your Read tool if relevant.`;
  }

  // Meeting grounding now happens SERVER-SIDE: agent-api folds the live transcript from the meeting's
  // redis stream into the prompt (see _meeting_grounding). The client only flags the active meeting via
  // `active` on the POST body — no prompt preamble, so we never point the agent at a notes file.
  return "";
}

/** The meetings platform as the api slug agent-api keys the transcript stream on. */
function meetingPlatformSlug(meeting: MeetingMock | undefined): string {
  const p = meeting?.platform;
  return p === "Google Meet" || p === "google_meet" ? "google_meet" : (p ?? "google_meet");
}

function promptWithActiveContext(prompt: string, ref: ActiveReference | null, meeting: MeetingMock | undefined): string {
  const context = activeContextPrompt(ref, meeting);
  return context ? `${context}\n\n---\n${prompt.trim()}` : prompt.trim();
}

const ROUTINE_COMMAND = "/routine";
const ROUTINE_NAME_STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "create", "each", "every", "for", "from", "in", "into",
  "me", "my", "of", "on", "our", "please", "routine", "scheduled", "the", "to", "with",
  "hour", "hours", "day", "days", "week", "weeks", "month", "months", "am", "pm",
]);

export function isRoutineCommand(text: string): boolean {
  return /^\/routine(?:\s|$)/i.test(text);
}

export function routineDescription(text: string): string {
  return text.replace(/^\/routine(?:\s+|$)/i, "").trim();
}

function routineFileStem(description: string): string {
  const words = description.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const stem = words
    .filter((word) => !ROUTINE_NAME_STOP_WORDS.has(word) && !/^\d+(?:am|pm)?$/.test(word))
    .slice(0, 6)
    .join("-");
  return stem || "scheduled-routine";
}

export function routineCreationPrompt(commandText: string, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): string {
  const description = routineDescription(commandText);
  if (!description) {
    return [
      "The user invoked /routine without a routine description.",
      "Ask one concise follow-up for the task to run and the cadence. Do not create a routine file until the user gives enough detail, or explicitly accepts a default daily 9 AM schedule.",
    ].join("\n\n");
  }

  const fileStem = routineFileStem(description);
  return [
    `Create a scheduled routine from this user request: ${JSON.stringify(description)}.`,
    "",
    "You must write the routine into the user's workspace as a markdown file. Do not only explain the routine.",
    `Use this path unless a clearly better concise kebab-case name fits the request: routines/${fileStem}.md`,
    "",
    "The file must have YAML frontmatter in exactly this shape:",
    "---",
    "enabled: true",
    `timezone: ${JSON.stringify(timezone)}`,
    'cron: "<valid 5-field cron expression>"',
    "prompt: |",
    "  <the task prompt the scheduled agent should run>",
    "---",
    "",
    `Cron hours are local wall time in the file timezone (${timezone}), not UTC. If the user names a different IANA zone, set that zone. Do not convert clock hours to UTC yourself. For 9 AM use "0 9 * * *" with the intended timezone. If the request has no schedule, ask before creating an enabled file.`,
    "Make the prompt the actual recurring task, with schedule wording removed unless it is necessary context.",
    "Never overwrite an existing routine file to create a new task; choose a distinct filename. After writing, confirm the path, cron and timezone, and state that scheduling must be verified in Routines.",
  ].join("\n");
}

type ChatProps = Partial<TabProps> & {
  /** "rail" (default) = the v1 right rail, which owns a Close button that collapses the pane.
   *  "center"         = the v2 thread tab: dockview's tab chrome owns closing, so the Close button is
   *                    dropped and a breadcrumb strip names what the conversation is grounded on. */
  variant?: "rail" | "center";
};

/** the thin breadcrumb strip above the thread header (v2 only): states what record the conversation is
 *  grounded on, so "what is this thread about?" never depends on which center tab happens to be focused. */
function ThreadCrumb({ ground }: { ground: ActiveTab | null }) {
  const kindLabel: Record<string, string> = {
    meeting: "Meeting", meetingPrep: "Meeting prep", doc: "Document", file: "Document",
    today: "Today", workspace: "Workspace",
  };
  const ref = ground
    ? (typeof ground.params.meetingId === "string" ? ground.params.meetingId
      : typeof ground.params.path === "string" ? ground.params.path : "")
    : "";
  return (
    <div style={{ height: 28, flex: "none", display: "flex", alignItems: "center", gap: 7, padding: "0 12px", borderBottom: "1px solid var(--line)", background: "var(--panel)", fontSize: 11.5, color: "var(--t3)", minWidth: 0 }}>
      <Icon name={ground ? "pin" : "msg"} size={12} style={{ color: ground ? "var(--accent)" : "var(--t3)" }} />
      <span style={{ flex: "none" }}>Grounded on</span>
      <span style={{ color: ground ? "var(--t2)" : "var(--t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {ground ? `${kindLabel[ground.kind] ?? ground.kind}${ref ? ` · ${ref}` : ""}` : "nothing pinned"}
      </span>
    </div>
  );
}

export function Chat({ params = {}, variant = "rail" }: ChatProps) {
  const center = variant === "center";
  const subject = typeof params.subject === "string" ? params.subject : "me";  // LOCAL chat-cache key only — never sent upstream; scope is server-derived from the authed user (P20)
  const commands = useService(CommandServiceId);
  const layout = useService(LayoutServiceId);
  const { activeTab, lastRecord, activeSession, activeList } = useStore(layout.store);
  // Direction A (agent chat first): in the agent-first shell the conversation is ITSELF a center tab, so
  // `activeTab` is usually the thread. Ground on the last non-thread record instead, so switching to the
  // conversation never drops the meeting/doc it is about. v1 registers no thread tab, so `groundTab ===
  // activeTab` there and this is a no-op for the existing right-rail chat.
  const groundTab = activeTab?.kind === THREAD_TAB_KIND ? lastRecord : activeTab;
  // the rail follows the store's active session (switched from the rail header or Sessions list); params override if ever passed.
  const session = typeof params.session === "string" && params.session.trim() ? params.session : activeSession;
  const isVoiceHandoff = session.startsWith('voice-handoff-');
  const chatKey = chatStateKey(subject, session);
  const chatState = useSyncExternalStore(
    (cb) => subscribeChatState(chatKey, cb),
    () => getChatState(chatKey),
    () => getChatState(chatKey),
  );
  const { turns, busy, loading } = chatState;
  const activeRef = activeReference(groundTab);
  // the user can clear focus with the chip's ×; a newly-focused tab re-shows it.
  const [focusCleared, setFocusCleared] = useState(false);
  useEffect(() => { setFocusCleared(false); }, [activeRef?.raw]);
  // ambient schedule digest (context bundle): surface-gated, with a per-session explicit toggle
  const ambientEligible = scheduleEligible(activeList, groundTab);
  const [includeSchedule, setIncludeSchedule] = useState<boolean | null>(null);
  useEffect(() => { setIncludeSchedule(readIncludeSchedule(session)); }, [session]);
  const setAmbient = (v: boolean | null) => { setIncludeSchedule(v); writeIncludeSchedule(session, v); };
  const ambientOn = includeSchedule !== null ? includeSchedule : ambientEligible;
  // the bundle focus payload — meeting/file mirror the legacy `active`; workspace/today are new kinds
  const bundleFocus: FocusPayload | null = focusCleared ? null : focusTarget(groundTab);
  const focusRef = focusCleared ? null : activeRef;
  const meetings = useLiveMeetings();
  const activeMeeting = activeRef?.kind === "meeting"
    ? meetings.find((m) => m.id === activeRef.value || m.native_id === activeRef.value)
    : undefined;
  const contextRef: ActiveReference | null = focusRef?.kind === "meeting"
    ? { kind: "meeting", value: activeMeeting?.native_id ?? activeMeeting?.id ?? focusRef.value, raw: `@meeting:${activeMeeting?.native_id ?? activeMeeting?.id ?? focusRef.value}` }
    : focusRef;
  const [uploading, setUploading] = useState(false);
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the stream ONLY while the user is pinned to the bottom. Scrolling up to read
  // detaches (streaming updates no longer yank the view); scrolling back down re-attaches.
  // Sending a message always re-attaches — that's a human action asking for the reply.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentSeqRef = useRef(0);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  // ── mic dictation — STREAMING, meeting-pipeline style (sliding window + LocalAgreement
  //    via ui-kit/micDictation): confirmed + pending text land in the composer LIVE while
  //    speaking; stop flushes the final window. STT is proxied via /api/stt.
  const [mic, setMic] = useState<"idle" | "rec" | "stt">("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [micRestore, setMicRestore] = useState<{ base: string; raw: string } | null>(null);
  const micRef = useRef<StreamingDictation | null>(null);
  const micBaseRef = useRef("");     // composer text at record start — dictation appends after it
  const micStartRef = useRef(0);
  useEffect(() => () => { micRef.current?.cancel(); }, []);  // release the mic on unmount
  const micCompose = (base: string, confirmed: string, pending: string) => {
    const dictated = pending ? (confirmed ? `${confirmed} ${pending}` : pending) : confirmed;
    return base ? (dictated ? `${base} ${dictated}` : base) : dictated;
  };
  const toggleMic = async () => {
    if (mic === "stt") return;
    if (mic === "rec") {
      const d = micRef.current;
      micRef.current = null;
      if (!d) { setMic("idle"); return; }
      if (Date.now() - micStartRef.current < 300) { d.cancel(); setMic("idle"); return; }  // accidental tap
      setMic("stt");
      try {
        const final = await d.stop();
        const base = micBaseRef.current;
        const raw = final.trim();
        setValue(micCompose(base, raw, ""));
        if (raw) {
          try {
            const response = await fetch("/api/dictation/polish", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: raw }),
            });
            const data = await response.json().catch(() => ({})) as { polished_text?: string };
            const polished = typeof data.polished_text === "string" ? data.polished_text.trim() : "";
            if (!response.ok || !polished) throw new Error("polish unavailable");
            setValue(micCompose(base, polished, ""));
            setMicRestore(polished === raw ? null : { base, raw });
          } catch {
            setMicError("AI polish unavailable; original transcript kept.");
          }
        }
        window.setTimeout(() => inputRef.current?.focus(), 0);
      } catch (e) {
        setMicError(e instanceof Error ? e.message : "Transcription failed");
      } finally { setMic("idle"); }
      return;
    }
    try {
      setMicError(null);
      setMicRestore(null);
      micBaseRef.current = value.trim();
      micStartRef.current = Date.now();
      micRef.current = await startStreamingDictation({
        onUpdate: (confirmed, pending) => setValue(micCompose(micBaseRef.current, confirmed, pending)),
        onError: () => { /* transient mid-stream faults retry on the next window — stay quiet */ },
      });
      setMic("rec");
    } catch { setMicError("Microphone unavailable — check browser permissions."); }
  };

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener("tina:terminal:focus-chat", focus);
    return () => window.removeEventListener("tina:terminal:focus-chat", focus);
  }, []);

  useEffect(() => { if (inputRef.current) resizeComposerTextarea(inputRef.current); }, [value]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    for (const a of attachmentsRef.current) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
  }, []);

  // Load history into an idle, empty session snapshot. Live turns stay in the per-session store so switching
  // sessions never redirects or clears an in-flight stream.
  useEffect(() => {
    const key = chatKey;
    const state = getChatState(key);
    if (state.loaded || state.loading || state.busy) return;
    updateChatState(key, (s) => ({ ...s, loading: true }));
    // The result is committed to the per-session `key`, so it is safe to apply even if this effect run
    // was cancelled (deps changed / StrictMode remount): a real session switch targets a different key,
    // and an identical-key remount wants exactly this data. Crucially `loading` is ALWAYS released here —
    // bailing on cancel previously left `loading: true` stuck, and the guard above then blocked every retry,
    // hanging the pane forever on "Loading conversation…".
    (async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/history`);
        if (!r.ok) throw new Error('Could not load conversation history');
        const data: { turns?: HistoryTurn[] } = await r.json();
        const loaded: Turn[] = (data.turns ?? [])
          // Drop a PURE onboarding kickoff (legacy: marker with no user reply). A grounding-wrapped reply
          // (marker + grounding + reply) is KEPT and compacted to just the reply by compactStoredUserText.
          .filter((t) => !(t.role === "user" && t.text.includes(ONBOARDING_KICKOFF_MARK) && !t.text.includes(ONBOARDING_REPLY_SEP)))
          .map((t, i) =>
            t.role === "user"
              ? { id: `h-u-${i}`, role: "user", text: compactStoredUserText(t.text) }
              : { id: `h-a-${i}`, role: "agent", text: t.text, ops: (t.ops ?? []).map(historyOp), commit: t.commit });
        updateChatState(key, (s) => {
          if (s.loaded || s.busy || s.turns.length > 0) return { ...s, loading: false, loaded: true };
          return { ...s, turns: loaded, nextId: Math.max(s.nextId, loaded.length), loading: false, loaded: true };
        });
      } catch {
        // A failed fetch must always clear `loading` (never hang) and leave `loaded` false so it retries.
        updateChatState(key, (s) => (s.loaded ? s : { ...s, loading: false }));
      }
    })();
  }, [chatKey, session, subject]);

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setUploadError(null);
    setAttachments((current) => [
      ...current,
      ...files.map((file) => {
        const isImage = file.type.startsWith("image/");
        return {
          id: `att-${attachmentSeqRef.current++}`,
          file,
          isImage,
          previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        };
      }),
    ]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((a) => {
      if (a.id !== id) return true;
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return false;
    }));
  };

  const clearAttachments = () => {
    setAttachments((current) => {
      for (const a of current) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      return [];
    });
  };

  const uploadAttachments = async (): Promise<UploadedWorkspaceFile[]> => {
    const form = new FormData();
    for (const a of attachments) form.append("files", a.file, a.file.name || "upload");
    const r = await fetch("/api/workspace/upload", { method: "POST", body: form });
    if (!r.ok) {
      let detail = `Upload failed (${r.status})`;
      try {
        const data = await r.json() as { detail?: string };
        if (data.detail) detail = data.detail;
      } catch {
        // keep the status-derived message
      }
      throw new Error(detail);
    }
    const data = await r.json() as { files?: UploadedWorkspaceFile[] };
    return data.files ?? [];
  };

  const send = async (text: string, prompt = text, referenceSource = text, opts: Omit<AskChatDetail, 'prompt'> = {}) => {
    // hidden → no visible user bubble (system kickoffs); ground:false → don't append the active
    // meeting/file context (onboarding must not inherit whatever meeting happens to be focused).
    const { hidden = false, ground = !isVoiceHandoff, focus: focusOverride } = opts;
    const sendContextRef: ActiveReference | null = focusOverride
      ? { kind: "meeting", value: focusOverride.native_id, raw: `@meeting:${focusOverride.native_id}` }
      : contextRef;
    const sendMeeting = focusOverride
      ? meetings.find((m) => m.id === focusOverride.meeting_id || m.native_id === focusOverride.native_id)
      : activeMeeting;
    const sendBundleFocus: FocusPayload | null = focusOverride ?? bundleFocus;
    const v = text.trim();
    const basePrompt = promptWithReferences(prompt, referenceSource.trim());
    const key = chatKey;
    const sessionForSend = session;
    const state = getChatState(key);
    if (!v || !basePrompt || state.busy) {
      opts.onRejected?.(state.busy ? 'Chat is busy. Wait for the current response or stop it, then retry.' : 'Enter a chat request.');
      return;
    }
    const n = state.nextId;
    const agentId = `a-${n}`;
    const displayText = ground ? appendReferenceToken(v, sendContextRef) : v;
    const ctrl = new AbortController();
    const newTurns = hidden
      ? [{ id: agentId, role: "agent" as const, text: "", ops: [] }]
      : [{ id: `u-${n}`, role: "user" as const, text: displayText }, { id: agentId, role: "agent" as const, text: "", ops: [] }];
    updateChatState(key, (s) => ({
      ...s,
      turns: [...s.turns, ...newTurns],
      busy: true,
      loading: false,
      loaded: true,
      nextId: Math.max(s.nextId, n + 1),
      abort: ctrl,
    }));
    opts.onAccepted?.();
    // Cold-start / mid-turn-drop robustness lives in streamChatTurn: a chat turn spawns a FRESH
    // per-dispatch worker (docker backend) that takes seconds to boot, and the turn is NEVER lost even
    // if the SSE closes early (durable, resumable output Stream). So instead of "No chat output arrived"
    // the instant a stream ends, it RESUMES from the last SSE cursor (Last-Event-ID) and keeps rendering.
    // A live STATUS LINE (turn.status, driven by onStatus below) keeps the pane VERBOSE about what's
    // happening — "Starting agent…", "Working · 12s", "Reconnecting…" — so a long think / tool run / a
    // broken SSE reads as alive, never a frozen blank. Real output (a delta / tool / terminal) clears it.
    // `since` is per-gap: cleared on output, re-stamped when the next quiet stretch begins, so the counter
    // measures the CURRENT wait (the useful "is it stuck?" signal), not total turn time.
    const setStatus = (phase: ChatPhase | null) =>
      patchAgentTurn(key, agentId, (t) => ({ ...t, status: phase ? { phase, since: t.status?.since ?? Date.now() } : null }));
    const p = ground ? promptWithActiveContext(basePrompt, sendContextRef, sendMeeting) : basePrompt;
    // The active center tab grounds the turn: a meeting passes {kind, platform, native_id, meeting_id} so
    // agent-api folds its live transcript into the prompt server-side; a file passes {kind, ref}.
    // P0 (cross-tenant leak fix): `meeting_id` is the meetings-domain ROW id (the mock's `id`) — the
    // transcript carrier keys on it, so grounding reads THIS row's transcript (`tc:meeting:{row_id}`),
    // never a DIFFERENT tenant's / an older row's under the shared native. `native_id` is display only.
    // The meeting's raw STATUS (+ title/when/workspace) rides along so agent-api branches the
    // grounding by lifecycle phase — prep (no transcript, steer preparation) / live (fold the live
    // stream) / post (fold the processed notes). A status-less payload keeps the legacy live path.
    const active = !ground || !sendContextRef
      ? undefined
      : sendContextRef.kind === "meeting"
        ? {
            kind: "meeting", native_id: sendMeeting?.native_id ?? focusOverride?.native_id ?? sendContextRef.value,
            meeting_id: sendMeeting?.id ?? focusOverride?.meeting_id,
            platform: sendMeeting ? meetingPlatformSlug(sendMeeting) : focusOverride?.platform,
            status: sendMeeting?.live_status ?? focusOverride?.status,
            title: sendMeeting ? meetingLabel(sendMeeting) : focusOverride?.title,
            scheduled_at: sendMeeting?.scheduled_at ?? focusOverride?.scheduled_at,
            workspace_id: sendMeeting?.workspace_id ?? focusOverride?.workspace_id,
          }
        : { kind: sendContextRef.kind, ref: sendContextRef.raw };
    // The CONTEXT BUNDLE (slice 1): tz + surface + focus + explicit include toggles. The focus
    // mirrors `active` for meeting/file (server prefers `context`); workspace/today are new
    // focus kinds the server folds itself. ground:false (onboarding) sends no bundle at all.
    const wireFocus: FocusPayload | null | undefined = !ground
      ? undefined
      : (active && (active.kind === "meeting" || active.kind === "file"))
        ? (active as FocusPayload)
        : sendBundleFocus;
    const context = !ground ? undefined : buildChatContext({
      activeList, activeTab: groundTab, focus: wireFocus ?? null, includeSchedule,
    });
    try {
      const result = await streamChatTurn(
        { prompt: p, session: sessionForSend, active, context, ...(opts.research ? { research: true } : {}) },
        {
          onStarting: () => {},  // visual is driven by onStatus (below); the stream still signals cold-start here
          onStatus: (phase) => setStatus(phase),
          onDelta: (text) => patchAgentTurn(key, agentId, (t) => ({ ...t, status: null, text: (t.text ?? "") + text })),
          onReply: (text) => patchAgentTurn(key, agentId, (t) => ({ ...t, status: null, text })),
          onTool: (tool) => patchAgentTurn(key, agentId, (t) => ({ ...t, status: null, ops: [...t.ops, toolOp(tool)] })),
          onCommit: (sha) => patchAgentTurn(key, agentId, (t) => ({ ...t, commit: sha })),
          onRejected: () => patchAgentTurn(key, agentId, (t) => ({ ...t, status: null, rejected: "workspace.v1 violation — reverted" })),
          onModelFailure: (reply) => patchAgentTurn(key, agentId, (t) => ({ ...t, status: null, text: (t.text ?? "") + (t.text ? "\n\n" : "") + `Model inference failed${reply ? `: ${reply}` : "."}` })),
          onError: (msg) => patchAgentTurn(key, agentId, (t) => ({ ...t, status: null, text: (t.text ?? "") + (t.text ? "\n\n" : "") + msg })),
          onApprovalRequest: (request) => patchAgentTurn(key, agentId, (t) => {
            if (t.approvals?.some((approval) => approval.approval_id === request.approval_id)) return t;
            return { ...t, approvals: [...(t.approvals ?? []), { ...request, status: "pending" }] };
          }),
          onApprovalResolved: (resolved) => patchAgentTurn(key, agentId, (t) => ({
            ...t,
            approvals: t.approvals?.map((approval) => approval.approval_id === resolved.approval_id
              ? { ...approval, status: resolved.outcome, error: undefined }
              : approval),
          })),
          onProgress: () => { if (stickToBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); },
        },
        { signal: ctrl.signal },
      );
      if (!result.aborted && !result.terminal) {
        // The turn never reached a clean end even after resuming past the hard cap — the connection is
        // genuinely lost. Say so (fail-loud, P18): append a note if there was partial output, else the
        // timeout copy. The worker may still finish server-side, so point the user at a reopen.
        patchAgentTurn(key, agentId, (t) => {
          const base = t.text ?? "";
          return { ...t, status: null, text: base
            ? base + "\n\n_Connection lost before the reply finished — reopen the chat to see the rest if it lands._"
            : "The agent didn't respond before timing out. Reopen the chat to see the reply if it lands." };
        });
      } else {
        patchAgentTurn(key, agentId, (t) => ({ ...t, status: null }));  // clean end — drop any lingering status line
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") patchAgentTurn(key, agentId, (t) => ({ ...t, status: null, text: (t.text ?? "") + (t.text ? "\n\n" : "") + "_stopped_" }));
      else patchAgentTurn(key, agentId, (t) => ({ ...t, status: null, text: (t.text ?? "") + (t.text ? "\n\n" : "") + ((e as Error)?.message || "Chat request failed.") }));
    } finally {
      updateChatState(key, (s) => ({ ...s, busy: false, abort: null }));
    }
  };

  const respondToApproval = async (approvalId: string, decision: "approve" | "deny") => {
    const key = chatKey;
    const sessionForApproval = session;
    const pendingTurn = getChatState(key).turns.find((turn) =>
      turn.role === "agent" && turn.approvals?.some((approval) => approval.approval_id === approvalId));
    if (!pendingTurn || pendingTurn.role !== "agent") return;
    const approval = pendingTurn.approvals?.find((candidate) => candidate.approval_id === approvalId);
    if (!approval || approval.status !== "pending") return;
    const agentId = pendingTurn.id;
    patchAgentTurn(key, agentId, (turn) => ({
      ...turn,
      approvals: turn.approvals?.map((candidate) => candidate.approval_id === approvalId
        ? { ...candidate, status: "submitting", error: undefined }
        : candidate),
    }));
    try {
      const response = await fetch("/api/chat/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: sessionForApproval,
          approval_id: approvalId,
          turn_id: approval.turn_id,
          decision,
        }),
      });
      if (!response.ok) throw new Error(`Approval response failed (${response.status})`);
    } catch {
      patchAgentTurn(key, agentId, (turn) => ({
        ...turn,
        approvals: turn.approvals?.map((candidate) => candidate.approval_id === approvalId
          && candidate.status === "submitting"
          ? { ...candidate, status: "pending", error: "Could not send your decision. Try again." }
          : candidate),
      }));
    }
  };

  const stop = () => {
    getChatState(chatKey).abort?.abort();
    updateChatState(chatKey, (s) => ({ ...s, busy: false, abort: null }));
  };

  // A canvas keyword chip (or any harness `actions.ask`) asks the visible chat a question: reveal the rail
  // and stream the answer here. sendRef keeps the latest `send` closure so the listener stays stable.
  const sendRef = useRef(send);
  sendRef.current = send;
  const handoffSessionRef = useRef<string | null>(null);
  useEffect(()=>{if (!value.trim()) handoffSessionRef.current = null;},[value]);
  const composeRef = useRef({value, busy, uploading, mic, attachments, center, session});
  composeRef.current = {value, busy, uploading, mic, attachments, center, session};
  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<AskChatDetail>).detail;
      const prompt = detail?.prompt;
      if (!prompt || detail.handled) return;
      if (detail.composeOnly) {
        const current = composeRef.current;
        if (current.center || typeof params.session === 'string') return;
        detail.handled = true;
        if (!detail.session || current.value.trim() || current.busy || current.uploading || current.mic !== 'idle' || current.attachments.length
            || getChatState(chatStateKey(subject, detail.session)).busy) {
          detail.onRejected?.('Finish or clear your current chat draft, then retry.'); return;
        }
        handoffSessionRef.current = detail.session;
        layout.setActiveSession(detail.session);
        setValue(prompt);
        if (layout.store.getState().rightCollapsed) layout.toggleRight();
        detail.onAccepted?.();
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      detail.handled = true;
      if (layout.store.getState().rightCollapsed) layout.toggleRight();
      void sendRef.current(prompt, prompt, prompt, detail);
    };
    window.addEventListener(ASK_CHAT_EVENT, onAsk);
    return () => window.removeEventListener(ASK_CHAT_EVENT, onAsk);
  }, [layout, params.session, subject]);

  // Onboarding seeds a CACHED greeting (instant, no LLM) and arms the chat — the user's next reply carries
  // the discovery-loop grounding (applied in onSubmit), so the agent starts researching from one answer.
  const onboardingArmedRef = useRef(false);
  useEffect(() => {
    const onSeed = () => {
      if (layout.store.getState().rightCollapsed) layout.toggleRight();
      const key = chatKey;
      updateChatState(key, (s) => (
        s.turns.length
          ? { ...s, loaded: true, loading: false }
          : { ...s, turns: [{ id: "onb-greeting", role: "agent", text: ONBOARDING_GREETING, ops: [] }], nextId: Math.max(s.nextId, 1), loaded: true, loading: false }
      ));
      onboardingArmedRef.current = true;
    };
    window.addEventListener(ONBOARDING_SEED_EVENT, onSeed);
    return () => window.removeEventListener(ONBOARDING_SEED_EVENT, onSeed);
  }, [layout, chatKey]);

  const focusInput = () => window.setTimeout(() => inputRef.current?.focus(), 0);
  const selectSession = (id: string) => { layout.setActiveSession(id); focusInput(); };
  const newChat = () => selectSession(`chat-${Date.now().toString(36)}`);

  const onSubmit = async () => {
    if (mic === "stt") return;
    const v = value.trim();
    const hasAttachments = attachments.length > 0;
    if ((!v && !hasAttachments) || busy || uploading) return;
    if (handoffSessionRef.current && handoffSessionRef.current !== session) {
      setUploadError('Return to the voice handoff chat before sending, or clear this draft.'); return;
    }
    setUploadError(null);
    const research = /^\/research(?:\s|$)/i.test(v);
    if (research && !v.slice('/research'.length).trim()) {
      setUploadError('Nhập chủ đề sau /research, ví dụ: /research So sánh tài liệu repo với nguồn web.');
      return;
    }
    stickToBottomRef.current = true;  // sending re-attaches follow-the-stream
    window.setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }), 0);
    if (!hasAttachments && isRoutineCommand(v)) { void send(v, routineCreationPrompt(v)); setValue(""); setMicRestore(null); return; }
    if (!hasAttachments && !research && v.startsWith("/")) { const sk = commands.querySkills(v)[0]; if (sk) { void commands.execute(sk.id, v); setValue(""); setMicRestore(null); return; } }
    let prompt = isRoutineCommand(v) ? routineCreationPrompt(v) : v;
    let displayText = v;
    let referenceSource = v;
    if (hasAttachments) {
      setUploading(true);
      setUploadError(null);
      let uploaded: UploadedWorkspaceFile[];
      try {
        uploaded = await uploadAttachments();
      } catch (e) {
        setUploadError((e as Error)?.message || "Upload failed");
        setUploading(false);
        return;
      }
      setUploading(false);
      prompt = attachmentPrompt(prompt, uploaded);
      referenceSource = [v, uploaded.map((f) => `@file:${f.path}`).join("\n")].filter(Boolean).join("\n");
      displayText = displayText || `Attached files: ${uploaded.map((f) => f.name).join(", ")}`;
      clearAttachments();
    }
    // First onboarding reply: prepend the (hidden) discovery-loop grounding so the agent researches from
    // this one answer. compactStoredUserText strips it back off on reload; the user only ever sees `displayText`.
    if (onboardingArmedRef.current && !hasAttachments) {
      onboardingArmedRef.current = false;
      prompt = ONBOARDING_GROUNDING + ONBOARDING_REPLY_SEP + prompt;
    }
    void send(displayText, prompt, referenceSource, { research });
    setValue("");
    setMicRestore(null);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  };

  const slash = value.startsWith("/");
  const skills = slash ? commands.querySkills(value) : [];

  const composer = (
    <>
      {slash && skills.length > 0 && (
        <div style={{ border: "1px solid var(--line2)", borderRadius: 11, background: "var(--panel)", overflow: "hidden" }}>
          {skills.map((c) => <div key={c.id} onMouseDown={() => setValue(c.skill! + " ")} style={{ display: "flex", gap: 10, padding: "9px 12px", cursor: "pointer", fontSize: 13 }}><code style={{ fontFamily: "var(--mono)", color: "var(--accent)", minWidth: 88 }}>{c.skill}</code><span style={{ color: "var(--t3)", fontSize: 12 }}>{c.title}</span></div>)}
        </div>
      )}
      <div
        className="composer-box"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        style={{ border: "1px solid var(--line2)", borderRadius: 12, background: "var(--panel)", padding: "9px 12px", display: "flex", flexDirection: "column", gap: 7 }}
      >
        {isVoiceHandoff && <div title="Voice context is rechecked on Send and expires after 15 minutes." style={{fontSize:"var(--ui-type-meta)",color:'var(--t3)'}}>Voice handoff: private chat</div>}
        {!isVoiceHandoff && (contextRef || ambientEligible || includeSchedule === true || (bundleFocus && (bundleFocus.kind === "workspace" || bundleFocus.kind === "today"))) && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
            {/* ambient schedule chip — the context bundle's always-visible half: on = the agent
                sees today's schedule; × turns it off for this session; ghost chip re-adds */}
            {ambientOn ? (
              <span title="The agent sees your schedule (today, upcoming, live) on this surface"
                style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--t2)", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 999, padding: "2px 4px 2px 9px" }}>
                <Icon name="cal" size={10} /> Schedule: today
                <button aria-label="Remove schedule context" title="Remove schedule context for this session" onClick={() => setAmbient(false)}
                  style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", display: "flex", padding: 2 }}><Icon name="x" size={10} /></button>
              </span>
            ) : ambientEligible ? (
              <button onClick={() => setAmbient(null)} title="Include your schedule in the agent's context"
                style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--t3)", background: "transparent", border: "1px dashed var(--line2)", borderRadius: 999, padding: "2px 9px", cursor: "pointer" }}>
                + schedule
              </button>
            ) : null}
            {/* B4 carve: the meeting focus is ONE chip — `Preparing · Title ×` — never a mono
                uppercase label plus a second raw-id Focus chip for the same meeting. */}
            {contextRef && contextRef.kind === "meeting" && activeMeeting ? (() => {
              const mode = MODE_CHIP[meetingPhase(activeMeeting)];
              return (
                <span title={`This chat is grounded in the meeting's ${mode.label.toLowerCase()} state`}
                  style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5,
                    fontWeight: 600, color: mode.color, background: mode.bg, borderRadius: 999,
                    padding: "2px 5px 2px 10px", maxWidth: 260, minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {mode.label}: {meetingLabel(activeMeeting)}
                  </span>
                  <button aria-label="Clear focus" title="Clear focus" onClick={() => setFocusCleared(true)}
                    style={{ background: "none", border: "none", color: mode.color, opacity: 0.7, cursor: "pointer", display: "flex", padding: 2, flex: "none" }}><Icon name="x" size={10} /></button>
                </span>
              );
            })() : contextRef ? (
              <>
                <span style={{ color: "var(--t3)", fontSize: "var(--ui-type-meta)", flex: "none" }}>Focus</span>
                <ReferenceChip refToken={contextRef} />
                <button aria-label="Clear focus" title="Clear focus" onClick={() => setFocusCleared(true)} style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", display: "flex", padding: 0, marginLeft: 2, flex: "none" }}><Icon name="x" size={12} /></button>
              </>
            ) : null}
            {!contextRef && bundleFocus && (bundleFocus.kind === "workspace" || bundleFocus.kind === "today") && (
              <>
                <span style={{ color: "var(--t3)", fontSize: "var(--ui-type-meta)", flex: "none" }}>Focus</span>
                <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: bundleFocus.kind === "workspace" ? "var(--blue)" : "var(--t2)", background: bundleFocus.kind === "workspace" ? "var(--bluebg)" : "var(--panel2)", border: "1px solid var(--line)", borderRadius: 6, padding: "1px 7px" }}>
                  <Icon name={bundleFocus.kind === "workspace" ? "panel" : "cal"} size={10} />
                  {bundleFocus.kind === "workspace" ? `Workspace: ${bundleFocus.slug}` : "Today"}
                </span>
                <button aria-label="Clear focus" title="Clear focus" onClick={() => setFocusCleared(true)} style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", display: "flex", padding: 0, marginLeft: 2, flex: "none" }}><Icon name="x" size={12} /></button>
              </>
            )}
          </div>
        )}
        <ComposerReferences text={value} />
        <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
        {uploadError && <div style={{ color: "var(--danger)", fontSize: 12, lineHeight: 1.35 }}>{uploadError}</div>}
        {micError && <div style={{ color: "var(--danger)", fontSize: 12, lineHeight: 1.35 }}>{micError}</div>}
        {micRestore && <button type="button" onClick={() => {
          setValue(micCompose(micRestore.base, micRestore.raw, ""));
          setMicRestore(null);
          setMicError(null);
        }} style={{ alignSelf: "flex-start", border: "1px solid var(--line2)", borderRadius: 6, background: "transparent", color: "var(--t2)", fontSize: "var(--ui-type-meta)", padding: "4px 8px", cursor: "pointer" }}>
          Restore original ASR
        </button>}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.currentTarget.value = ""; }}
          style={{ display: "none" }}
        />
        <div style={{ display: "flex", alignItems: "flex-end", gap: 9 }}>
          <span aria-hidden="true" style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 16, fontWeight: 700, height: 30, display: "flex", alignItems: "center", flex: "none" }}>&gt;</span>
          <textarea
            ref={inputRef}
            value={value}
            onChange={(e) => { setValue(e.target.value); if (!e.target.value.trim()) handoffSessionRef.current = null; setMicRestore(null); }}
            onInput={(e) => resizeComposerTextarea(e.currentTarget)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey) return;
              e.preventDefault();
              void onSubmit();
            }}
            placeholder={!isVoiceHandoff && contextRef?.kind === "meeting" && activeMeeting
              ? MODE_PLACEHOLDER[meetingPhase(activeMeeting)]
              : "Type / for skills, or ask the agent…"}
            disabled={uploading || mic === "stt"}
            rows={1}
            style={{ flex: 1, background: "none", border: "none", color: "var(--t1)", fontSize: 14, lineHeight: "20px", minWidth: 0, minHeight: 28, maxHeight: MAX_TEXTAREA_HEIGHT, resize: "none", overflowY: "hidden", padding: "4px 0", margin: 0, fontFamily: "inherit" }}
          />
          <button type="button" aria-label="Attach files" title="Attach files" disabled={busy || uploading || mic === "stt"} onClick={() => fileInputRef.current?.click()}
            style={{ background: "transparent", color: "var(--t3)", border: "1px solid var(--line2)", width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: busy || uploading || mic === "stt" ? "default" : "pointer", flex: "none", opacity: busy || uploading || mic === "stt" ? 0.6 : 1 }}>
            <Icon name="paperclip" size={15} />
          </button>
          <button type="button"
            aria-label={mic === "rec" ? "Stop recording" : "Dictate"}
            title={mic === "rec" ? "Stop recording (transcribes into the composer)" : mic === "stt" ? "Transcribing and polishing…" : "Dictate"}
            disabled={uploading || mic === "stt"}
            onClick={() => void toggleMic()}
            style={{
              background: mic === "rec" ? "var(--accentbg)" : "transparent",
              color: mic === "rec" ? "var(--accent)" : "var(--t3)",
              border: `1px solid ${mic === "rec" ? "var(--accent)" : "var(--line2)"}`,
              width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
              cursor: uploading || mic === "stt" ? "default" : "pointer", flex: "none", opacity: mic === "stt" ? 0.6 : 1,
            }}>
            {mic === "stt"
              ? <span className="vx-op-spin" style={{ width: 12, height: 12, border: "2px solid var(--line2)", borderTopColor: "var(--t2)", borderRadius: "50%", display: "block" }} />
              : <Icon name="mic" size={15} />}
          </button>
          {busy
            ? <button aria-label="Stop" title="Stop" onClick={stop} style={{ background: "var(--panel2)", color: "var(--t1)", border: "1px solid var(--line2)", width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flex: "none" }}><span style={{ width: 10, height: 10, background: "var(--t1)", borderRadius: 2, display: "block" }} /></button>
            : <button aria-label="Send" disabled={uploading || mic === "stt"} onClick={() => void onSubmit()} style={{ background: "var(--accent)", color: "var(--on-accent)", border: "none", width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: uploading || mic === "stt" ? "default" : "pointer", flex: "none", opacity: uploading || mic === "stt" ? 0.7 : 1 }}><Icon name="send" size={16} /></button>}
        </div>
      </div>
    </>
  );

  return (
    <AgentWindow
      top={center
        ? (
          <div style={{ flex: "none" }}>
            <ThreadCrumb ground={groundTab} />
            <ChatHeader subject={subject} session={session} onSelectSession={selectSession} onNewChat={newChat} />
          </div>
        )
        : <ChatHeader subject={subject} session={session} onSelectSession={selectSession} onNewChat={newChat} onClose={() => layout.toggleRight()} />}
      scrollRef={scrollRef}
      composer={composer}
    >
      <ChatConversation
        turns={turns}
        busy={busy || loading}
        onApprovalDecision={respondToApproval}
        empty={
          <div style={{ display: "flex", flexDirection: "column", height: "100%", justifyContent: "space-between", padding: "20px 4px 10px" }}>
            <div style={{ color: "var(--t3)", fontSize: 13, textAlign: "center", lineHeight: 1.6, padding: "0 10px" }}>
              {loading ? "Loading conversation…" : "Ask the agent to record, research, or restructure knowledge — it writes to your git workspace and commits."}
            </div>
            {!loading && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 24 }}>
                <div style={{ fontSize: "var(--ui-type-meta)", fontWeight: 600, color: "var(--t3)", marginBottom: 2 }}>
                  Quick starters
                </div>
                {[
                  { icon: "cal", label: "Summarize last meeting decisions", prompt: "Summarize the key decisions and action items from the most recent meeting." },
                  { icon: "panel", label: "Search Knowledge notes", prompt: "Search through Knowledge files and list recent architectural updates." },
                  { icon: "spark", label: "Draft routine for workspace", prompt: "/routine daily sync notes at 9am" },
                ].map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => {
                      setValue(s.prompt);
                      inputRef.current?.focus();
                    }}
                    style={{
                      background: "var(--panel)",
                      border: "1px solid var(--line)",
                      borderRadius: 8,
                      padding: "8px 12px",
                      fontSize: 12,
                      color: "var(--t2)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      textAlign: "left",
                      transition: "all .12s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--panel2)";
                      e.currentTarget.style.borderColor = "var(--accent)";
                      e.currentTarget.style.color = "var(--t1)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "var(--panel)";
                      e.currentTarget.style.borderColor = "var(--line)";
                      e.currentTarget.style.color = "var(--t2)";
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Icon name={s.icon} size={13} style={{ color: "var(--accent)" }} />
                      <span>{s.label}</span>
                    </span>
                    <span style={{ color: "var(--t3)", fontSize: 11 }}>→</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      />
    </AgentWindow>
  );
}

// Agent /-skills — absent in meetings-only mode (NEXT_PUBLIC_TERMINAL_MODE=meetings), where the chat
// rail itself doesn't render (Workbench) and the proxy refuses agent paths.
if (!meetingsOnly()) {
  registerCommand({ id: "skill.research", title: "Research and file to the workspace", skill: "/research", run: () => {} });
  registerCommand({ id: "skill.draft", title: "Draft an email or doc", skill: "/draft", run: () => {} });
  registerCommand({ id: "skill.routine", title: "Create a scheduled routine", skill: ROUTINE_COMMAND, run: () => {} });
}
