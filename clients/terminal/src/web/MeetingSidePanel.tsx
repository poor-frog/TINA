"use client";
/** MeetingSidePanel — Right column of MeetingDetailView with two underline tabs:
 *  1. Ask Tina: real streaming `/api/chat` grounded on this meeting (plus a switch to
 *     real source-cited `<MeetingKnowledge />` Wiki Q&A).
 *  2. Transcript: real durable + live transcript chronologically interleaved with real
 *     Voice Agent TTS ("TINA Agent") replies from `/api/meetings/{id}/voice-assistant`
 *     (matching TINA Chrome Extension), with search, speaker/question/topic/TINA filters,
 *     bilingual VI/EN/Song ngữ translation, source citations, and audio sync. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import { Markdown } from "../ui-kit/Markdown";
import { streamChatTurn, type ChatPhase } from "../surfaces/chatStream";
import { presentError } from "../surfaces/apiClient";
import { MeetingKnowledge } from "../surfaces/MeetingKnowledge";
import { VoiceReplySources } from "../surfaces/VoiceReplySources";
import type { MeetingMock, TranscriptLine } from "../surfaces/meetingModel";
import type { ProcessedNoteDTO } from "../surfaces/liveMeetings";
import type { TranscriptLanguage, TranslationSnapshot } from "../canvas/MeetingTranslation";
import { projectTranslationGroups } from "../canvas/translationGroups";
import styles from "./meetingDetail.module.css";

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
  onSegmentClick,
  pendingPrompt,
  onConsumePendingPrompt,
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
  onSegmentClick?: (segmentId: string) => void;
  pendingPrompt: string | null;
  onConsumePendingPrompt: () => void;
}) {
  const [askMode, setAskMode] = useState<"chat" | "citations">("chat");
  const [messages, setMessages] = useState<SideMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ChatPhase | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [showProcessed, setShowProcessed] = useState(false);
  const [tinaOnly, setTinaOnly] = useState(false);
  const [openSourceReplyId, setOpenSourceReplyId] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);

  const sessionRef = useRef(`meeting-${meetingId}-${Date.now().toString(36)}`);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sessionRef.current = `meeting-${meetingId}-${Date.now().toString(36)}`;
    setMessages([]);
    setDraft("");
    setBusy(false);
    setPhase(null);
    setTranscriptQuery("");
    setShowProcessed(false);
    setTinaOnly(false);
    setOpenSourceReplyId(null);
    setAskMode("chat");
  }, [meetingId]);

  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, phase]);

  const sendPrompt = useCallback(
    async (raw: string) => {
      const prompt = raw.trim();
      if (!prompt || abortRef.current || meetingsOnly) return;

      onSideTabChange("ask");
      setAskMode("chat");
      const userId = `u-${Date.now()}`;
      const agentId = `a-${Date.now() + 1}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text: prompt },
        { id: agentId, role: "agent", text: "", ops: [] },
      ]);
      setDraft("");
      setBusy(true);
      setPhase("connecting");

      const controller = new AbortController();
      abortRef.current = controller;

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const activeContext = meeting
        ? {
            kind: "meeting" as const,
            meeting_id: meeting.id,
            platform: meeting.platform === "Google Meet" ? "google_meet" : meeting.platform.toLowerCase(),
            native_id: meeting.native_id || meeting.id,
            status: meeting.live_status,
            title: meeting.title_custom || meeting.title,
          }
        : { kind: "meeting" as const, meeting_id: meetingId, native_id: meetingId };

      try {
        await streamChatTurn(
          {
            prompt,
            session: sessionRef.current,
            active: activeContext,
            context: {
              tz,
              surface: { list: "meetings", tab: { kind: "meeting" } },
              focus: activeContext,
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
                  m.id === agentId && !m.ops?.includes(op)
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
    [meeting, meetingId, meetingsOnly, onSideTabChange],
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
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1800);
    } catch {
      /* ignore clipboard error */
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendPrompt(draft);
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
          const translated = seg.translation?.text || "";
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
            playable: !!playableId && playableSegmentIds.has(playableId),
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

  useEffect(() => {
    if (!isLive || sideTab !== "transcript" || !followingRef.current) return;
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timelineItems.length, isLive, sideTab]);

  const effectiveTab = meetingsOnly ? "transcript" : sideTab;
  const voiceApiBase = `/api/meetings/${encodeURIComponent(meetingId)}/voice-assistant`;
  const totalBadgeCount = lines.length + voiceReplies.length;

  return (
    <aside className={styles.sidePanel} aria-label="Ask Tina and Transcript">
      <div className={styles.sideTabs} role="tablist" aria-label="Meeting side panel">
        {!meetingsOnly && (
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "ask"}
            className={styles.sideTabBtn}
            onClick={() => onSideTabChange("ask")}
          >
            <span className={styles.tinaOrb} aria-hidden="true">
              <WebIcon name="tinaAsk" size={11} />
            </span>
            <span>Ask Tina</span>
          </button>
        )}

        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === "transcript"}
          className={styles.sideTabBtn}
          onClick={() => onSideTabChange("transcript")}
        >
          <span>Transcript</span>
          {totalBadgeCount > 0 && <span className={styles.tabBadge}>{totalBadgeCount}</span>}
        </button>

        {!meetingsOnly && effectiveTab === "ask" && (
          <div className={styles.sideModeToggle}>
            <button
              type="button"
              className={`${styles.ghostBtn} ${askMode === "citations" ? styles.ghostBtnActive : ""}`}
              style={{ minHeight: 26, padding: "0 8px", fontSize: 12 }}
              onClick={() => setAskMode((m) => (m === "chat" ? "citations" : "chat"))}
              title="Toggle source-cited Wiki Q&A"
            >
              {askMode === "citations" ? "Chat" : "Wiki citations"}
            </button>
          </div>
        )}
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
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`${styles.chatBubble} ${msg.role === "user" ? styles.chatBubbleUser : styles.chatBubbleAgent}`}
                    >
                      {msg.role === "agent" && (
                        <div className={styles.bubbleHead}>
                          <span className={styles.tinaOrb} aria-hidden="true">
                            <WebIcon name="tinaAsk" size={10} />
                          </span>
                          <span>Tina AI</span>
                        </div>
                      )}

                      {msg.role === "user" ? (
                        <div>{msg.text}</div>
                      ) : msg.error ? (
                        <div role="alert" style={{ color: "var(--tw-danger)" }}>
                          {msg.error}
                        </div>
                      ) : msg.text ? (
                        <Markdown>{msg.text}</Markdown>
                      ) : (
                        <div style={{ color: "var(--tw-text-3)" }}>
                          {phase === "reconnecting"
                            ? "Reconnecting…"
                            : phase === "stalled"
                              ? "Resuming stream…"
                              : phase === "connecting"
                                ? "Reading meeting context…"
                                : "Working…"}
                        </div>
                      )}

                      {msg.role === "agent" && msg.text && (
                        <div className={styles.bubbleActions}>
                          <button
                            type="button"
                            className={styles.bubbleActBtn}
                            onClick={() => void copyReply(msg.id, msg.text)}
                          >
                            <WebIcon name={copiedId === msg.id ? "check" : "copy"} size={12} />
                            <span>{copiedId === msg.id ? "Copied" : "Copy"}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>

            <div className={styles.sideFoot}>
              <form className={styles.composer} onSubmit={handleSubmit}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Ask anything about this meeting…"
                  aria-label="Ask Tina about this meeting"
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendPrompt(draft);
                    }
                  }}
                />
                <button
                  type="submit"
                  className={styles.sendBtn}
                  disabled={busy || !draft.trim()}
                  aria-label="Send question"
                >
                  <WebIcon name="sendUp" size={14} />
                </button>
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

                      <p className={styles.voiceReplyText}>{displayText}</p>

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
                return (
                  <div
                    key={item.key}
                    data-segment-id={item.segmentId}
                    data-transcript-segments={JSON.stringify(item.memberIds)}
                    tabIndex={-1}
                    className={`${styles.transcriptRow} ${item.playable ? styles.transcriptRowClickable : ""} ${isActive ? styles.transcriptRowActive : ""}`}
                    onClick={() => {
                      if (item.playable && item.segmentId && onSegmentClick) {
                        onSegmentClick(item.segmentId);
                      }
                    }}
                  >
                    <div className={styles.transcriptRowHead}>
                      <span className={styles.transcriptSpeaker}>{item.speaker}</span>
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
                    <p className={styles.transcriptText}>{item.primaryText}</p>
                    {item.secondaryText && <p className={styles.transcriptTranslated}>{item.secondaryText}</p>}
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
