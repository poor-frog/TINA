"use client";
/** MeetingSidePanel — Right column of MeetingDetailView with two underline tabs:
 *  1. Ask Tina: real streaming `/api/chat` grounded on this meeting (plus a switch to
 *     real source-cited `<MeetingKnowledge />` Wiki Q&A).
 *  2. Transcript: real durable + live transcript chronologically interleaved with real
 *     Voice Agent TTS ("TINA Agent") replies from `/api/meetings/{id}/voice-assistant`
 *     (matching TINA Chrome Extension), with search, speaker/question/topic/TINA filters,
 *     bilingual VI/EN/Song ngữ translation, source citations, and audio sync. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { WebIcon } from "./Icons";
import { AgentActivitySteps } from "./AgentActivitySteps";
import { LucianThinkingText } from "./lucian/LucianThinkingText";
import { LucianSelectionTooltip } from "./lucian/LucianSelectionTooltip";
import { LucianVoiceOrb, type VoiceOrbState } from "./lucian/LucianVoiceOrb";
import { LucianReadAloud } from "./lucian/LucianReadAloud";
import { LucianSlidingTabs } from "./lucian/LucianSlidingTabs";
import {
  LucianMentionChips,
  LucianMentionPopover,
  LucianMentionTriggerButton,
  compileMentionContext,
  detectMentionAtCursor,
  filterMentionTargets,
  findMentionBeforeCursor,
  type MentionMatch,
  type MentionTarget,
} from "./lucian/LucianMentionPicker";
import {
  LucianSlashPopover,
  LucianSlashTriggerButton,
  compileSlashPrompt,
  detectSlashAtStart,
  filterSlashCommands,
  type SlashCommandDef,
  type SlashCommandId,
  type SlashMatch,
} from "./lucian/LucianSlashPicker";
import { buildMentionCatalog, saveReplyToKnowledge } from "./chatComposerUtils";
import { emitWebToast } from "./lucian/webToast";
import { Markdown } from "../ui-kit/Markdown";
import { streamChatTurn, type ChatPhase } from "../surfaces/chatStream";
import { presentError } from "../surfaces/apiClient";
import { listWorkspaceTree } from "../surfaces/workspaceApi";
import { MeetingKnowledge } from "../surfaces/MeetingKnowledge";
import { VoiceReplySources } from "../surfaces/VoiceReplySources";
import { meetingPhase, type MeetingMock, type TranscriptLine } from "../surfaces/meetingModel";
import type { ProcessedNoteDTO } from "../surfaces/liveMeetings";
import type { TranscriptLanguage, TranslationSnapshot } from "../canvas/MeetingTranslation";
import { projectTranslationGroups } from "../canvas/translationGroups";
import styles from "./meetingDetail.module.css";

const MEETING_SLASH_IDS: readonly SlashCommandId[] = [
  "recap",
  "prep",
  "tasks",
  "draft",
  "research",
  "schedule",
  "save",
  "new",
];

export interface MeetingVoiceReply {
  request_id: string;
  text: string;
  played_text?: string | null;
  state: string;
  created_at_ms: number;
  source_count?: number;
  answer_kind?: string;
  links?: Array<{ url: string; title: string }>;
}

const VOICE_STATE_LABEL: Record<string, string> = {
  queued: "Đang chuẩn bị đọc",
  started: "Đang đọc",
  completed: "Đã đọc",
  stopped: "Đã dừng",
  failed: "Phát thất bại",
  unconfirmed: "Chưa xác nhận phát xong",
};

const VOICE_KIND_LABEL: Record<string, string> = {
  web: "Web",
  general: "Kiến thức chung",
  assistant: "Trợ lý",
  meeting: "Nguồn meeting",
};

interface SideMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  ops?: string[];
  error?: string;
}

const STARTERS = [
  "What were the main topics?",
  "Identify the key decisions made.",
];

const QUICK_CHIPS = [
  { label: "Coach Me", prompt: "Analyze my speaking pace, clarity, and participation balance in this meeting and suggest concrete coaching tips." },
  { label: "Follow-up Email", prompt: "Draft a concise follow-up email summarizing the key decisions and next steps from this meeting." },
];

function formatTimeMs(ms: number): string {
  const dt = new Date(ms);
  if (!Number.isFinite(dt.getTime())) return "";
  return dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatEpochShort(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const dt = new Date(seconds > 1_000_000_000 ? seconds * 1000 : seconds * 1000);
  if (!Number.isFinite(dt.getTime())) return "";
  return dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function normalizeSortMs(tsMs: number | undefined, meetingStartMs: number | undefined, fallbackOrder: number): number {
  if (typeof tsMs === "number" && Number.isFinite(tsMs)) {
    if (tsMs > 100_000_000_000) return tsMs;
    if (typeof meetingStartMs === "number" && Number.isFinite(meetingStartMs)) return meetingStartMs + tsMs;
    return tsMs;
  }
  if (typeof meetingStartMs === "number" && Number.isFinite(meetingStartMs)) {
    return meetingStartMs + fallbackOrder;
  }
  return fallbackOrder;
}

type TimelineItem =
  | {
      kind: "segment";
      key: string;
      sortMs: number;
      order: number;
      segmentId?: string;
      memberIds: string[];
      speaker: string;
      time: string;
      primaryText: string;
      secondaryText: string;
      isDraft: boolean;
      playable: boolean;
    }
  | {
      kind: "voice-reply";
      key: string;
      sortMs: number;
      order: number;
      reply: MeetingVoiceReply;
      displayText: string;
      partial: boolean;
    };

export function MeetingSidePanel({
  meetingId,
  meeting,
  firstName,
  meetingsOnly,
  sideTab,
  onSideTabChange,
  lines,
  processedNotes,
  voiceReplies,
  meetingStartMs,
  isLive,
  language,
  translationSnapshot,
  translationError,
  onRetryTranslation,
  speakerFilter,
  questionsOnly,
  trackerFilter,
  onClearSpeaker,
  onClearQuestions,
  onClearTracker,
  playableSegmentIds,
  activeSegmentId,
  audioVirtualSec,
  onSegmentClick,
  pendingPrompt,
  onConsumePendingPrompt,
  expanded = false,
  onToggleExpand,
}: {
  meetingId: string;
  meeting?: MeetingMock;
  firstName: string;
  meetingsOnly: boolean;
  sideTab: "ask" | "transcript";
  onSideTabChange: (tab: "ask" | "transcript") => void;
  lines: TranscriptLine[];
  processedNotes: ProcessedNoteDTO[];
  voiceReplies: MeetingVoiceReply[];
  meetingStartMs?: number;
  isLive: boolean;
  language: TranscriptLanguage;
  translationSnapshot: TranslationSnapshot | null;
  translationError: string;
  onRetryTranslation: () => void;
  speakerFilter: string;
  questionsOnly: boolean;
  trackerFilter: string;
  onClearSpeaker: () => void;
  onClearQuestions: () => void;
  onClearTracker: () => void;
  playableSegmentIds: ReadonlySet<string>;
  activeSegmentId: string | null;
  audioVirtualSec?: number;
  onSegmentClick?: (segmentId: string) => void;
  pendingPrompt: string | null;
  onConsumePendingPrompt: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [askMode, setAskMode] = useState<"chat" | "citations">("chat");
  const [messages, setMessages] = useState<SideMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ChatPhase | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [workspaceDocs, setWorkspaceDocs] = useState<string[]>([]);
  const [mentionedItems, setMentionedItems] = useState<MentionTarget[]>([]);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0);
  const [slashMatch, setSlashMatch] = useState<SlashMatch | null>(null);
  const [slashActiveIdx, setSlashActiveIdx] = useState(0);
  const [includeSchedule, setIncludeSchedule] = useState(false);

  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [showProcessed, setShowProcessed] = useState(false);
  const [tinaOnly, setTinaOnly] = useState(false);
  const [openSourceReplyId, setOpenSourceReplyId] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [highlightedKeys, setHighlightedKeys] = useState<Record<string, boolean>>({});

  const sessionRef = useRef(`meeting-${meetingId}-${Date.now().toString(36)}`);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const draftInputRef = useRef<HTMLTextAreaElement>(null);
  const followingRef = useRef(true);
  const messagesRef = useRef<SideMessage[]>([]);
  const mentionListboxId = useId();
  const slashListboxId = useId();

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sessionRef.current = `meeting-${meetingId}-${Date.now().toString(36)}`;
    setMessages([]);
    setDraft("");
    setMentionedItems([]);
    setMentionMatch(null);
    setSlashMatch(null);
    setIncludeSchedule(false);
    setBusy(false);
    setPhase(null);
    setTranscriptQuery("");
    setShowProcessed(false);
    setTinaOnly(false);
    setOpenSourceReplyId(null);
    setHighlightedKeys({});
    setAskMode("chat");
  }, [meetingId]);

  useEffect(() => {
    if (meetingsOnly || sideTab !== "ask") return;
    let alive = true;
    void listWorkspaceTree()
      .then((files) => {
        if (alive && Array.isArray(files)) setWorkspaceDocs(files);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [meetingsOnly, sideTab]);

  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, phase]);

  const mentionCatalog = useMemo(() => {
    const extraPeople: Array<{ name?: string | null; email?: string | null }> = [];
    for (const attendee of meeting?.attendees ?? []) {
      extraPeople.push({ name: attendee.name, email: attendee.email });
    }
    for (const p of meeting?.participants ?? []) {
      const clean = (p?.name || "").trim();
      if (!clean) continue;
      extraPeople.push(clean.includes("@") ? { email: clean } : { name: clean });
    }
    for (const line of lines) {
      const speaker = (line.speaker || "").trim();
      if (speaker && speaker.toLowerCase() !== "speaker") {
        extraPeople.push({ name: speaker });
      }
    }
    return buildMentionCatalog({
      workspaceDocs,
      extraPeople,
      includeScheduleOption: true,
      includeTasksShortcut: true,
    });
  }, [lines, meeting?.attendees, meeting?.participants, workspaceDocs]);

  const filteredMentions = useMemo(
    () => (mentionMatch ? filterMentionTargets(mentionCatalog, mentionMatch.query, 8) : []),
    [mentionCatalog, mentionMatch],
  );
  const mentionOpen = mentionMatch !== null && filteredMentions.length > 0;

  const filteredSlashCommands = useMemo(
    () => (slashMatch ? filterSlashCommands(slashMatch.query, MEETING_SLASH_IDS) : []),
    [slashMatch],
  );
  const slashOpen = slashMatch !== null && filteredSlashCommands.length > 0 && !mentionOpen;

  const saveSideReply = useCallback(
    async (replyText: string, msgId?: string) => {
      try {
        const { path } = await saveReplyToKnowledge({
          replyText,
          titleHint: meeting?.title_custom || meeting?.title || undefined,
        });
        if (msgId) {
          setSavedId(msgId);
          window.setTimeout(() => setSavedId((cur) => (cur === msgId ? null : cur)), 2000);
        }
        emitWebToast({ message: `Đã lưu vào Knowledge: ${path}`, tone: "success" });
      } catch (err) {
        emitWebToast({
          message: err instanceof Error ? err.message : "Could not save reply.",
          tone: "error",
        });
      }
    },
    [meeting?.title, meeting?.title_custom],
  );

  const sendPrompt = useCallback(
    async (raw: string, opts?: { mentions?: MentionTarget[] }) => {
      const prompt = raw.trim();
      if (!prompt || abortRef.current || meetingsOnly) return;

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const compiled = compileSlashPrompt(prompt, {
        tz,
        meetingTitle: meeting?.title_custom || meeting?.title,
      });
      if (compiled.kind === "instant") {
        if (compiled.commandId === "new") {
          sessionRef.current = `meeting-${meetingId}-${Date.now().toString(36)}`;
          setMessages([]);
          setDraft("");
          setMentionedItems([]);
          setBusy(false);
          setPhase(null);
          emitWebToast({ message: "Đã mở cuộc trò chuyện mới", tone: "info" });
        } else if (compiled.commandId === "schedule") {
          setIncludeSchedule((cur) => {
            const next = !cur;
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
            void saveSideReply(lastAgent.text, lastAgent.id);
          }
        }
        return;
      }
      if (compiled.kind === "error") {
        emitWebToast({ message: compiled.message, tone: "error" });
        return;
      }

      const mentionCtx = compileMentionContext(opts?.mentions ?? []);
      const wirePrompt = [compiled.wirePrompt, mentionCtx.contextBlock].filter(Boolean).join("\n\n");

      onSideTabChange("ask");
      setAskMode("chat");
      const userId = `u-${Date.now()}`;
      const agentId = `a-${Date.now() + 1}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text: compiled.displayPrompt },
        { id: agentId, role: "agent", text: "", ops: [] },
      ]);
      setDraft("");
      setMentionedItems([]);
      setMentionMatch(null);
      setSlashMatch(null);
      setBusy(true);
      setPhase("connecting");

      const controller = new AbortController();
      abortRef.current = controller;

      const activeContext = meeting
        ? {
            kind: "meeting" as const,
            meeting_id: meeting.id,
            platform: meeting.platform === "Google Meet" ? "google_meet" : meeting.platform.toLowerCase(),
            native_id: meeting.native_id || meeting.id,
            status: meeting.live_status,
            title: meeting.title_custom || meeting.title,
            ...(meeting.scheduled_at ? { scheduled_at: meeting.scheduled_at } : {}),
            ...(meeting.workspace_id ? { workspace_id: meeting.workspace_id } : {}),
          }
        : { kind: "meeting" as const, meeting_id: meetingId, native_id: meetingId };
      const tabKind = meeting && meetingPhase(meeting) === "prep" ? "meetingPrep" : "meeting";
      const effectiveIncludeSchedule = includeSchedule || mentionCtx.includeSchedule;

      try {
        await streamChatTurn(
          {
            prompt: wirePrompt,
            session: sessionRef.current,
            active: activeContext,
            research: compiled.research || undefined,
            context: {
              tz,
              surface: { list: "meetings", tab: { kind: tabKind } },
              focus: activeContext,
              ...(effectiveIncludeSchedule ? { include: { schedule: true } } : {}),
            },
          },
          {
            onStarting: () => {
              if (!controller.signal.aborted) setPhase("connecting");
            },
            onStatus: (nextPhase) => {
              if (!controller.signal.aborted) setPhase(nextPhase);
            },
            onDelta: (delta) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, text: m.text + delta } : m)),
              );
            },
            onTool: (op) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId
                    ? { ...m, ops: [...(m.ops ?? []), op] }
                    : m,
                ),
              );
            },
            onCommit: () => undefined,
            onRejected: () => {
              if (!controller.signal.aborted) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentId ? { ...m, error: "Request was rejected by workspace policy." } : m,
                  ),
                );
              }
            },
            onModelFailure: (reply) => {
              if (!controller.signal.aborted) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === agentId ? { ...m, error: reply || "Model inference failed." } : m)),
                );
              }
            },
            onReply: (reply) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, text: reply || m.text } : m)),
              );
            },
            onError: (message) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, error: message } : m)),
              );
            },
          },
          { signal: controller.signal },
        );
      } catch (err) {
        if (!controller.signal.aborted) {
          const msg = presentError(err).headline;
          setMessages((prev) =>
            prev.map((m) => (m.id === agentId ? { ...m, error: msg } : m)),
          );
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
        setPhase(null);
      }
    },
    [includeSchedule, meeting, meetingId, meetingsOnly, onSideTabChange, saveSideReply],
  );

  useEffect(() => {
    if (!pendingPrompt) return;
    const text = pendingPrompt;
    onConsumePendingPrompt();
    void sendPrompt(text);
  }, [pendingPrompt, onConsumePendingPrompt, sendPrompt]);

  const copyReply = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      emitWebToast("Copied response to clipboard");
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1800);
    } catch {
      /* ignore clipboard error */
    }
  };

  const syncComposerTriggers = useCallback((value: string, cursor: number) => {
    const mMatch = detectMentionAtCursor(value, cursor);
    setMentionMatch(mMatch);
    setMentionActiveIdx(0);
    if (mMatch) {
      setSlashMatch(null);
      return;
    }
    const sMatch = detectSlashAtStart(value, cursor);
    setSlashMatch(sMatch);
    setSlashActiveIdx(0);
  }, []);

  const pickMention = useCallback(
    (item: MentionTarget) => {
      const el = draftInputRef.current;
      const anchor = mentionMatch?.anchor ?? draft.length;
      const cursor = el?.selectionStart ?? draft.length;
      const before = draft.slice(0, anchor);
      const after = draft.slice(cursor);
      const inserted = `@${item.label} `;
      const next = `${before}${inserted}${after}`;
      setDraft(next);
      setMentionMatch(null);
      setMentionActiveIdx(0);
      setMentionedItems((prev) => (prev.some((m) => m.id === item.id) ? prev : [...prev, item]));
      if (item.kind === "schedule") setIncludeSchedule(true);
      requestAnimationFrame(() => {
        if (!el) return;
        const pos = before.length + inserted.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [draft, mentionMatch],
  );

  const pickSlashCommand = useCallback(
    (cmd: SlashCommandDef) => {
      setSlashMatch(null);
      setSlashActiveIdx(0);
      if (cmd.instant) {
        setDraft("");
        void sendPrompt(cmd.command);
        return;
      }
      const next = cmd.insertTemplate;
      setDraft(next);
      requestAnimationFrame(() => {
        const el = draftInputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.length, next.length);
      });
    },
    [sendPrompt],
  );

  const triggerMentionMenu = () => {
    const el = draftInputRef.current;
    const pos = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, pos);
    const after = draft.slice(pos);
    const pad = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}@${after}`;
    const nextPos = before.length + pad.length + 1;
    setDraft(next);
    setSlashMatch(null);
    setMentionMatch({ anchor: nextPos - 1, query: "" });
    setMentionActiveIdx(0);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(nextPos, nextPos);
    });
  };

  const triggerSlashMenu = () => {
    const el = draftInputRef.current;
    if (slashOpen) {
      setSlashMatch(null);
      return;
    }
    const next = draft.trim().startsWith("/") ? draft : `/${draft.trimStart()}`;
    setDraft(next);
    setMentionMatch(null);
    setSlashMatch({ anchor: 0, query: next.slice(1).split(/\s/)[0] ?? "" });
    setSlashActiveIdx(0);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = Math.min(next.length, (next.split(/\s/)[0] ?? "/").length);
      el?.setSelectionRange(pos, pos);
    });
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    void sendPrompt(draft, { mentions: mentionedItems });
  };

  const handleDraftKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActiveIdx((cur) => (cur + 1) % filteredMentions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActiveIdx((cur) => (cur - 1 + filteredMentions.length) % filteredMentions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const picked = filteredMentions[Math.min(mentionActiveIdx, filteredMentions.length - 1)];
        if (picked) pickMention(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMatch(null);
        return;
      }
    }
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActiveIdx((cur) => (cur + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActiveIdx((cur) => (cur - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const picked = filteredSlashCommands[Math.min(slashActiveIdx, filteredSlashCommands.length - 1)];
        if (picked) pickSlashCommand(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMatch(null);
        return;
      }
    }
    if (e.key === "Backspace" && mentionedItems.length > 0) {
      const el = e.currentTarget;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (start === end && start > 0) {
        const hit = findMentionBeforeCursor(draft, start, mentionedItems.map((m) => m.label));
        if (hit) {
          e.preventDefault();
          const next = `${draft.slice(0, start - hit.length)}${draft.slice(start)}`;
          const removedLabel = hit.slice(1);
          setDraft(next);
          setMentionedItems((prev) => prev.filter((m) => m.label !== removedLabel));
          requestAnimationFrame(() => el.setSelectionRange(start - hit.length, start - hit.length));
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt(draft, { mentions: mentionedItems });
    }
  };

  const projectedLines = useMemo(() => {
    const groups = language !== "vi" ? (translationSnapshot?.groups ?? []) : [];
    return projectTranslationGroups(lines, groups);
  }, [lines, language, translationSnapshot?.groups]);

  // Interleave transcript turns and Voice Agent TTS ("TINA Agent") replies chronologically
  const timelineItems = useMemo<TimelineItem[]>(() => {
    const needle = transcriptQuery.trim().toLowerCase();
    const tracker = trackerFilter.trim().toLowerCase();
    const items: TimelineItem[] = [];

    if (!tinaOnly) {
      if (showProcessed && language === "vi" && processedNotes.length > 0) {
        processedNotes
          .filter((n) => !n.withdrawn)
          .forEach((n, index) => {
            const speaker = (n.speaker || "Speaker").trim();
            const text = n.text || "";
            if (speakerFilter && speaker !== speakerFilter) return;
            if (questionsOnly && !text.includes("?")) return;
            if (tracker && !text.toLowerCase().includes(tracker)) return;
            if (needle && !`${speaker} ${n.chapter || ""} ${text}`.toLowerCase().includes(needle)) return;
            const noteMs = n.tsMs ?? (typeof n.t === "number" ? n.t * 1000 : undefined);
            items.push({
              kind: "segment",
              key: n.id || `note-${index}`,
              sortMs: normalizeSortMs(noteMs, meetingStartMs, index),
              order: index,
              segmentId: n.id,
              memberIds: n.id ? [n.id] : [],
              speaker: n.speaker || n.chapter || "Notes",
              time: n.t != null ? formatEpochShort(n.t) : "",
              primaryText: text,
              secondaryText: "",
              isDraft: false,
              playable: false,
            });
          });
      } else {
        projectedLines.forEach((seg, index) => {
          const speaker = (seg.speaker || "Speaker").trim();
          const combined = `${speaker} ${seg.text} ${seg.translation?.text || ""}`.toLowerCase();
          if (speakerFilter && speaker !== speakerFilter) return;
          if (questionsOnly && !seg.text.includes("?")) return;
          if (tracker && !combined.includes(tracker)) return;
          if (needle && !combined.includes(needle)) return;
          const isDraft = seg.completed === false;
          const translated = isDraft ? "" : (seg.translation?.text || "");
          const primaryText = language === "en" && translated ? translated : seg.text;
          const secondaryText = language === "bilingual" && translated ? translated : "";
          const memberIds = seg.translation?.memberIds ?? (seg.id ? [seg.id] : []);
          const playableId = memberIds.find((id) => playableSegmentIds.has(id)) ?? seg.id;
          items.push({
            kind: "segment",
            key: seg.id || `seg-${index}`,
            sortMs: normalizeSortMs(seg.tsMs, meetingStartMs, index),
            order: index,
            segmentId: playableId,
            memberIds,
            speaker: seg.speaker || "Speaker",
            time: seg.t || "",
            primaryText,
            secondaryText,
            isDraft,
            playable: !isDraft && !!playableId && playableSegmentIds.has(playableId),
          });
        });
      }
    }

    // Interleave Voice Agent TTS ("TINA Agent") replies by created_at_ms
    const includeReplies = tinaOnly || (!speakerFilter && !questionsOnly);
    if (includeReplies) {
      voiceReplies.forEach((reply, idx) => {
        const partial = reply.state === "stopped" && reply.played_text != null;
        const displayText = partial
          ? reply.played_text || "Chưa có câu nào được phát trọn vẹn."
          : reply.text;
        const haystack = `tina agent tina trả lời ${displayText}`.toLowerCase();
        if (tracker && !haystack.includes(tracker)) return;
        if (needle && !haystack.includes(needle)) return;
        items.push({
          kind: "voice-reply",
          key: `voice-${reply.request_id}`,
          sortMs: Number.isFinite(reply.created_at_ms) ? reply.created_at_ms : Number.MAX_SAFE_INTEGER,
          order: 100_000 + idx,
          reply,
          displayText,
          partial,
        });
      });
    }

    items.sort((a, b) => a.sortMs - b.sortMs || a.order - b.order);
    return items;
  }, [
    language,
    meetingStartMs,
    playableSegmentIds,
    processedNotes,
    projectedLines,
    questionsOnly,
    showProcessed,
    speakerFilter,
    tinaOnly,
    trackerFilter,
    transcriptQuery,
    voiceReplies,
  ]);

  const lastTimelineItem = timelineItems[timelineItems.length - 1];
  const lastTimelineTail =
    lastTimelineItem?.kind === "segment"
      ? `${lastTimelineItem.key}:${lastTimelineItem.primaryText.length}:${lastTimelineItem.isDraft ? "d" : "f"}`
      : lastTimelineItem?.key ?? "";

  useEffect(() => {
    if (!isLive || sideTab !== "transcript" || !followingRef.current) return;
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timelineItems.length, lastTimelineTail, isLive, sideTab]);

  const effectiveTab = meetingsOnly ? "transcript" : sideTab;
  const voiceApiBase = `/api/meetings/${encodeURIComponent(meetingId)}/voice-assistant`;
  const totalBadgeCount = lines.length + voiceReplies.length;
  const latestVoiceReply = voiceReplies[voiceReplies.length - 1];
  const voiceOrbState: VoiceOrbState =
    latestVoiceReply?.state === "started"
      ? "speak"
      : latestVoiceReply?.state === "queued"
        ? "think"
        : isLive
          ? "listen"
          : "idle";
  const toggleHighlightKey = useCallback((key: string) => {
    setHighlightedKeys((cur) => ({ ...cur, [key]: !cur[key] }));
  }, []);

  return (
    <aside
      className={`${styles.sidePanel} ${expanded ? styles.sidePanelExpanded : ""}`}
      data-expanded={expanded ? "true" : "false"}
      aria-label="Ask Tina and Transcript"
    >
      <div className={styles.sideTabs} style={{ padding: "8px 12px", gap: 8, alignItems: "center" }}>
        <LucianSlidingTabs
          ariaLabel="Meeting side panel"
          value={effectiveTab}
          onChange={(next) => onSideTabChange(next)}
          tabs={[
            ...(!meetingsOnly
              ? [
                  {
                    id: "ask" as const,
                    label: "Ask Tina",
                    icon: (
                      <span className={styles.tinaOrb} aria-hidden="true">
                        <WebIcon name="tinaAsk" size={11} />
                      </span>
                    ),
                  },
                ]
              : []),
            {
              id: "transcript" as const,
              label: "Transcript",
              count: totalBadgeCount,
            },
          ]}
        />

        <div className={styles.sideHeaderActions}>
          {!meetingsOnly && effectiveTab === "ask" && (
            <button
              type="button"
              className={`${styles.ghostBtn} ${askMode === "citations" ? styles.ghostBtnActive : ""}`}
              style={{ minHeight: 26, padding: "0 8px", fontSize: 12 }}
              onClick={() => setAskMode((m) => (m === "chat" ? "citations" : "chat"))}
              title="Toggle source-cited Wiki Q&A"
            >
              {askMode === "citations" ? "Chat" : "Wiki citations"}
            </button>
          )}
          {onToggleExpand && (
            <button
              type="button"
              className={`${styles.iconBtn} ${expanded ? styles.iconBtnActive : ""}`}
              aria-label={expanded ? "Collapse Ask Tina and Transcript" : "Expand Ask Tina and Transcript"}
              aria-pressed={expanded}
              title={expanded ? "Restore split view (Esc)" : "Expand Ask Tina & Transcript"}
              onClick={onToggleExpand}
            >
              <WebIcon name={expanded ? "minimize" : "maximize"} size={15} />
            </button>
          )}
        </div>
      </div>

      {effectiveTab === "ask" && !meetingsOnly ? (
        askMode === "citations" ? (
          <div className={styles.sideBody} style={{ padding: "12px 0" }}>
            <MeetingKnowledge key={`side-knowledge-${meetingId}`} meetingId={meetingId} />
          </div>
        ) : (
          <>
            <div className={styles.sideBody}>
              {messages.length === 0 ? (
                <>
                  <div className={styles.askHero}>
                    <span className={styles.askHeroIcon} aria-hidden="true">
                      <WebIcon name="sparkleSmall" size={22} />
                    </span>
                    <h2>Hi {firstName}!</h2>
                    <p>Ask anything about this meeting</p>
                  </div>

                  <div className={styles.starterList}>
                    {STARTERS.map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        className={styles.starterBtn}
                        onClick={() => void sendPrompt(starter)}
                      >
                        {starter}
                      </button>
                    ))}
                  </div>

                  <div className={styles.skillChips}>
                    {QUICK_CHIPS.map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        className={styles.skillChip}
                        onClick={() => void sendPrompt(chip.prompt)}
                      >
                        <WebIcon name="sparkleSmall" size={13} />
                        <span>{chip.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className={styles.chatList}>
                  {messages.map((msg, idx) => {
                    const isStreamingThis = busy && msg.role === "agent" && idx === messages.length - 1;
                    const retryPrevious = () => {
                      if (busy) return;
                      for (let i = idx - 1; i >= 0; i--) {
                        if (messages[i]?.role === "user") {
                          void sendPrompt(messages[i].text);
                          return;
                        }
                      }
                    };

                    if (msg.role === "user") {
                      return (
                        <div key={msg.id} className={`${styles.chatBubble} ${styles.chatBubbleUser}`}>
                          <div>{msg.text}</div>
                        </div>
                      );
                    }

                    return (
                      <div key={msg.id} className={`${styles.chatBubble} ${styles.chatBubbleAgent}`}>
                        <div className={styles.bubbleHead}>
                          <span className={styles.tinaOrb} aria-hidden="true">
                            <WebIcon name="tinaAsk" size={10} />
                          </span>
                          <span>Tina AI</span>
                        </div>

                        <div className={styles.bubbleBody}>
                          {msg.ops && msg.ops.length > 0 && (
                            <AgentActivitySteps
                              ops={msg.ops}
                              streaming={isStreamingThis && !msg.text}
                              compact
                            />
                          )}

                          {msg.error ? (
                            <div role="alert" className={styles.bubbleError}>
                              <WebIcon name="alertTriangle" size={14} />
                              <span className={styles.bubbleErrorText}>{msg.error}</span>
                              {!busy && (
                                <button type="button" className={styles.bubbleRetryBtn} onClick={retryPrevious}>
                                  <WebIcon name="refresh" size={11} />
                                  <span>Retry</span>
                                </button>
                              )}
                            </div>
                          ) : msg.text ? (
                            <div className={styles.bubbleProse}>
                              <Markdown>{msg.text}</Markdown>
                            </div>
                          ) : !(msg.ops && msg.ops.length > 0) ? (
                            <LucianThinkingText
                              compact
                              label={
                                phase === "reconnecting"
                                  ? "Reconnecting…"
                                  : phase === "stalled"
                                    ? "Resuming stream…"
                                    : phase === "connecting"
                                      ? "Reading meeting context…"
                                      : "Thinking…"
                              }
                              lines={[
                                meeting?.title_custom || meeting?.title
                                  ? `Grounded on ${meeting.title_custom || meeting.title}`
                                  : "Reviewing meeting transcript",
                                "Checking decisions, speakers & linked notes",
                              ]}
                            />
                          ) : null}

                          {msg.text && !isStreamingThis && (
                            <div className={styles.bubbleActions}>
                              <button
                                type="button"
                                className={styles.bubbleActBtn}
                                onClick={() => void copyReply(msg.id, msg.text)}
                              >
                                <WebIcon name={copiedId === msg.id ? "check" : "copy"} size={12} />
                                <span>{copiedId === msg.id ? "Copied" : "Copy"}</span>
                              </button>
                              <button
                                type="button"
                                className={styles.bubbleActBtn}
                                aria-label="Save response to Knowledge"
                                title="Save response as a Knowledge page"
                                onClick={() => void saveSideReply(msg.text, msg.id)}
                              >
                                <WebIcon name={savedId === msg.id ? "check" : "fileText"} size={12} />
                                <span>{savedId === msg.id ? "Saved" : "Save"}</span>
                              </button>
                              <button
                                type="button"
                                className={styles.bubbleActBtn}
                                aria-label="Retry response"
                                disabled={busy}
                                onClick={retryPrevious}
                              >
                                <WebIcon name="refresh" size={12} />
                                <span>Retry</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>

            <div className={styles.sideFoot}>
              <form className={styles.composer} onSubmit={handleSubmit}>
                <LucianMentionPopover
                  open={mentionOpen}
                  listboxId={mentionListboxId}
                  query={mentionMatch?.query ?? ""}
                  items={filteredMentions}
                  activeIndex={mentionActiveIdx}
                  onHoverIndex={setMentionActiveIdx}
                  onPick={pickMention}
                />
                <LucianSlashPopover
                  open={slashOpen}
                  listboxId={slashListboxId}
                  items={filteredSlashCommands}
                  activeIndex={slashActiveIdx}
                  onHoverIndex={setSlashActiveIdx}
                  onPick={pickSlashCommand}
                />
                <LucianMentionChips
                  mentions={mentionedItems}
                  onRemove={(id) => {
                    setMentionedItems((prev) => prev.filter((m) => m.id !== id));
                    if (id === "schedule:today") setIncludeSchedule(false);
                  }}
                />
                <textarea
                  ref={draftInputRef}
                  value={draft}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDraft(next);
                    syncComposerTriggers(next, e.target.selectionStart ?? next.length);
                  }}
                  onClick={(e) => syncComposerTriggers(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                  onKeyUp={(e) => {
                    if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
                    syncComposerTriggers(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
                  }}
                  placeholder="Ask about this meeting… (@ mention, / commands)"
                  role="combobox"
                  aria-label="Ask Tina about this meeting"
                  aria-autocomplete="list"
                  aria-expanded={mentionOpen || slashOpen}
                  aria-controls={mentionOpen ? mentionListboxId : slashOpen ? slashListboxId : undefined}
                  disabled={busy}
                  onKeyDown={handleDraftKeyDown}
                />
                <div className={styles.composerBar}>
                  <div className={styles.composerTools}>
                    <LucianMentionTriggerButton
                      onClick={triggerMentionMenu}
                      disabled={busy}
                      expanded={mentionOpen}
                    />
                    <LucianSlashTriggerButton
                      onClick={triggerSlashMenu}
                      disabled={busy}
                      expanded={slashOpen}
                    />
                    {includeSchedule && (
                      <button
                        type="button"
                        className={styles.composerSchedBadge}
                        title="Today's schedule attached (click to remove)"
                        onClick={() => setIncludeSchedule(false)}
                      >
                        <span>Today</span>
                        <span aria-hidden="true">×</span>
                      </button>
                    )}
                  </div>
                  {busy ? (
                    <button
                      type="button"
                      className={styles.stopBtn}
                      aria-label="Stop generating"
                      onClick={() => abortRef.current?.abort()}
                    >
                      <WebIcon name="stop" size={11} />
                      <span>Stop</span>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className={styles.sendBtn}
                      disabled={!draft.trim()}
                      aria-label="Send question"
                    >
                      <WebIcon name="sendUp" size={14} />
                    </button>
                  )}
                </div>
              </form>
            </div>
          </>
        )
      ) : (
        <>
          <div className={styles.transcriptControls}>
            <div className={styles.searchBox}>
              <WebIcon name="search" size={14} />
              <input
                type="search"
                aria-label="Search transcript"
                placeholder="Search transcript or TINA Agent…"
                value={transcriptQuery}
                onChange={(e) => setTranscriptQuery(e.target.value)}
              />
            </div>

            {(isLive || voiceReplies.length > 0) && (
              <div className={styles.voiceOrbStrip}>
                <LucianVoiceOrb
                  state={voiceOrbState}
                  size={34}
                  label={
                    voiceOrbState === "speak"
                      ? "TINA đang đọc câu trả lời…"
                      : voiceOrbState === "think"
                        ? "Đang chuẩn bị phản hồi thoại…"
                        : voiceOrbState === "listen"
                          ? "Đang lắng nghe “Tina ơi”"
                          : `Voice Agent · ${voiceReplies.length} replies`
                  }
                  sublabel={
                    voiceReplies.length > 0
                      ? tinaOnly
                        ? "Showing Voice Agent replies"
                        : "Tap orb to filter voice replies"
                      : "Say “Tina ơi” in the meeting"
                  }
                  onClick={() => {
                    if (voiceReplies.length > 0) setTinaOnly((v) => !v);
                  }}
                />
              </div>
            )}

            <div className={styles.transcriptMetaRow}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {voiceReplies.length > 0 && (
                  <button
                    type="button"
                    className={`${styles.ghostBtn} ${tinaOnly ? styles.ghostBtnActive : ""}`}
                    style={{ minHeight: 26, padding: "0 8px", fontSize: 12 }}
                    aria-pressed={tinaOnly}
                    onClick={() => setTinaOnly((v) => !v)}
                  >
                    <WebIcon name="mic" size={12} />
                    <span>TINA Agent ({voiceReplies.length})</span>
                  </button>
                )}
                {speakerFilter && (
                  <button type="button" className={styles.activeFilterPill} onClick={onClearSpeaker}>
                    <span>{speakerFilter}</span>
                    <WebIcon name="close" size={12} />
                  </button>
                )}
                {questionsOnly && (
                  <button type="button" className={styles.activeFilterPill} onClick={onClearQuestions}>
                    <span>Questions</span>
                    <WebIcon name="close" size={12} />
                  </button>
                )}
                {trackerFilter && (
                  <button type="button" className={styles.activeFilterPill} onClick={onClearTracker}>
                    <span>#{trackerFilter}</span>
                    <WebIcon name="close" size={12} />
                  </button>
                )}
              </div>

              {processedNotes.length > 0 && language === "vi" && !tinaOnly && (
                <button
                  type="button"
                  className={`${styles.ghostBtn} ${showProcessed ? styles.ghostBtnActive : ""}`}
                  style={{ minHeight: 26, padding: "0 8px", fontSize: 12 }}
                  aria-pressed={showProcessed}
                  onClick={() => setShowProcessed((v) => !v)}
                >
                  {showProcessed ? "Processed view" : "Original ASR"}
                </button>
              )}

              {showLatest && isLive && (
                <button
                  type="button"
                  className={styles.ghostBtn}
                  style={{ minHeight: 26, padding: "0 8px", fontSize: 12 }}
                  onClick={() => {
                    followingRef.current = true;
                    setShowLatest(false);
                    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
                  }}
                >
                  Latest ↓
                </button>
              )}
            </div>

            {language !== "vi" && (translationError || translationSnapshot) && (
              <div className={styles.translationNotice}>
                <span role="status">
                  {translationError
                    ? translationError
                    : translationSnapshot
                      ? `VI to EN: ${translationSnapshot.completed}/${translationSnapshot.total}`
                      : "Loading translation…"}
                </span>
                {(translationError || translationSnapshot?.status === "paused") && (
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    style={{ minHeight: 24, padding: "0 8px", fontSize: 11.5 }}
                    onClick={onRetryTranslation}
                  >
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>

          <div
            className={styles.transcriptScroll}
            ref={transcriptRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 48;
              followingRef.current = atBottom;
              setShowLatest(!atBottom);
            }}
          >
            <LucianSelectionTooltip
              containerRef={transcriptRef}
              onAskQuote={
                meetingsOnly
                  ? undefined
                  : (quote) => {
                      void sendPrompt(`Explain and follow up on this quote from the meeting: "${quote}"`);
                    }
              }
              onToggleHighlight={toggleHighlightKey}
            />
            {timelineItems.length === 0 ? (
              <div className={styles.transcriptEmpty}>
                {transcriptQuery || speakerFilter || questionsOnly || trackerFilter || tinaOnly
                  ? "No transcript lines match the current filters."
                  : isLive
                    ? "Waiting for live transcript segments…"
                    : "No transcript is available for this meeting yet."}
              </div>
            ) : (
              timelineItems.map((item) => {
                if (item.kind === "voice-reply") {
                  const { reply, displayText, partial } = item;
                  const stateLabel = VOICE_STATE_LABEL[reply.state] || "Chưa xác nhận";
                  const kindLabel = reply.answer_kind ? VOICE_KIND_LABEL[reply.answer_kind] : "";
                  const safeLinks = (reply.links ?? []).filter((link) => /^https?:\/\//i.test(link.url));
                  const sourcesOpen = openSourceReplyId === reply.request_id;
                  const playbackWarning = partial
                    ? "Chỉ hiển thị các câu đã phát trọn vẹn."
                    : ["stopped", "failed", "unconfirmed"].includes(reply.state)
                      ? "TINA có thể chưa đọc hết nội dung này."
                      : "";

                  return (
                    <article
                      key={item.key}
                      data-quote-key={item.key}
                      aria-label="TINA Agent"
                      className={styles.voiceReplyRow}
                    >
                      <header className={styles.voiceReplyHead}>
                        <span className={styles.voiceReplyName}>
                          <span className={styles.tinaOrb} aria-hidden="true">
                            <WebIcon name="mic" size={11} />
                          </span>
                          <span>TINA Agent</span>
                        </span>
                        <span role="status" className={styles.voiceReplyMeta}>
                          {stateLabel}
                        </span>
                        {kindLabel && <span className={styles.voiceReplyMeta}>{kindLabel}</span>}
                        {Number.isFinite(reply.created_at_ms) && (
                          <time
                            dateTime={new Date(reply.created_at_ms).toISOString()}
                            className={styles.voiceReplyTime}
                          >
                            {formatTimeMs(reply.created_at_ms)}
                          </time>
                        )}
                      </header>

                      <LucianReadAloud
                        text={displayText}
                        textClassName={styles.voiceReplyText}
                        autoPlay={reply.state === "started"}
                        highlighted={Boolean(highlightedKeys[item.key])}
                      />

                      {safeLinks.length > 0 && (
                        <div className={styles.voiceReplyLinks}>
                          {safeLinks.map((link) => (
                            <a
                              key={link.url}
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.voiceReplyLink}
                            >
                              {link.title}
                            </a>
                          ))}
                        </div>
                      )}

                      {(reply.source_count || playbackWarning) && (
                        <div className={styles.voiceReplyFooter}>
                          {!!reply.source_count && (
                            <button
                              type="button"
                              className={styles.voiceSourceBtn}
                              aria-expanded={sourcesOpen}
                              onClick={() =>
                                setOpenSourceReplyId((cur) => (cur === reply.request_id ? null : reply.request_id))
                              }
                            >
                              <span>{sourcesOpen ? "Ẩn nguồn" : `Nguồn (${reply.source_count})`}</span>
                            </button>
                          )}
                          {playbackWarning && <p className={styles.voiceReplyNote}>{playbackWarning}</p>}
                        </div>
                      )}

                      {sourcesOpen && (
                        <VoiceReplySources
                          key={`${meetingId}:${reply.request_id}`}
                          base={voiceApiBase}
                          requestId={reply.request_id}
                        />
                      )}
                    </article>
                  );
                }

                const isActive =
                  !!activeSegmentId &&
                  (item.segmentId === activeSegmentId || item.memberIds.includes(activeSegmentId));
                const displayPrimary =
                  item.isDraft && item.primaryText && !/(?:…|\.\.\.)$/.test(item.primaryText.trimEnd())
                    ? `${item.primaryText.trimEnd()}…`
                    : item.primaryText;
                const isRowHighlighted = Boolean(highlightedKeys[item.key]);
                const rowStartSec =
                  typeof meetingStartMs === "number" && Number.isFinite(meetingStartMs) && item.sortMs >= meetingStartMs
                    ? (item.sortMs - meetingStartMs) / 1000
                    : item.sortMs / 1000;
                const activeAudioProgress =
                  isActive && typeof audioVirtualSec === "number" && Number.isFinite(audioVirtualSec)
                    ? Math.max(0.05, Math.min(1, (audioVirtualSec - rowStartSec) / Math.max(2, displayPrimary.split(/\s+/).length * 0.42)))
                    : undefined;
                return (
                  <div
                    key={item.key}
                    data-quote-key={item.key}
                    data-segment-id={item.segmentId}
                    data-transcript-segments={JSON.stringify(item.memberIds)}
                    data-draft={item.isDraft ? "true" : "false"}
                    tabIndex={-1}
                    className={`${styles.transcriptRow} ${item.isDraft ? styles.transcriptRowDraft : ""} ${item.playable ? styles.transcriptRowClickable : ""} ${isActive ? styles.transcriptRowActive : ""}`}
                    onClick={() => {
                      const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
                      if (sel && !sel.isCollapsed) return;
                      if (item.playable && item.segmentId && onSegmentClick) {
                        onSegmentClick(item.segmentId);
                      }
                    }}
                  >
                    <div className={styles.transcriptRowHead}>
                      <span className={styles.transcriptSpeakerGroup}>
                        <span className={styles.transcriptSpeaker}>{item.speaker}</span>
                        {item.isDraft && (
                          <span className={styles.transcriptDraftBadge} role="status" aria-label="Live draft">
                            <span className={styles.transcriptDraftDot} aria-hidden="true" />
                            <span>Draft</span>
                          </span>
                        )}
                      </span>
                      {item.time && (
                        <button
                          type="button"
                          className={styles.transcriptTime}
                          disabled={!item.playable}
                          aria-label={`Jump to ${item.time}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.playable && item.segmentId && onSegmentClick) {
                              onSegmentClick(item.segmentId);
                            }
                          }}
                        >
                          {item.time}
                        </button>
                      )}
                    </div>
                    {activeAudioProgress !== undefined ? (
                      <LucianReadAloud
                        text={displayPrimary}
                        textClassName={`${styles.transcriptText} ${item.isDraft ? styles.transcriptTextDraft : ""}`}
                        showControls={false}
                        externalProgress={activeAudioProgress}
                        isExternallyPlaying={true}
                        highlighted={isRowHighlighted}
                      />
                    ) : (
                      <p
                        className={`${styles.transcriptText} ${item.isDraft ? styles.transcriptTextDraft : ""} u220-s ${isRowHighlighted ? "is-hl" : ""}`}
                      >
                        {displayPrimary}
                      </p>
                    )}
                    {item.secondaryText ? (
                      <p className={styles.transcriptTranslated}>{item.secondaryText}</p>
                    ) : item.isDraft && language !== "vi" ? (
                      <p className={styles.transcriptDraftHint}>Chờ đoạn nói hoàn tất…</p>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </aside>
  );
}
