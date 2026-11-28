"use client";
/** MeetingDetailView — 3-column + bottom-player Meeting Workspace matching the Tina/Fireflies
 *  architecture, 100% wired to TINA's real APIs: durable + live transcripts, Live Assist state,
 *  Meeting Memory facts, Discussion Review signals, bilingual translation, multi-fragment audio
 *  playback, grounded Ask Tina SSE streaming, Share session, inline Rename, BotControls, and tools. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import { WebAvatar } from "./Avatar";
import { Markdown } from "../ui-kit/Markdown";
import { computeSpeakerStats, formatTalkDuration } from "./SpeakerTalkTime";
import { MeetingSmartSearch, type DiscussionSignalSummary } from "./MeetingSmartSearch";
import { MeetingSidePanel, type MeetingVoiceReply } from "./MeetingSidePanel";
import { MeetingPrepWorkspace } from "./MeetingPrepWorkspace";
import { ChatGPTPlanNotice, type ChatGPTPlanIssue } from "../surfaces/ChatGPTPlanNotice";
import { MeetingBottomPlayer, type MeetingBottomPlayerHandle } from "./MeetingBottomPlayer";
import { LucianSelectionTooltip } from "./lucian/LucianSelectionTooltip";
import type { ChapterRailItem } from "./lucian/LucianChapterRail";
import { LiveAssistRunningView } from "../surfaces/LiveAssistRunningView";
import { MeetingMemory } from "../surfaces/MeetingMemory";
import { SpeakerRegistry } from "../surfaces/SpeakerRegistry";
import { TranscriptReview } from "../surfaces/TranscriptReview";
import { PostMeetingDraft } from "./PostMeetingDraft";
import { DiscussionReview } from "../surfaces/DiscussionReview";
import { LiveMeetingState } from "../surfaces/LiveMeetingState";
import {
  EMPTY_LIVE_ASSIST_DRAFT,
  mergeLiveMeetingState,
  postLiveMeetingStateAction,
  readAllLiveMeetingState,
  readLiveMeetingState,
  readPlannedLiveAssistDraft,
  writePlannedLiveAssistDraft,
  type LiveMeetingStateSnapshot,
  type PlannedLiveAssistDraft,
} from "../surfaces/liveMeetingStateApi";
import {
  BotControls,
  MeetingNotFound,
  ShareSessionButton,
  meetingHeaderState,
  meetingResolution,
  meetingWhenLabel,
  presentMeetingActionFailure,
} from "../surfaces/meeting";
import { meetingPhase, type MeetingAudioRecording, type MeetingMock, type TranscriptLine } from "../surfaces/meetingModel";
import {
  fetchDurableTranscript,
  fetchMeetingById,
  refreshMeetings,
  seedLiveMeetingFromResponse,
  type ProcessedNoteDTO,
} from "../surfaces/liveMeetings";
import { useMeetingLive, type LiveSegment } from "../surfaces/meetingLive";
import { DURABLE_REFETCH_ATTEMPTS, DURABLE_REFETCH_DELAY_MS, pinSubscriptionUid } from "../canvas/useMeeting";
import { useMeetingTranslation, type TranscriptLanguage } from "../canvas/MeetingTranslation";
import type { MeetingAudioFragment, MeetingAudioPosition } from "../canvas/MeetingAudioPlayer";
import { streamChatTurn } from "../surfaces/chatStream";
import { presentError, readApiFailure } from "../surfaces/apiClient";
import { canSetMeetingWorkspace, MeetingWorkspaceDialog } from "./MeetingWorkspaceDialog";
import { terminalMeetingPath } from "../app/meetingRoute";
import { meetingDurationMins } from "./meetingsFilter";
import type { WebUser } from "./useWebIdentity";
import type { CaptureModalMode } from "./TopBar";
import styles from "./meetingDetail.module.css";

interface MemoryFactDTO {
  id: string;
  type: "action_item" | "decision" | "fact";
  text: string;
  evidence?: Array<{ segment_id?: string; speaker_name?: string; start_ms?: number; quote?: string }>;
}

interface ActionItemRow {
  id: string;
  text: string;
  done: boolean;
  assignee?: string;
  source: "live-state" | "memory" | "meeting" | "local";
  revision?: number;
  segmentId?: string;
}

interface LocalMeetingPrefs {
  starred: boolean;
  reviewed: boolean;
  localTasks: Array<{ id: string; text: string; done: boolean; assignee: string }>;
  doneIds: string[];
}

const DEFAULT_PREFS: LocalMeetingPrefs = { starred: false, reviewed: false, localTasks: [], doneIds: [] };

const MEETING_SKILLS = [
  {
    id: "exec-recap",
    category: "Summary",
    title: "Executive Brief and Decisions",
    description: "Distill the main goals, decisions agreed upon, and open blockers.",
    prompt: "Write a crisp executive brief for this meeting with sections for Overview, Key Decisions, and Open Risks.",
  },
  {
    id: "action-matrix",
    category: "Execution",
    title: "Action Items and Owners",
    description: "Extract concrete next steps with owners and deadlines mentioned in the call.",
    prompt: "List every concrete action item from this meeting with its owner and deadline if mentioned.",
  },
  {
    id: "followup-email",
    category: "Communication",
    title: "Follow-up Email Draft",
    description: "Generate a ready-to-send recap email for all attendees.",
    prompt: "Draft a clear, concise follow-up email summarizing this meeting's outcomes and next steps.",
  },
  {
    id: "coaching",
    category: "Coaching",
    title: "Coaching and Talk Balance",
    description: "Review speaker participation, pacing, and suggestions for the next sync.",
    prompt: "Evaluate the conversation balance, clarity, and decision velocity in this meeting, and give 3 practical coaching tips.",
  },
] as const;

function readMeetingPrefs(id: string): LocalMeetingPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`tina.web.meetingPrefs.${id}`) || "null");
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFS;
    return {
      starred: parsed.starred === true,
      reviewed: parsed.reviewed === true,
      localTasks: Array.isArray(parsed.localTasks) ? parsed.localTasks : [],
      doneIds: Array.isArray(parsed.doneIds) ? parsed.doneIds : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeMeetingPrefs(id: string, next: LocalMeetingPrefs) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`tina.web.meetingPrefs.${id}`, JSON.stringify(next));
  } catch {
    /* ignore storage error */
  }
}

function formatChapterClock(tsMs?: number, firstMs?: number): string {
  if (typeof tsMs !== "number" || !Number.isFinite(tsMs)) return "00:00";
  const relSec =
    typeof firstMs === "number" && Number.isFinite(firstMs) && tsMs >= firstMs && tsMs > 100_000_000_000
      ? Math.max(0, Math.floor((tsMs - firstMs) / 1000))
      : tsMs < 100_000_000_000
        ? Math.max(0, Math.floor(tsMs / 1000))
        : 0;
  const mins = Math.floor(relSec / 60);
  const secs = relSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatWallClock(tsMs?: number, rawSeconds?: number | string): string {
  if (typeof rawSeconds === "string" && rawSeconds.trim()) return rawSeconds;
  const epoch =
    typeof tsMs === "number" && Number.isFinite(tsMs) && tsMs > 100_000_000_000
      ? tsMs
      : typeof rawSeconds === "number" && Number.isFinite(rawSeconds) && rawSeconds > 1_000_000_000
        ? rawSeconds * 1000
        : undefined;
  if (epoch != null) {
    const dt = new Date(epoch);
    if (Number.isFinite(dt.getTime())) {
      return dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    }
  }
  if (typeof rawSeconds === "number" && Number.isFinite(rawSeconds)) {
    return formatChapterClock(rawSeconds * 1000);
  }
  return "";
}

/** Merge durable REST lines with live SSE segments by segment_id without dropping older durable
 *  history (beyond SSE replay cap), without losing the last 0–12s on stop, and without letting
 *  a stale 12s poll resurrect a retracted or finalized live draft. Exported for unit tests. */
export function mergeMeetingTranscriptLines(
  durableLines: TranscriptLine[],
  liveSegments: LiveSegment[],
  opts: {
    isLive: boolean;
    liveConnected: boolean;
    liveEnded: boolean;
    retractedIds?: readonly string[];
    fallbackLines?: TranscriptLine[];
  },
): TranscriptLine[] {
  const { isLive, liveConnected, liveEnded, retractedIds, fallbackLines = [] } = opts;
  if (!isLive && liveSegments.length === 0) {
    return durableLines.length > 0 ? durableLines : fallbackLines;
  }

  const retracted = new Set(retractedIds ?? []);
  const sseActive = isLive && (liveConnected || liveSegments.length > 0);
  const byId = new Map<string, TranscriptLine>();
  const orderedIds: string[] = [];
  const unkeyed: TranscriptLine[] = [];

  for (const line of durableLines) {
    if (line.id && retracted.has(line.id)) continue;
    // While live SSE is active, SSE owns the mutable draft tail — skip polled unconfirmed drafts
    // from the 12s REST snapshot so retracted/superseded drafts cannot briefly reappear.
    if (sseActive && line.completed === false) continue;
    if (line.id) {
      if (!byId.has(line.id)) orderedIds.push(line.id);
      byId.set(line.id, line);
    } else {
      unkeyed.push(line);
    }
  }

  for (const seg of liveSegments) {
    const liveCompleted = seg.completed !== false;
    // Once a meeting is post-phase and the stream ended, drop unconfirmed live drafts when durable
    // transcript already exists so a dangling draft never outlives finalized durable rows.
    if (!isLive && liveEnded && !liveCompleted && durableLines.length > 0) continue;
    const mapped: TranscriptLine = {
      id: seg.id,
      t: formatWallClock(seg.tsMs, seg.t),
      speaker: seg.speaker?.trim() || (seg.speakerStatus === "unknown" ? "Unknown speaker" : "Speaker"),
      text: seg.text || "",
      tsMs: seg.tsMs,
      speakerId: seg.speakerId,
      speakerKey: seg.speakerKey,
      speakerStatus: seg.speakerStatus,
      speakerRevision: seg.speakerRevision,
      completed: liveCompleted,
    };

    if (!mapped.id) {
      unkeyed.push(mapped);
      continue;
    }

    const existing = byId.get(mapped.id);
    if (!existing) {
      orderedIds.push(mapped.id);
      byId.set(mapped.id, mapped);
      continue;
    }

    const keepCanonicalText = (existing.revision ?? 0) > 0;
    const keepCanonicalSpeaker = (existing.speakerRevision ?? 0) > (mapped.speakerRevision ?? 0);
    const completed = keepCanonicalText || existing.completed !== false ? true : mapped.completed;
    byId.set(mapped.id, {
      ...existing,
      ...mapped,
      t: mapped.t || existing.t,
      tsMs: mapped.tsMs ?? existing.tsMs,
      endTsMs: existing.endTsMs,
      sessionUid: existing.sessionUid,
      revision: existing.revision,
      text: keepCanonicalText ? existing.text : mapped.text,
      speaker: keepCanonicalSpeaker ? existing.speaker : mapped.speaker,
      speakerId: keepCanonicalSpeaker ? existing.speakerId : (mapped.speakerId ?? existing.speakerId),
      speakerKey: mapped.speakerKey ?? existing.speakerKey,
      speakerStatus: keepCanonicalSpeaker ? existing.speakerStatus : (mapped.speakerStatus ?? existing.speakerStatus),
      speakerRevision: keepCanonicalSpeaker ? existing.speakerRevision : (mapped.speakerRevision ?? existing.speakerRevision),
      completed,
    });
  }

  const merged = [...orderedIds.map((id) => byId.get(id)!), ...unkeyed].filter(
    (line) => (line.text ?? "").trim() || (line.revision ?? 0) > 0,
  );
  if (merged.length > 0) return merged;
  return fallbackLines;
}

export function MeetingDetailView({
  meetingId,
  meetings,
  listLoaded,
  wsConnected,
  meetingsOnly,
  canOpenTerminal,
  user,
  autoStartBrief = false,
  onConsumeAutoStartBrief,
  onOpenKnowledgeDoc,
  onBack,
  onOpenMeeting,
  onOpenMobileNav,
  onOpenCapture,
  onUserMenuToggle,
}: {
  meetingId: string;
  meetings: MeetingMock[];
  listLoaded: boolean;
  wsConnected: boolean;
  meetingsOnly: boolean;
  canOpenTerminal: boolean;
  user?: WebUser;
  autoStartBrief?: boolean;
  onConsumeAutoStartBrief?: () => void;
  onOpenKnowledgeDoc?: (docPath: string, wsSlug?: string) => void;
  onBack: () => void;
  onOpenMeeting?: (meetingId: string) => void;
  onOpenMobileNav?: () => void;
  onOpenCapture?: (mode?: CaptureModalMode) => void;
  onUserMenuToggle?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const [detail, setDetail] = useState<{ id: string; row: MeetingMock | null; error?: string }>();
  const [detailAttempt, setDetailAttempt] = useState(0);
  const byId = /^[1-9]\d*$/.test(meetingId);
  const listed = meetings.find((row) => row.id === meetingId || (!byId && row.native_id === meetingId));
  const needsDetail = byId && !listed;
  const fetched = detail?.id === meetingId ? detail : undefined;
  const m = listed ?? fetched?.row ?? undefined;
  const resolvedId = m?.id ?? meetingId;
  const phase = m ? meetingPhase(m) : "live";
  const isLive = phase === "live";

  // ── Layout & tab state ──
  const [docTab, setDocTab] = useState<"notes" | "skills" | "tasks" | "live-assist">("notes");
  const [sideTab, setSideTab] = useState<"ask" | "transcript">(isLive ? "transcript" : "ask");
  const [smartSearchOpen, setSmartSearchOpen] = useState(false);
  const [fullscreenDoc, setFullscreenDoc] = useState(false);
  const [fullscreenSide, setFullscreenSide] = useState(false);
  const smartSearchId = useId();
  const smartSearchVisible = smartSearchOpen && !fullscreenDoc && !fullscreenSide;
  const toggleSmartSearch = () => {
    setFullscreenDoc(false);
    setFullscreenSide(false);
    setSmartSearchOpen(!smartSearchVisible);
  };
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);

  // ── Filters synced between Smart Search & Transcript ──
  const [speakerFilter, setSpeakerFilter] = useState("");
  const [questionsOnly, setQuestionsOnly] = useState(false);
  const [trackerFilter, setTrackerFilter] = useState("");
  const [language, setLanguage] = useState<TranscriptLanguage>("bilingual");
  const [pendingAskPrompt, setPendingAskPrompt] = useState<string | null>(null);

  // ── Rename / Delete / Copy / Process states ──
  const [renameOpen, setRenameOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const [processingBusy, setProcessingBusy] = useState(false);
  const [newTaskDraft, setNewTaskDraft] = useState("");
  const [taskFilter, setTaskFilter] = useState<"all" | "pending" | "done">("all");
  const [prefs, setPrefs] = useState<LocalMeetingPrefs>(DEFAULT_PREFS);

  // ── AI Skills execution state ──
  const [skillOutputs, setSkillOutputs] = useState<Record<string, { text: string; loading: boolean; error?: string }>>({});
  const [copiedSkillId, setCopiedSkillId] = useState<string | null>(null);

  // ── Real data feeds: durable transcript + live WS stream + memory + discussion review + recordings ──
  const [durableLines, setDurableLines] = useState<TranscriptLine[]>([]);
  const [durableNotes, setDurableNotes] = useState<ProcessedNoteDTO[]>([]);
  const [recordings, setRecordings] = useState<MeetingAudioRecording[]>([]);
  const [refreshingTranscript, setRefreshingTranscript] = useState(false);
  const [memoryFacts, setMemoryFacts] = useState<MemoryFactDTO[]>([]);
  const [discussionSignals, setDiscussionSignals] = useState<DiscussionSignalSummary | null>(null);
  const [voiceReplies, setVoiceReplies] = useState<MeetingVoiceReply[]>([]);
  const [chatgptPlanIssue, setChatgptPlanIssue] = useState<ChatGPTPlanIssue | null>(null);

  // Pin the live SSE subscription across the live -> post stop transition (matching useMeeting.ts)
  // so final segments keep rendering while the durable DB catches up after bot exit.
  const pinRef = useRef({ id: "", uid: "" });
  pinRef.current = pinSubscriptionUid(pinRef.current, resolvedId, m?.session_uid);
  const liveStream = useMeetingLive(resolvedId, pinRef.current.uid);
  const confirmedLiveCountRef = useRef(0);
  confirmedLiveCountRef.current = liveStream.transcript.filter((s) => s.completed !== false).length;

  // ── Audio fragments + playback sync ──
  const [audioFragments, setAudioFragments] = useState<MeetingAudioFragment[]>([]);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioMessage, setAudioMessage] = useState("");
  const [playbackPosition, setPlaybackPosition] = useState<MeetingAudioPosition | null>(null);
  const [playbackActive, setPlaybackActive] = useState(false);
  const playerRef = useRef<MeetingBottomPlayerHandle>(null);

  // ── Mounted TINA power tool dialog refs ──
  const memoryOpenRef = useRef<(() => void) | null>(null);
  const speakersOpenRef = useRef<(() => void) | null>(null);
  const reviewOpenRef = useRef<(() => void) | null>(null);
  const discussionOpenRef = useRef<(() => void) | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const notesScrollRef = useRef<HTMLDivElement>(null);

  // Reset per-meeting UI state when switching meetings
  useEffect(() => {
    setPrefs(readMeetingPrefs(meetingId));
    setDocTab("notes");
    setSpeakerFilter("");
    setQuestionsOnly(false);
    setTrackerFilter("");
    setSkillOutputs({});
    setMemoryFacts([]);
    setDiscussionSignals(null);
    setVoiceReplies([]);
    setChatgptPlanIssue(null);
    setMoreMenuOpen(false);
    setToolsMenuOpen(false);
    setFullscreenDoc(false);
    setFullscreenSide(false);
    setRenameOpen(false);
    setWorkspaceOpen(false);
    setPlaybackActive(false);
    setPlaybackPosition(null);
  }, [meetingId]);

  // Honor ?askTina=1 query param
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("askTina") === "1") {
      setSideTab("ask");
      url.searchParams.delete("askTina");
      try {
        window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      } catch {
        /* ignore sandboxed history */
      }
    }
  }, [meetingId]);

  // Close popovers on outside click / Escape
  useEffect(() => {
    if (!moreMenuOpen && !toolsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreMenuOpen(false);
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMoreMenuOpen(false);
        setToolsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreMenuOpen, toolsMenuOpen]);

  // Allow Escape to exit expanded focus mode when not inside a modal, popover, or text input.
  useEffect(() => {
    if (!fullscreenSide && !fullscreenDoc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || renameOpen || moreMenuOpen || toolsMenuOpen) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      setFullscreenSide(false);
      setFullscreenDoc(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreenSide, fullscreenDoc, renameOpen, moreMenuOpen, toolsMenuOpen]);

  // Fetch single meeting detail if not yet in live meetings list
  useEffect(() => {
    if (!needsDetail) return;
    const controller = new AbortController();
    void fetchMeetingById(meetingId, controller.signal).then(
      (row) => {
        if (!controller.signal.aborted) setDetail({ id: meetingId, row });
      },
      (error) => {
        if (!controller.signal.aborted) {
          setDetail({ id: meetingId, row: null, error: presentMeetingActionFailure(error) });
        }
      },
    );
    return () => controller.abort();
  }, [needsDetail, meetingId, detailAttempt]);

  // Fetch real durable transcript + processed notes + recording descriptors
  const loadDurable = useCallback(async () => {
    if (!resolvedId) return null;
    setRefreshingTranscript(true);
    try {
      const durable = await fetchDurableTranscript(resolvedId);
      setDurableLines(durable.lines);
      setDurableNotes(durable.notes);
      setRecordings(durable.recordings ?? []);
      return durable;
    } finally {
      setRefreshingTranscript(false);
    }
  }, [resolvedId]);

  useEffect(() => {
    void loadDurable();
    const onCorrected = (event: Event) => {
      const target = (event as CustomEvent).detail?.meetingId;
      if (target == null || String(target) === resolvedId) void loadDurable();
    };
    window.addEventListener("tina:transcript-corrected", onCorrected);
    return () => window.removeEventListener("tina:transcript-corrected", onCorrected);
  }, [loadDurable, resolvedId]);

  useEffect(() => {
    if (!isLive) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadDurable();
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [isLive, loadDurable]);

  // Stop catch-up: when a live meeting ends (phase flips to post or SSE emits meeting-end),
  // immediately refresh durable transcript and retry boundedly until DB catches up to live rows.
  const sawLiveRef = useRef(false);
  useEffect(() => {
    sawLiveRef.current = false;
  }, [resolvedId]);
  useEffect(() => {
    if (isLive) {
      sawLiveRef.current = true;
      return;
    }
    if (!sawLiveRef.current && !liveStream.ended) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const catchUp = (attempt: number) => {
      void loadDurable().then((next) => {
        if (cancelled) return;
        const durableConfirmed = (next?.lines ?? []).filter((l) => l.completed !== false).length;
        if (durableConfirmed < confirmedLiveCountRef.current && attempt < DURABLE_REFETCH_ATTEMPTS) {
          timer = setTimeout(() => {
            if (!cancelled) catchUp(attempt + 1);
          }, DURABLE_REFETCH_DELAY_MS);
        }
      });
    };
    catchUp(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isLive, liveStream.ended, loadDurable]);

  // Fetch real Meeting Memory facts & Discussion Review summary when available (best-effort)
  useEffect(() => {
    if (!resolvedId || !/^[1-9]\d*$/.test(resolvedId)) return;
    const controller = new AbortController();
    void fetch(`/api/transcripts/by-id/${encodeURIComponent(resolvedId)}/memory`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { facts?: MemoryFactDTO[] } | null) => {
        if (!controller.signal.aborted && Array.isArray(data?.facts)) {
          setMemoryFacts(data.facts);
        }
      })
      .catch(() => undefined);

    if (phase === "post") {
      void fetch(`/api/discussion-reviews/${encodeURIComponent(resolvedId)}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (
            data: {
              report?: {
                windows?: Array<{ relevance?: { label?: string }; progress?: { label?: string } }>;
              } | null;
            } | null,
          ) => {
            if (controller.signal.aborted) return;
            const windows = data?.report?.windows;
            if (!Array.isArray(windows) || windows.length === 0) return;
            const onTopic = windows.filter((w) => w.relevance?.label === "relevant").length;
            const advancing = windows.filter((w) => w.progress?.label === "advancing").length;
            setDiscussionSignals({
              onTopicPct: Math.round((onTopic / windows.length) * 100),
              advancingPct: Math.round((advancing / windows.length) * 100),
              totalWindows: windows.length,
            });
          },
        )
        .catch(() => undefined);
    }

    return () => controller.abort();
  }, [resolvedId, phase]);

  // Fetch Voice Agent TTS ("TINA Agent") replies from `/api/meetings/{id}/voice-assistant`.
  // Strictly single-flight + single-timer: focus/transcript events cancel any pending timer and
  // coalesce while a request is in flight, and polling pauses while the tab is hidden so live
  // meetings never fork multiple 3s loops or trip edge/gateway rate limits.
  useEffect(() => {
    if (!resolvedId || !/^[1-9]\d*$/.test(resolvedId)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let rerunRequested = false;
    const url = `/api/meetings/${encodeURIComponent(resolvedId)}/voice-assistant`;

    const clearPending = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const scheduleNext = (delayMs = 3000) => {
      clearPending();
      if (!controller.signal.aborted && isLive && !document.hidden) {
        timer = setTimeout(() => {
          timer = undefined;
          void fetchVoice();
        }, delayMs);
      }
    };

    const fetchVoice = async () => {
      if (controller.signal.aborted) return;
      clearPending();
      if (inFlight) {
        rerunRequested = true;
        return;
      }
      inFlight = true;
      rerunRequested = false;
      try {
        const res = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { replies?: MeetingVoiceReply[]; chatgpt_plan_issue?: ChatGPTPlanIssue | null };
        if (!controller.signal.aborted && Array.isArray(body.replies)) {
          const sorted = [...body.replies].sort((a, b) => (a.created_at_ms || 0) - (b.created_at_ms || 0));
          setVoiceReplies(sorted);
          setChatgptPlanIssue(body.chatgpt_plan_issue ?? null);
        }
      } catch {
        /* voice assistant unavailable or aborted */
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          if (rerunRequested && !document.hidden) {
            rerunRequested = false;
            clearPending();
            timer = setTimeout(() => {
              timer = undefined;
              void fetchVoice();
            }, 1000);
          } else {
            scheduleNext(3000);
          }
        }
      }
    };

    if (!document.hidden) {
      void fetchVoice();
    }

    const onWake = () => {
      if (document.hidden) {
        clearPending();
        return;
      }
      if (!inFlight) void fetchVoice();
      else rerunRequested = true;
    };

    const onCorrected = (event: Event) => {
      if (document.hidden) return;
      const detail = (event as CustomEvent)?.detail as { meetingId?: string | number; meeting_id?: string | number } | undefined;
      const target = detail?.meetingId ?? detail?.meeting_id;
      if (target != null && String(target) !== resolvedId) return;
      // Live meetings already poll on a single 3s cadence — don't fire per-revision bursts.
      if (!isLive) {
        if (!inFlight) void fetchVoice();
        else rerunRequested = true;
      }
    };

    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("tina:transcript-corrected", onCorrected);
    return () => {
      controller.abort();
      clearPending();
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("tina:transcript-corrected", onCorrected);
    };
  }, [resolvedId, isLive]);

  // ── Real-time Live Assist / Final Meeting State ──
  const liveAssistMeetingId = m && (phase === "live" || phase === "post") ? String(m.id) : "";
  const [liveAssistState, setLiveAssistState] = useState<LiveMeetingStateSnapshot | null>(null);
  const liveAssistEnabled = !!(m && phase === "live" && liveAssistState?.enabled);
  const liveAssistStateRef = useRef<LiveMeetingStateSnapshot | null>(null);
  const [liveAssistError, setLiveAssistError] = useState("");
  const [liveAssistBusy, setLiveAssistBusyState] = useState(false);
  const liveAssistBusyRef = useRef(false);
  const liveAssistRequestSerial = useRef(0);
  const [liveAssistSyncedAt, setLiveAssistSyncedAt] = useState<number | null>(null);
  const [liveAssistDraft, setLiveAssistDraft] = useState<PlannedLiveAssistDraft>({
    ...EMPTY_LIVE_ASSIST_DRAFT,
    agendaItems: [],
    agendaEdits: [],
  });

  const publishLiveAssistState = useCallback(
    (next: LiveMeetingStateSnapshot, mergeHistory = true, refreshed = true) => {
      const published = mergeHistory ? mergeLiveMeetingState(liveAssistStateRef.current, next) : next;
      liveAssistStateRef.current = published;
      setLiveAssistState(published);
      if (refreshed) setLiveAssistSyncedAt(Date.now());
    },
    [],
  );

  useEffect(() => {
    liveAssistStateRef.current = null;
    setLiveAssistState(null);
    setLiveAssistError("");
    setLiveAssistSyncedAt(null);
    if (!liveAssistMeetingId) {
      setLiveAssistDraft({ ...EMPTY_LIVE_ASSIST_DRAFT, agendaItems: [], agendaEdits: [] });
      return;
    }
    setLiveAssistDraft(readPlannedLiveAssistDraft(liveAssistMeetingId));
    const controller = new AbortController();
    const refresh = async () => {
      if (liveAssistBusyRef.current) return;
      const ticket = ++liveAssistRequestSerial.current;
      try {
        const previous = liveAssistStateRef.current;
        let next = previous
          ? await readLiveMeetingState(liveAssistMeetingId, controller.signal)
          : await readAllLiveMeetingState(liveAssistMeetingId, controller.signal);
        let reloadHistory = !previous;
        if (
          previous &&
          next.configured &&
          (!previous.configured ||
            previous.archive_count !== next.archive_count ||
            (!previous.source_notice && !!next.source_notice))
        ) {
          next = await readAllLiveMeetingState(liveAssistMeetingId, controller.signal);
          reloadHistory = true;
        }
        if (!controller.signal.aborted && ticket === liveAssistRequestSerial.current) {
          publishLiveAssistState(next, !reloadHistory);
          setLiveAssistError("");
        }
      } catch (reason) {
        if (!controller.signal.aborted && ticket === liveAssistRequestSerial.current && phase === "live") {
          setLiveAssistError(reason instanceof Error ? reason.message : "Could not load Live Assist state");
        }
      }
    };
    void refresh();
    const timer = phase === "live" ? window.setInterval(() => void refresh(), 5000) : null;
    return () => {
      controller.abort();
      if (timer != null) window.clearInterval(timer);
      liveAssistRequestSerial.current++;
    };
  }, [liveAssistMeetingId, phase, publishLiveAssistState]);

  const setLiveAssistBusy = (value: boolean) => {
    liveAssistBusyRef.current = value;
    setLiveAssistBusyState(value);
  };

  const syncLiveAssistDraft = async (id: string, initial: LiveMeetingStateSnapshot) => {
    let current = initial;
    let pending = readPlannedLiveAssistDraft(id);
    setLiveAssistDraft(pending);
    const commit = async (action: string, payload: unknown) => {
      liveAssistRequestSerial.current++;
      current = await postLiveMeetingStateAction(id, action, payload);
      publishLiveAssistState(current, true, false);
    };
    if (pending.goal !== null) {
      const goal = pending.goal;
      await commit("edit", { id: "goal", expected_revision: current.goal?.revision || 0, patch: { text: goal } });
      pending = { ...pending, goal: null };
      writePlannedLiveAssistDraft(id, pending);
      setLiveAssistDraft(pending);
    }
    for (const item of [...pending.agendaItems]) {
      await commit("add", { type: "agenda", text: item.text, details: {} });
      pending = { ...pending, agendaItems: pending.agendaItems.filter((candidate) => candidate.id !== item.id) };
      writePlannedLiveAssistDraft(id, pending);
      setLiveAssistDraft(pending);
    }
    for (const item of [...pending.agendaEdits]) {
      const revision = current.items?.find((candidate) => candidate.id === item.id)?.revision ?? item.revision;
      await commit("edit", { id: item.id, expected_revision: revision, patch: { text: item.text } });
      pending = { ...pending, agendaEdits: pending.agendaEdits.filter((candidate) => candidate.id !== item.id) };
      writePlannedLiveAssistDraft(id, pending);
      setLiveAssistDraft(pending);
    }
  };

  const enableLiveAssist = async () => {
    const id = liveAssistMeetingId;
    const current = liveAssistStateRef.current;
    if (!id || !current?.can_configure || current.enabled || liveAssistBusyRef.current) return;
    setLiveAssistBusy(true);
    setLiveAssistError("");
    try {
      liveAssistRequestSerial.current++;
      const enabled = await postLiveMeetingStateAction(id, "configure", {
        enabled: true,
        ...(!current.configured ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
      });
      publishLiveAssistState(enabled, true, false);
      setDocTab("live-assist");
      await syncLiveAssistDraft(id, enabled);
    } catch (reason) {
      setLiveAssistError(reason instanceof Error ? reason.message : "Could not enable Live Assist");
    } finally {
      setLiveAssistBusy(false);
    }
  };

  const retryLiveAssistDraft = async () => {
    const id = liveAssistMeetingId;
    const current = liveAssistStateRef.current;
    if (!id || !current?.configured || liveAssistBusyRef.current) return;
    setLiveAssistBusy(true);
    setLiveAssistError("");
    try {
      await syncLiveAssistDraft(id, current);
    } catch (reason) {
      setLiveAssistError(reason instanceof Error ? reason.message : "Could not sync planned Live Assist edits");
    } finally {
      setLiveAssistBusy(false);
    }
  };

  const liveAssistAction = async (action: string, payload: unknown) => {
    const id = liveAssistMeetingId;
    if (!id || liveAssistBusyRef.current) return false;
    setLiveAssistBusy(true);
    setLiveAssistError("");
    try {
      liveAssistRequestSerial.current++;
      publishLiveAssistState(await postLiveMeetingStateAction(id, action, payload), true, false);
      const request =
        payload && typeof payload === "object"
          ? (payload as { id?: string; type?: string; text?: string; patch?: { text?: string; status?: string } })
          : {};
      if (action === "edit" && request.id && request.patch?.status === "withdrawn" && liveAssistStateRef.current) {
        const next = {
          ...liveAssistStateRef.current,
          items: (liveAssistStateRef.current.items || []).filter((item) => item.id !== request.id),
        };
        liveAssistStateRef.current = next;
        setLiveAssistState(next);
      }
      return true;
    } catch (reason) {
      setLiveAssistError(reason instanceof Error ? reason.message : "Could not save Live Assist state");
      return false;
    } finally {
      setLiveAssistBusy(false);
    }
  };

  // Merge durable transcript lines with live SSE segments by segment_id (preserving draft -> final)
  const allLines: TranscriptLine[] = useMemo(
    () =>
      mergeMeetingTranscriptLines(durableLines, liveStream.transcript, {
        isLive,
        liveConnected: liveStream.connected,
        liveEnded: liveStream.ended,
        retractedIds: liveStream.retractedIds,
        fallbackLines: m?.transcript ?? [],
      }),
    [durableLines, isLive, liveStream.connected, liveStream.ended, liveStream.retractedIds, liveStream.transcript, m?.transcript],
  );

  // Bilingual translation hook (only prioritize finalized segments; skip planned/prep meetings)
  const translation = useMeetingTranslation(
    phase === "prep" ? "" : resolvedId,
    language,
    allLines.filter((seg) => !!seg.id && seg.completed !== false).map((seg) => seg.id!),
  );

  // Resolve real multi-fragment audio URLs for completed meetings
  const canPlayMeetingAudio = phase === "post";
  const recordingsSignature = useMemo(
    () =>
      recordings
        .filter((r) => ["completed", "in_progress"].includes(r.status) && !!r.playback_url?.audio)
        .map((r) => `${r.id}:${r.status}:${r.audio_start_ms ?? ""}:${r.created_at ?? ""}`)
        .sort()
        .join("|"),
    [recordings],
  );
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;

  useEffect(() => {
    if (!canPlayMeetingAudio) {
      setAudioFragments([]);
      setAudioMessage("");
      setAudioLoading(false);
      return;
    }
    const candidates = recordingsRef.current
      .filter((rec) => ["completed", "in_progress"].includes(rec.status) && !!rec.playback_url?.audio)
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    let cancelled = false;
    setAudioFragments([]);
    setAudioMessage("");
    setAudioLoading(candidates.length > 0);
    if (!candidates.length) {
      setAudioMessage("No audio recording");
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(
      candidates.map(async (recording) => {
        const response = await fetch(`/api/recordings/${recording.id}/master?type=audio`, { cache: "no-store" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Recording request failed (${response.status})`);
        const master = (await response.json()) as {
          raw_url?: string;
          url?: string;
          download_url?: string;
          duration_seconds?: number | null;
        };
        const mediaUrl = master.raw_url || master.url || master.download_url || "";
        let src = "";
        if (mediaUrl.startsWith("/recordings/")) {
          if (!mediaUrl.startsWith(`/recordings/${recording.id}/media/`)) {
            throw new Error("Invalid recording path");
          }
          src = `/api${mediaUrl}`;
        } else if (/^https?:\/\//.test(mediaUrl)) {
          src = mediaUrl;
        }
        if (!src) return null;
        const fileDuration = recording.media_files?.find((f) => f.type === "audio")?.duration_seconds;
        return {
          src,
          duration: master.duration_seconds ?? fileDuration ?? 0,
          ...(recording.session_uid ? { sessionUid: recording.session_uid } : {}),
          ...(recording.audio_start_ms != null ? { audioStartMs: recording.audio_start_ms } : {}),
          ...(recording.created_at ? { createdAt: recording.created_at } : {}),
        } satisfies MeetingAudioFragment;
      }),
    )
      .then((results) => {
        if (cancelled) return;
        const resolved = results.filter((f): f is MeetingAudioFragment => f !== null);
        setAudioFragments(resolved);
        if (!resolved.length) setAudioMessage("Recording finalizing…");
      })
      .catch((err: unknown) => {
        if (!cancelled) setAudioMessage(err instanceof Error ? err.message : "Could not load recording");
      })
      .finally(() => {
        if (!cancelled) setAudioLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [recordingsSignature, canPlayMeetingAudio, resolvedId]);

  // Compute segment <-> audio seek mapping
  const segmentAudioSeeks = useMemo(() => {
    const seeks = new Map<string, { fragmentIndex: number; secondsInFragment: number }>();
    if (!canPlayMeetingAudio || !audioFragments.length) return seeks;
    for (const seg of allLines) {
      if (!seg.id || typeof seg.tsMs !== "number" || !Number.isFinite(seg.tsMs)) continue;
      const candidates = audioFragments.flatMap((fragment, fragmentIndex) => {
        const origin = fragment.audioStartMs;
        if (typeof origin !== "number" || !Number.isFinite(origin) || seg.tsMs! < origin - 500) return [];
        if (seg.sessionUid && fragment.sessionUid && seg.sessionUid !== fragment.sessionUid) return [];
        const secondsInFragment = Math.max(0, (seg.tsMs! - origin) / 1000);
        if (fragment.duration > 0 && secondsInFragment >= fragment.duration) return [];
        return [{ fragmentIndex, secondsInFragment }];
      });
      if (candidates.length === 1) {
        seeks.set(seg.id, candidates[0]);
      } else if (
        candidates.length === 0 &&
        audioFragments.length === 1 &&
        audioFragments[0].audioStartMs == null &&
        seg.tsMs < 100_000_000_000
      ) {
        const secondsInFragment = seg.tsMs / 1000;
        if (audioFragments[0].duration <= 0 || secondsInFragment < audioFragments[0].duration) {
          seeks.set(seg.id, { fragmentIndex: 0, secondsInFragment });
        }
      }
    }
    return seeks;
  }, [allLines, audioFragments, canPlayMeetingAudio]);

  const playableSegmentIds = useMemo(() => new Set(segmentAudioSeeks.keys()), [segmentAudioSeeks]);

  const activeSegmentId = useMemo(() => {
    if (!playbackActive || !playbackPosition) return null;
    const fragment = audioFragments[playbackPosition.fragmentIndex];
    if (!fragment) return null;
    const playbackMs =
      typeof fragment.audioStartMs === "number" && Number.isFinite(fragment.audioStartMs)
        ? fragment.audioStartMs + playbackPosition.secondsInFragment * 1000
        : playbackPosition.virtualTime * 1000;
    const playable = allLines.filter(
      (seg) =>
        seg.id &&
        segmentAudioSeeks.has(seg.id) &&
        segmentAudioSeeks.get(seg.id)?.fragmentIndex === playbackPosition.fragmentIndex &&
        typeof seg.tsMs === "number",
    );
    for (let i = playable.length - 1; i >= 0; i--) {
      const seg = playable[i];
      if (seg.tsMs! > playbackMs + 500) continue;
      if (
        (typeof seg.endTsMs === "number" && playbackMs <= seg.endTsMs + 1000) ||
        i === playable.length - 1 ||
        playbackMs < (playable[i + 1]?.tsMs ?? Number.POSITIVE_INFINITY)
      ) {
        return seg.id!;
      }
    }
    return null;
  }, [allLines, audioFragments, playbackActive, playbackPosition, segmentAudioSeeks]);

  const seekSegment = useCallback(
    (segmentId: string) => {
      const seek = segmentAudioSeeks.get(segmentId);
      if (!seek) return;
      setPlaybackActive(true);
      playerRef.current?.seekToFragment(seek.fragmentIndex, seek.secondsInFragment);
    },
    [segmentAudioSeeks],
  );

  // Aggregate real Action Items, Questions, Decisions, and Outline chapters
  const actionItems: ActionItemRow[] = useMemo(() => {
    const rows: ActionItemRow[] = [];
    const seen = new Set<string>();
    const pushUnique = (row: ActionItemRow) => {
      const key = row.text.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    };

    for (const item of liveAssistState?.items ?? []) {
      if (item.type === "task") {
        const assigneeRaw = item.details?.assignees_text;
        const assignee = Array.isArray(assigneeRaw) ? assigneeRaw.join(", ") : assigneeRaw;
        pushUnique({
          id: item.id,
          text: item.text,
          done: item.status === "completed" || item.status === "cancelled",
          assignee: assignee || undefined,
          source: "live-state",
          revision: item.revision,
          segmentId: item.evidence?.[0]?.segment_id,
        });
      }
    }

    for (const fact of memoryFacts) {
      if (fact.type === "action_item") {
        pushUnique({
          id: `mem-${fact.id}`,
          text: fact.text,
          done: prefs.doneIds.includes(`mem-${fact.id}`),
          assignee: fact.evidence?.[0]?.speaker_name,
          source: "memory",
          segmentId: fact.evidence?.[0]?.segment_id,
        });
      }
    }

    for (const act of m?.actions ?? []) {
      pushUnique({
        id: `act-${act.id}`,
        text: act.label,
        done: prefs.doneIds.includes(`act-${act.id}`),
        source: "meeting",
      });
    }

    for (const local of prefs.localTasks) {
      pushUnique({
        id: local.id,
        text: local.text,
        done: local.done,
        assignee: local.assignee,
        source: "local",
      });
    }

    return rows;
  }, [liveAssistState?.items, m?.actions, memoryFacts, prefs.doneIds, prefs.localTasks]);

  const decisions = useMemo(() => {
    const list: Array<{ id: string; text: string; speaker?: string; segmentId?: string }> = [];
    for (const item of liveAssistState?.items ?? []) {
      if (item.type === "conclusion") {
        list.push({ id: item.id, text: item.text, segmentId: item.evidence?.[0]?.segment_id });
      }
    }
    for (const fact of memoryFacts) {
      if (fact.type === "decision") {
        list.push({
          id: `dec-${fact.id}`,
          text: fact.text,
          speaker: fact.evidence?.[0]?.speaker_name,
          segmentId: fact.evidence?.[0]?.segment_id,
        });
      }
    }
    return list;
  }, [liveAssistState?.items, memoryFacts]);

  const questionCount = useMemo(() => {
    const stateQs = (liveAssistState?.items ?? []).filter((item) => item.type === "question").length;
    const transcriptQs = allLines.filter((l) => (l.text || "").includes("?")).length;
    return Math.max(stateQs, transcriptQs);
  }, [allLines, liveAssistState?.items]);

  const firstTsMs = allLines.find((l) => typeof l.tsMs === "number")?.tsMs;

  const outlineChapters = useMemo(() => {
    const chapters: Array<{ id: string; time: string; title: string; summary: string; segmentId?: string }> = [];
    const visibleNotes = durableNotes.filter((n) => !n.withdrawn && n.text.trim());
    for (const note of visibleNotes) {
      const firstEvidenceSeg =
        Array.isArray(note.evidence) && note.evidence[0] && typeof note.evidence[0] === "object"
          ? String((note.evidence[0] as { segment_id?: string }).segment_id || "")
          : undefined;
      chapters.push({
        id: note.id,
        time: formatChapterClock(note.tsMs ?? (note.t ? note.t * 1000 : undefined), firstTsMs),
        title: note.chapter || note.speaker || "Discussion",
        summary: note.text,
        segmentId: firstEvidenceSeg || undefined,
      });
    }
    if (chapters.length === 0) {
      for (const item of liveAssistState?.items ?? []) {
        if (item.type === "agenda" || item.type === "conclusion") {
          chapters.push({
            id: item.id,
            time: formatChapterClock(item.evidence?.[0]?.start_ms, firstTsMs),
            title: item.type === "agenda" ? "Topic" : "Decision",
            summary: item.text,
            segmentId: item.evidence?.[0]?.segment_id,
          });
        }
      }
    }
    return chapters;
  }, [durableNotes, firstTsMs, liveAssistState?.items]);

  const speakerStats = useMemo(() => computeSpeakerStats(allLines), [allLines]);
  const fallbackDurationSec = useMemo(() => {
    const mins = m ? meetingDurationMins(m) : null;
    if (mins != null && mins > 0) return mins * 60;
    return Math.round(speakerStats.totalDurationMs / 1000);
  }, [m, speakerStats.totalDurationMs]);

  const playerChapters = useMemo<ChapterRailItem[]>(() => {
    return outlineChapters.slice(0, 12).map((ch, idx) => {
      const parts = ch.time.split(":").map((n) => Number(n));
      const seconds =
        parts.length === 2 && parts.every(Number.isFinite)
          ? parts[0] * 60 + parts[1]
          : idx * 60;
      return {
        id: ch.id,
        title: ch.title,
        time: ch.time,
        seconds,
        segmentId: ch.segmentId,
      };
    });
  }, [outlineChapters]);

  const resolution = meetingResolution(m, byId ? !!fetched : listLoaded);

  if (!listed && fetched?.error) {
    return (
      <div className={styles.shell}>
        <div className={styles.loadingCenter}>
          <p role="alert">{fetched.error}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => {
                setDetail(undefined);
                setDetailAttempt((a) => a + 1);
              }}
            >
              Try again
            </button>
            <button type="button" className={styles.ghostBtn} onClick={onBack}>
              Back to meetings
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (needsDetail && resolution === "resolving") {
    return (
      <div className={styles.shell}>
        <div className={styles.loadingCenter} role="status">
          Loading meeting…
        </div>
      </div>
    );
  }

  if (resolution === "not-found") {
    return (
      <div className={styles.shell}>
        <MeetingNotFound meetingId={meetingId} onOpenToday={onBack} />
      </div>
    );
  }

  const headerState = meetingHeaderState(m, wsConnected);
  const title = m ? m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "") : "Meeting";
  const meetingCode = m?.native_id || m?.id || meetingId;
  const hostName = m?.participants[0]?.name || speakerStats.speakers[0]?.speaker || user?.name || m?.platform || "Host";
  const whenText = m ? meetingWhenLabel(m) : "";
  const durationLabel =
    fallbackDurationSec > 0 ? formatTalkDuration(fallbackDurationSec * 1000) : m?.platform || "";
  const summaryText = liveAssistState?.summaries?.meeting || m?.summary || m?.notes || "";
  const canDelete =
    !!m &&
    m.status === "past" &&
    !!m.native_id &&
    !m.shared &&
    ["completed", "failed", "stopped"].includes(m.live_status ?? "");

  const updatePrefs = (updater: (cur: LocalMeetingPrefs) => LocalMeetingPrefs) => {
    setPrefs((cur) => {
      const next = updater(cur);
      writeMeetingPrefs(resolvedId, next);
      return next;
    });
  };

  const toggleActionItem = (item: ActionItemRow) => {
    if (item.source === "live-state" && liveAssistState?.configured && !liveAssistState.readonly) {
      void liveAssistAction("edit", {
        id: item.id,
        expected_revision: item.revision ?? 0,
        patch: { status: item.done ? "accepted" : "completed" },
      });
      return;
    }
    if (item.source === "local") {
      updatePrefs((cur) => ({
        ...cur,
        localTasks: cur.localTasks.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t)),
      }));
      return;
    }
    updatePrefs((cur) => ({
      ...cur,
      doneIds: cur.doneIds.includes(item.id)
        ? cur.doneIds.filter((id) => id !== item.id)
        : [...cur.doneIds, item.id],
    }));
  };

  const addActionItem = async (e: FormEvent) => {
    e.preventDefault();
    const text = newTaskDraft.trim();
    if (!text) return;
    setNewTaskDraft("");
    if (liveAssistState?.configured && !liveAssistState.readonly) {
      await liveAssistAction("add", { type: "task", text, details: {} });
      return;
    }
    updatePrefs((cur) => ({
      ...cur,
      localTasks: [
        ...cur.localTasks,
        { id: `local-${Date.now()}`, text, done: false, assignee: user?.name || hostName },
      ],
    }));
  };

  const generateAiNotes = async () => {
    if (!resolvedId || processingBusy) return;
    setProcessingBusy(true);
    try {
      await fetch("/api/meeting/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_id: resolvedId, native_id: m?.native_id ?? resolvedId, on: true }),
      });
      window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: resolvedId } }));
      void loadDurable();
    } finally {
      setProcessingBusy(false);
    }
  };

  const runMeetingSkill = async (skill: (typeof MEETING_SKILLS)[number]) => {
    if (meetingsOnly) return;
    setSkillOutputs((prev) => ({ ...prev, [skill.id]: { text: "", loading: true } }));
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const activeContext = m
      ? {
          kind: "meeting" as const,
          meeting_id: m.id,
          platform: m.platform === "Google Meet" ? "google_meet" : m.platform.toLowerCase(),
          native_id: m.native_id || m.id,
          status: m.live_status,
          title,
        }
      : { kind: "meeting" as const, meeting_id: resolvedId, native_id: resolvedId };
    const controller = new AbortController();
    try {
      await streamChatTurn(
        {
          prompt: skill.prompt,
          session: `skill-${resolvedId}-${skill.id}-${Date.now().toString(36)}`,
          active: activeContext,
          context: {
            tz,
            surface: { list: "meetings", tab: { kind: "meeting" } },
            focus: activeContext,
          },
        },
        {
          onStarting: () => undefined,
          onTool: () => undefined,
          onCommit: () => undefined,
          onRejected: () => {
            setSkillOutputs((prev) => ({
              ...prev,
              [skill.id]: { text: prev[skill.id]?.text ?? "", loading: false, error: "Request was rejected." },
            }));
          },
          onModelFailure: (reply) => {
            setSkillOutputs((prev) => ({
              ...prev,
              [skill.id]: { text: prev[skill.id]?.text ?? "", loading: false, error: reply || "Model inference failed." },
            }));
          },
          onDelta: (delta) => {
            setSkillOutputs((prev) => ({
              ...prev,
              [skill.id]: { text: (prev[skill.id]?.text ?? "") + delta, loading: true },
            }));
          },
          onReply: (reply) => {
            setSkillOutputs((prev) => ({
              ...prev,
              [skill.id]: { text: reply || prev[skill.id]?.text || "", loading: false },
            }));
          },
          onError: (errMsg) => {
            setSkillOutputs((prev) => ({
              ...prev,
              [skill.id]: { text: prev[skill.id]?.text ?? "", loading: false, error: errMsg },
            }));
          },
        },
        { signal: controller.signal },
      );
      setSkillOutputs((prev) => ({
        ...prev,
        [skill.id]: { ...prev[skill.id], loading: false },
      }));
    } catch (err) {
      setSkillOutputs((prev) => ({
        ...prev,
        [skill.id]: { text: "", loading: false, error: presentError(err).headline },
      }));
    }
  };

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!m || !renameDraft.trim() || renameBusy) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/meetings/${encodeURIComponent(m.id)}/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: renameDraft.trim() }),
      });
      if (!res.ok) throw await readApiFailure(res);
      refreshMeetings();
      if (needsDetail) setDetailAttempt((a) => a + 1);
      setRenameOpen(false);
    } catch (err) {
      setRenameError(presentMeetingActionFailure(err));
    } finally {
      setRenameBusy(false);
    }
  };

  const deleteMeeting = async () => {
    if (!m || !canDelete || deleting) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      if (!response.ok) throw await readApiFailure(response);
      refreshMeetings();
      onBack();
    } finally {
      setDeleting(false);
    }
  };

  const copyMeetingUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const copySummary = async () => {
    if (!summaryText) return;
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopiedSummary(true);
      window.setTimeout(() => setCopiedSummary(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const copyFullTranscript = async () => {
    if (!allLines.length && !voiceReplies.length) return;
    const startAnchor = m?.start_time ? Date.parse(m.start_time) : undefined;
    const combined: Array<{ sortMs: number; line: string }> = [
      ...allLines.map((l, idx) => ({
        sortMs:
          typeof l.tsMs === "number" && Number.isFinite(l.tsMs)
            ? l.tsMs > 100_000_000_000
              ? l.tsMs
              : (startAnchor ?? 0) + l.tsMs
            : (startAnchor ?? 0) + idx,
        line: `${l.t ? `[${l.t}] ` : ""}${l.speaker || "Speaker"}: ${l.text}`,
      })),
      ...voiceReplies.map((r) => {
        const dt = new Date(r.created_at_ms);
        const stamp = Number.isFinite(dt.getTime())
          ? dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
          : "";
        const text = r.state === "stopped" && r.played_text != null ? r.played_text : r.text;
        return {
          sortMs: r.created_at_ms,
          line: `${stamp ? `[${stamp}] ` : ""}TINA Agent: ${text}`,
        };
      }),
    ].sort((a, b) => a.sortMs - b.sortMs);
    try {
      await navigator.clipboard.writeText(combined.map((item) => item.line).join("\n"));
      setCopiedTranscript(true);
      window.setTimeout(() => setCopiedTranscript(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const openTaskCount = actionItems.filter((t) => !t.done).length;
  const visibleTasks = actionItems.filter((t) =>
    taskFilter === "pending" ? !t.done : taskFilter === "done" ? t.done : true,
  );
  const keywordChips = Array.from(
    new Set([
      ...(m?.mentioned ?? []),
      ...(m?.docs?.map((d) => d.title || d.path.split("/").pop()?.replace(/\.md$/, "") || "") ?? []),
      ...(m?.participants.map((p) => p.name) ?? []),
    ]),
  ).filter(Boolean);

  return (
    <div className={`${styles.shell} tina-web-embedded-surface`}>
      {/* Hidden mounted TINA power dialogs */}
      {resolvedId && phase !== "prep" && (
        <>
          <MeetingMemory hideTrigger meetingId={resolvedId} openRef={memoryOpenRef} />
          <SpeakerRegistry hideTrigger meetingId={resolvedId} openRef={speakersOpenRef} />
          <TranscriptReview hideTrigger meetingId={resolvedId} openRef={reviewOpenRef} />
          {phase === "post" && (
            <DiscussionReview
              key={`disc-${resolvedId}`}
              meetingId={resolvedId}
              meetingTitle={title}
              openRef={discussionOpenRef}
            />
          )}
        </>
      )}

      {/* Dedicated Detail Top Bar */}
      <header className={styles.topBar}>
        <div className={styles.topBarLeft}>
          {onOpenMobileNav && (
            <button
              type="button"
              className={styles.mobileMenuBtn}
              aria-label="Open navigation"
              onClick={onOpenMobileNav}
            >
              <WebIcon name="menu" size={18} />
            </button>
          )}

          <nav className={styles.crumb} aria-label="Meeting breadcrumb">
            <button type="button" className={styles.crumbBack} onClick={onBack}>
              <WebIcon name="arrowLeft" size={14} />
              <span>#My Meetings</span>
            </button>
            <span className={styles.crumbSep} aria-hidden="true">
              /
            </span>
            <span className={styles.crumbCurrent} title={title}>
              {meetingCode}
            </span>
          </nav>

          {headerState === "live" && <span className={`${styles.statusTag} ${styles.statusTagLive}`}>Live</span>}
          {headerState === "pending" && <span className={`${styles.statusTag} ${styles.statusTagWarn}`}>Joining</span>}
          {headerState === "reconnecting" && (
            <span className={`${styles.statusTag} ${styles.statusTagWarn}`}>Reconnecting…</span>
          )}
          {phase === "prep" && <span className={styles.statusTag}>Planned</span>}

          {/* Meeting ••• Options Menu */}
          <div className={styles.menuWrap} ref={moreRef}>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Meeting options"
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              onClick={() => setMoreMenuOpen((v) => !v)}
            >
              <WebIcon name="moreHorizontal" size={16} />
            </button>

            {moreMenuOpen && (
              <div className={`${styles.menuPop} ${styles.menuPopLeft}`} role="menu" aria-label="Meeting options">
                {m && !m.shared && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setRenameDraft(title);
                      setRenameError(null);
                      setRenameOpen(true);
                    }}
                  >
                    <WebIcon name="edit" size={14} />
                    <span>Rename meeting</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    void copyMeetingUrl();
                  }}
                >
                  <WebIcon name="link" size={14} />
                  <span>Copy meeting link</span>
                </button>
                {!meetingsOnly && m && canSetMeetingWorkspace(m) && (
                  <button type="button" role="menuitem" className={styles.menuItem}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setWorkspaceOpen(true);
                    }}>
                    <WebIcon name="folder" size={14} />
                    <span>{m.workspace_id ? "Change workspace" : "Add to workspace"}</span>
                  </button>
                )}
                {phase !== "prep" && (
                  <>
                    <div className={styles.menuDivider} />
                    {phase === "post" && (
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setMoreMenuOpen(false);
                          discussionOpenRef.current?.();
                        }}
                      >
                        <WebIcon name="fileText" size={14} />
                        <span>Discussion review</span>
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() => {
                        setMoreMenuOpen(false);
                        memoryOpenRef.current?.();
                      }}
                    >
                      <WebIcon name="sparkleSmall" size={14} />
                      <span>Meeting memory</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() => {
                        setMoreMenuOpen(false);
                        speakersOpenRef.current?.();
                      }}
                    >
                      <WebIcon name="users" size={14} />
                      <span>Speaker identities</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() => {
                        setMoreMenuOpen(false);
                        reviewOpenRef.current?.();
                      }}
                    >
                      <WebIcon name="listChecks" size={14} />
                      <span>Review transcript</span>
                    </button>
                  </>
                )}
                {canOpenTerminal && (
                  <>
                    <div className={styles.menuDivider} />
                    <a
                      href={terminalMeetingPath(resolvedId)}
                      role="menuitem"
                      className={styles.menuItem}
                    >
                      <WebIcon name="terminal" size={14} />
                      <span>Open in TINA Terminal</span>
                    </a>
                  </>
                )}
                {canDelete && (
                  <>
                    <div className={styles.menuDivider} />
                    <button
                      type="button"
                      role="menuitem"
                      className={`${styles.menuItem} ${styles.menuItemDanger}`}
                      disabled={deleting}
                      onClick={() => {
                        setMoreMenuOpen(false);
                        void deleteMeeting();
                      }}
                    >
                      <WebIcon name="trash" size={14} />
                      <span>{deleting ? "Deleting…" : "Delete meeting"}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {phase !== "prep" && (
            <button
              type="button"
              className={`${styles.ghostBtn} ${styles.smartSearchToggle} ${smartSearchVisible ? styles.ghostBtnActive : ""}`}
              aria-label={smartSearchVisible ? "Hide Smart Search" : "Show Smart Search"}
              aria-expanded={smartSearchVisible}
              aria-controls={smartSearchVisible ? smartSearchId : undefined}
              title={smartSearchVisible ? "Hide Smart Search" : "Show Smart Search"}
              onClick={toggleSmartSearch}
            >
              <WebIcon name="sidebar" size={16} />
              <span>Smart Search</span>
            </button>
          )}
        </div>

        <div className={styles.topBarRight}>
          {isLive && liveAssistState?.can_configure && !liveAssistState.enabled && (
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={liveAssistBusy}
              onClick={() => void enableLiveAssist()}
            >
              <WebIcon name="fileText" size={14} />
              <span>{liveAssistBusy ? "Enabling…" : "Enable live assist"}</span>
            </button>
          )}

          {m && phase !== "prep" && <BotControls m={m} connected={wsConnected} onOpenMeeting={onOpenMeeting} />}

          {m?.id && !m.shared && phase !== "prep" && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ShareSessionButton key={m.id} meetingId={m.id} />
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Copy link"
                title={copiedLink ? "Link copied" : "Copy meeting link"}
                onClick={() => void copyMeetingUrl()}
              >
                <WebIcon name={copiedLink ? "check" : "link"} size={15} />
              </button>
            </div>
          )}

          {onOpenCapture && (
            <>
              <span className={styles.vDivider} aria-hidden="true" />
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Capture new meeting"
                title="Capture or schedule a meeting"
                onClick={() => onOpenCapture("live")}
              >
                <WebIcon name="plus" size={17} />
              </button>
            </>
          )}

          {user && onUserMenuToggle && (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Account menu"
              onClick={onUserMenuToggle}
            >
              <WebAvatar name={user.name} image={user.image} size={26} />
            </button>
          )}
        </div>
      </header>

      {chatgptPlanIssue && <div className={styles.bannerAlert}><ChatGPTPlanNotice issue={chatgptPlanIssue} /></div>}
      {liveAssistError && !liveAssistState?.enabled && (
        <div role="alert" className={styles.bannerAlert}>
          {liveAssistError}
        </div>
      )}

      {m && phase === "prep" ? (
        <MeetingPrepWorkspace
          key={m.id}
          meeting={m}
          meetingsOnly={meetingsOnly}
          firstName={user?.firstName || "there"}
          autoStartBrief={autoStartBrief}
          onConsumeAutoStartBrief={onConsumeAutoStartBrief}
          onBack={onBack}
          onOpenMeeting={onOpenMeeting}
          onOpenKnowledgeDoc={onOpenKnowledgeDoc}
          onUpdated={() => {
            refreshMeetings();
            if (needsDetail) setDetailAttempt((a) => a + 1);
          }}
        />
      ) : (
        <>
          <div className={styles.body}>
            {/* Zone 1: Left Smart Search + Speaker Talk Time */}
            {smartSearchVisible && (
              <MeetingSmartSearch
                id={smartSearchId}
                meeting={m}
                lines={allLines}
                liveAssistState={liveAssistState}
                taskCount={actionItems.length}
                questionCount={questionCount}
                decisionCount={decisions.length}
                discussionSignals={discussionSignals}
                isLive={isLive}
                refreshing={refreshingTranscript}
                activeSpeaker={speakerFilter}
                questionsOnly={questionsOnly}
                activeTracker={trackerFilter}
                onRefresh={() => void loadDurable()}
                onSelectTasks={() => setDocTab("tasks")}
                onToggleQuestions={() => {
                  setQuestionsOnly((v) => {
                    const next = !v;
                    if (next) setSideTab("transcript");
                    return next;
                  });
                }}
                onSelectSpeaker={(spk) => {
                  setSpeakerFilter(spk);
                  if (spk) setSideTab("transcript");
                }}
                onSelectTracker={(kw) => {
                  setTrackerFilter(kw);
                  if (kw) setSideTab("transcript");
                }}
              />
            )}

            {/* Zone 2: Center Structured Meeting Document */}
            {!fullscreenSide && (
            <section className={styles.centerMain} aria-label="Meeting notes workspace">
              <div className={styles.centerTabsRow}>
                <div className={styles.docTabList} role="tablist" aria-label="Meeting document tabs">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={docTab === "notes"}
                    className={styles.docTabBtn}
                    onClick={() => setDocTab("notes")}
                  >
                    <span>Notes</span>
                  </button>
                  {!meetingsOnly && (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={docTab === "skills"}
                      className={styles.docTabBtn}
                      onClick={() => setDocTab("skills")}
                    >
                      <span>AI Skills</span>
                      <span className={styles.tabBadge}>{MEETING_SKILLS.length}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={docTab === "tasks"}
                    className={styles.docTabBtn}
                    onClick={() => setDocTab("tasks")}
                  >
                    <span>Action Items</span>
                    <span className={styles.tabBadge}>{openTaskCount}</span>
                  </button>
                  {liveAssistEnabled && (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={docTab === "live-assist"}
                      className={styles.docTabBtn}
                      onClick={() => setDocTab("live-assist")}
                    >
                      <span>Live Assist</span>
                    </button>
                  )}
                </div>

                <div className={styles.centerToolsRight}>
                  {phase === "post" && resolvedId && (
                    <LiveMeetingState
                      key={`state-${resolvedId}`}
                      meetingId={resolvedId}
                      meetingTitle={title}
                      onSourceJump={(segId) => {
                        setSideTab("transcript");
                        seekSegment(segId);
                      }}
                    />
                  )}
                  <div className={styles.menuWrap} ref={toolsRef}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label="Meeting tools"
                      title="Meeting tools"
                      aria-expanded={toolsMenuOpen}
                      onClick={() => setToolsMenuOpen((v) => !v)}
                    >
                      <WebIcon name="sliders" size={15} />
                    </button>
                    {toolsMenuOpen && (
                      <div className={styles.menuPop} role="menu" aria-label="Meeting analysis tools">
                        {phase === "post" && (
                          <button
                            type="button"
                            role="menuitem"
                            className={styles.menuItem}
                            onClick={() => {
                              setToolsMenuOpen(false);
                              discussionOpenRef.current?.();
                            }}
                          >
                            <WebIcon name="fileText" size={14} />
                            <span>Discussion review</span>
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          className={styles.menuItem}
                          onClick={() => {
                            setToolsMenuOpen(false);
                            memoryOpenRef.current?.();
                          }}
                        >
                          <WebIcon name="sparkleSmall" size={14} />
                          <span>Meeting memory</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className={styles.menuItem}
                          onClick={() => {
                            setToolsMenuOpen(false);
                            speakersOpenRef.current?.();
                          }}
                        >
                          <WebIcon name="users" size={14} />
                          <span>Speaker identities</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className={styles.menuItem}
                          onClick={() => {
                            setToolsMenuOpen(false);
                            reviewOpenRef.current?.();
                          }}
                        >
                          <WebIcon name="listChecks" size={14} />
                          <span>Review transcript</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${fullscreenDoc ? styles.iconBtnActive : ""}`}
                    aria-label={fullscreenDoc ? "Exit fullscreen notes" : "Fullscreen notes"}
                    title={fullscreenDoc ? "Show side panels" : "Expand notes"}
                    onClick={() => {
                      setFullscreenSide(false);
                      setFullscreenDoc((v) => !v);
                    }}
                  >
                    <WebIcon name={fullscreenDoc ? "minimize" : "maximize"} size={15} />
                  </button>
                </div>
              </div>

              {docTab === "live-assist" && liveAssistEnabled && liveAssistState ? (
                <div className={styles.liveAssistPane}>
                  <LiveAssistRunningView
                    key={resolvedId}
                    meetingId={resolvedId}
                    meetingTitle={title}
                    state={liveAssistState}
                    busy={liveAssistBusy}
                    error={liveAssistError}
                    syncedAt={liveAssistSyncedAt}
                    pendingDraft={liveAssistDraft}
                    onAction={liveAssistAction}
                    onRetryDraft={() => void retryLiveAssistDraft()}
                  />
                </div>
              ) : (
                <div ref={notesScrollRef} className={styles.docScroll}>
                  <LucianSelectionTooltip
                    containerRef={notesScrollRef}
                    onAskQuote={
                      meetingsOnly
                        ? undefined
                        : (quote) => {
                            setPendingAskPrompt(`Explain and follow up on this note: "${quote}"`);
                            setSideTab("ask");
                          }
                    }
                  />
                  <div className={styles.docInner}>
                    {/* Meeting Title & Metadata Header */}
                    <div>
                      <div className={styles.docTitleRow}>
                        <div className={styles.docTitleGroup}>
                          <h1 className={styles.docTitle}>{title}</h1>
                          <span className={styles.meetingCode}>#{meetingCode}</span>
                        </div>
                        {audioFragments.length > 0 && (
                          <button
                            type="button"
                            className={styles.ghostBtn}
                            onClick={() => playerRef.current?.togglePlay()}
                          >
                            <WebIcon name="video" size={15} />
                            <span>Recording</span>
                          </button>
                        )}
                      </div>

                      <div className={styles.docMeta} style={{ marginTop: 12 }}>
                        <span className={styles.docMetaHost}>
                          <WebAvatar name={hostName} size={20} />
                          <span>{hostName}</span>
                        </span>
                        {whenText && (
                          <>
                            <span className={styles.docMetaSep} aria-hidden="true" />
                            <span>{whenText}</span>
                          </>
                        )}
                        {durationLabel && (
                          <>
                            <span className={styles.docMetaSep} aria-hidden="true" />
                            <span>{durationLabel}</span>
                          </>
                        )}
                        <span className={styles.docMetaSep} aria-hidden="true" />
                        <label className={styles.langSelectWrap}>
                          <WebIcon name="globe" size={14} />
                          <select
                            aria-label="Transcript language"
                            className={styles.langSelect}
                            value={language}
                            onChange={(e) => setLanguage(e.currentTarget.value as TranscriptLanguage)}
                          >
                            <option value="bilingual">Song ngữ (VI / EN)</option>
                            <option value="vi">Tiếng Việt</option>
                            <option value="en">English</option>
                          </select>
                        </label>
                      </div>
                    </div>

                    {/* TAB: NOTES */}
                    {docTab === "notes" && (
                      <>
                        {/* AI Executive Summary Card */}
                        <section className={styles.summaryCard} aria-label="AI Executive Summary">
                          <div className={styles.summaryHead}>
                            <span className={styles.summaryLabel}>
                              <WebIcon name="sparkleSmall" size={15} />
                              <span>AI Executive Summary</span>
                            </span>
                            <div className={styles.summaryActions}>
                              {summaryText && (
                                <button type="button" className={styles.ghostBtn} onClick={() => void copySummary()}>
                                  <WebIcon name={copiedSummary ? "check" : "copy"} size={13} />
                                  <span>{copiedSummary ? "Copied" : "Copy"}</span>
                                </button>
                              )}
                              {phase === "post" && !summaryText && (
                                <button
                                  type="button"
                                  className={styles.ghostBtn}
                                  disabled={processingBusy}
                                  onClick={() => void generateAiNotes()}
                                >
                                  <span>{processingBusy ? "Generating…" : "Generate AI notes"}</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {summaryText ? (
                            <p className={styles.summaryText}>{summaryText}</p>
                          ) : (
                            <div className={styles.summaryEmpty}>
                              <p>
                                {isLive
                                  ? "Summary updates once enough transcript segments are captured or Live Assist is enabled."
                                  : "No executive summary has been saved for this meeting yet."}
                              </p>
                              {!meetingsOnly && (
                                <div>
                                  <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={() =>
                                      setPendingAskPrompt(
                                        "Write a concise executive summary of this meeting including main topics and key decisions.",
                                      )
                                    }
                                  >
                                    <WebIcon name="sparkleSmall" size={14} />
                                    <span>Summarize with Ask Tina</span>
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </section>

                        {phase === "post" && /^[1-9]\d*$/.test(resolvedId) && (
                          <PostMeetingDraft key={resolvedId} meetingId={resolvedId} />
                        )}

                        {/* Action Items Section */}
                        <section className={styles.docSection} aria-label="Action items">
                          <div className={styles.docSectionHead}>
                            <h3>Action Items</h3>
                            <span className={styles.countTag}>{openTaskCount} pending</span>
                          </div>

                          {actionItems.length > 0 && (
                            <div className={styles.taskList}>
                              {actionItems.map((item) => (
                                <div
                                  key={item.id}
                                  className={`${styles.taskRow} ${item.done ? styles.taskRowDone : ""}`}
                                >
                                  <button
                                    type="button"
                                    className={`${styles.taskCheck} ${item.done ? styles.taskCheckChecked : ""}`}
                                    aria-label={item.done ? "Mark pending" : "Mark done"}
                                    onClick={() => toggleActionItem(item)}
                                  >
                                    {item.done && <WebIcon name="check" size={12} />}
                                  </button>
                                  <div className={styles.taskBody}>
                                    <span className={styles.taskText} onClick={() => toggleActionItem(item)}>
                                      {item.text}
                                    </span>
                                  </div>
                                  {item.assignee && <span className={styles.taskAssignee}>@{item.assignee}</span>}
                                </div>
                              ))}
                            </div>
                          )}

                          <form className={styles.addTaskForm} onSubmit={(e) => void addActionItem(e)}>
                            <input
                              type="text"
                              className={styles.addTaskInput}
                              aria-label="Add new action item"
                              placeholder="Add new action item…"
                              value={newTaskDraft}
                              onChange={(e) => setNewTaskDraft(e.target.value)}
                            />
                            <button type="submit" className={styles.primaryBtn} disabled={!newTaskDraft.trim()}>
                              Add
                            </button>
                          </form>
                        </section>

                        {/* Chapters & Outline */}
                        {outlineChapters.length > 0 && (
                          <section className={styles.docSection} aria-label="Chapters and outline">
                            <div className={styles.docSectionHead}>
                              <h3>Chapters &amp; Outline</h3>
                              <span className={styles.countTag}>{outlineChapters.length}</span>
                            </div>
                            <div className={styles.outlineTimeline}>
                              {outlineChapters.map((chapter) => (
                                <div key={chapter.id} className={styles.outlineRow}>
                                  <button
                                    type="button"
                                    className={styles.outlineTime}
                                    onClick={() => {
                                      setSideTab("transcript");
                                      if (chapter.segmentId) seekSegment(chapter.segmentId);
                                    }}
                                  >
                                    <WebIcon name="play" size={10} />
                                    <span>{chapter.time}</span>
                                  </button>
                                  <div className={styles.outlineContent}>
                                    <strong>{chapter.title}</strong>
                                    <p>{chapter.summary}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </section>
                        )}

                        {/* Keywords & Connected Entities */}
                        {keywordChips.length > 0 && (
                          <section className={styles.docSection} aria-label="Keywords and participants">
                            <div className={styles.docSectionHead}>
                              <h3>Participants &amp; Tracked Topics</h3>
                            </div>
                            <div className={styles.keywordWrap}>
                              {keywordChips.map((chip) => (
                                <button
                                  key={chip}
                                  type="button"
                                  className={styles.keywordChip}
                                  onClick={() => {
                                    setTrackerFilter(chip);
                                    setSideTab("transcript");
                                  }}
                                >
                                  <span>#{chip}</span>
                                </button>
                              ))}
                            </div>
                          </section>
                        )}
                      </>
                    )}

                    {/* TAB: AI SKILLS */}
                    {docTab === "skills" && !meetingsOnly && (
                      <div className={styles.docSection}>
                        <div className={styles.docSectionHead}>
                          <div>
                            <h3>AI Apps &amp; Skills for this Meeting</h3>
                            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--tw-text-3)" }}>
                              Run grounded TINA analysis on this meeting transcript to generate structured outputs.
                            </p>
                          </div>
                        </div>

                        <div className={styles.skillsGrid}>
                          {MEETING_SKILLS.map((skill) => {
                            const run = skillOutputs[skill.id];
                            return (
                              <article key={skill.id} className={styles.skillCard}>
                                <span className={styles.skillMeta}>{skill.category}</span>
                                <h4>{skill.title}</h4>
                                <p>{skill.description}</p>
                                {run?.error && (
                                  <div role="alert" style={{ fontSize: 12.5, color: "var(--tw-danger)" }}>
                                    {run.error}
                                  </div>
                                )}
                                {run?.text && (
                                  <div className={styles.skillOutput}>
                                    <Markdown>{run.text}</Markdown>
                                  </div>
                                )}
                                <div className={styles.skillFooter}>
                                  <button
                                    type="button"
                                    className={run?.text ? styles.ghostBtn : styles.primaryBtn}
                                    disabled={run?.loading}
                                    onClick={() => void runMeetingSkill(skill)}
                                  >
                                    <span>{run?.loading ? "Running…" : run?.text ? "Regenerate" : "Run skill"}</span>
                                  </button>
                                  {run?.text && (
                                    <button
                                      type="button"
                                      className={styles.ghostBtn}
                                      onClick={() => {
                                        void navigator.clipboard.writeText(run.text);
                                        setCopiedSkillId(skill.id);
                                        window.setTimeout(() => setCopiedSkillId(null), 1800);
                                      }}
                                    >
                                      <WebIcon name={copiedSkillId === skill.id ? "check" : "copy"} size={13} />
                                      <span>{copiedSkillId === skill.id ? "Copied" : "Copy"}</span>
                                    </button>
                                  )}
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* TAB: ACTION ITEMS */}
                    {docTab === "tasks" && (
                      <div className={styles.docSection}>
                        <div className={styles.docSectionHead}>
                          <h3>All Action Items ({actionItems.length})</h3>
                          <div className={styles.docTabList}>
                            {(["all", "pending", "done"] as const).map((f) => (
                              <button
                                key={f}
                                type="button"
                                className={styles.docTabBtn}
                                aria-selected={taskFilter === f}
                                onClick={() => setTaskFilter(f)}
                              >
                                {f === "all" ? "All" : f === "pending" ? "Pending" : "Done"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {visibleTasks.length === 0 ? (
                          <p style={{ margin: 0, fontSize: 13.5, color: "var(--tw-text-3)" }}>
                            No action items in this view yet. Add one below or ask Tina to extract action items.
                          </p>
                        ) : (
                          <div className={styles.taskList}>
                            {visibleTasks.map((item) => (
                              <div
                                key={item.id}
                                className={`${styles.taskRow} ${item.done ? styles.taskRowDone : ""}`}
                              >
                                <button
                                  type="button"
                                  className={`${styles.taskCheck} ${item.done ? styles.taskCheckChecked : ""}`}
                                  aria-label={item.done ? "Mark pending" : "Mark done"}
                                  onClick={() => toggleActionItem(item)}
                                >
                                  {item.done && <WebIcon name="check" size={12} />}
                                </button>
                                <div className={styles.taskBody}>
                                  <span className={styles.taskText} onClick={() => toggleActionItem(item)}>
                                    {item.text}
                                  </span>
                                </div>
                                {item.assignee && <span className={styles.taskAssignee}>@{item.assignee}</span>}
                              </div>
                            ))}
                          </div>
                        )}

                        <form className={styles.addTaskForm} onSubmit={(e) => void addActionItem(e)}>
                          <input
                            type="text"
                            className={styles.addTaskInput}
                            aria-label="Add new action item"
                            placeholder="Add new action item…"
                            value={newTaskDraft}
                            onChange={(e) => setNewTaskDraft(e.target.value)}
                          />
                          <button type="submit" className={styles.primaryBtn} disabled={!newTaskDraft.trim()}>
                            Add
                          </button>
                        </form>

                        {decisions.length > 0 && (
                          <div className={styles.docSection} style={{ marginTop: 12 }}>
                            <div className={styles.docSectionHead}>
                              <h3>Key Decisions ({decisions.length})</h3>
                            </div>
                            <div className={styles.taskList}>
                              {decisions.map((d) => (
                                <div key={d.id} className={styles.taskRow}>
                                  <span className={styles.dot} style={{ marginTop: 6 }} aria-hidden="true" />
                                  <div className={styles.taskBody}>
                                    <span className={styles.taskText}>{d.text}</span>
                                  </div>
                                  {d.speaker && <span className={styles.taskAssignee}>@{d.speaker}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
            )}

            {/* Zone 3: Right Ask Tina & Transcript Panel */}
            {!fullscreenDoc && (
              <MeetingSidePanel
                meetingId={resolvedId}
                meeting={m}
                firstName={user?.firstName || "there"}
                meetingsOnly={meetingsOnly}
                sideTab={sideTab}
                onSideTabChange={setSideTab}
                lines={allLines}
                processedNotes={durableNotes}
                voiceReplies={voiceReplies}
                meetingStartMs={m?.start_time ? Date.parse(m.start_time) : undefined}
                isLive={isLive}
                language={language}
                translationSnapshot={translation.snapshot}
                translationError={translation.error}
                onRetryTranslation={translation.retry}
                speakerFilter={speakerFilter}
                questionsOnly={questionsOnly}
                trackerFilter={trackerFilter}
                onClearSpeaker={() => setSpeakerFilter("")}
                onClearQuestions={() => setQuestionsOnly(false)}
                onClearTracker={() => setTrackerFilter("")}
                playableSegmentIds={playableSegmentIds}
                activeSegmentId={activeSegmentId}
                audioVirtualSec={playbackActive ? playbackPosition?.virtualTime : undefined}
                onSegmentClick={canPlayMeetingAudio && audioFragments.length ? seekSegment : undefined}
                pendingPrompt={pendingAskPrompt}
                onConsumePendingPrompt={() => setPendingAskPrompt(null)}
                expanded={fullscreenSide}
                onToggleExpand={() => {
                  setFullscreenDoc(false);
                  setFullscreenSide((v) => !v);
                }}
              />
            )}
          </div>

          {/* Zone 4: Bottom Docked Studio Audio Player */}
          <MeetingBottomPlayer
            ref={playerRef}
            fragments={audioFragments}
            audioLoading={audioLoading}
            audioMessage={audioMessage}
            isLive={isLive}
            fallbackDurationSec={fallbackDurationSec}
            starred={prefs.starred}
            reviewed={prefs.reviewed}
            copiedTranscript={copiedTranscript}
            smartSearchOpen={smartSearchVisible}
            chapters={playerChapters}
            onSelectChapter={(ch) => {
              if (ch.segmentId && canPlayMeetingAudio && audioFragments.length) {
                seekSegment(ch.segmentId);
              } else if (ch.seconds >= 0 && audioFragments.length) {
                playerRef.current?.seekToFragment(0, ch.seconds);
              }
            }}
            onToggleStar={() => updatePrefs((cur) => ({ ...cur, starred: !cur.starred }))}
            onToggleReviewed={() => updatePrefs((cur) => ({ ...cur, reviewed: !cur.reviewed }))}
            onCopyTranscript={() => void copyFullTranscript()}
            onToggleSmartSearch={toggleSmartSearch}
            onPositionChange={(pos) => {
              setPlaybackPosition(pos);
              setPlaybackActive(true);
            }}
          />
        </>
      )}

      {workspaceOpen && m && (
        <MeetingWorkspaceDialog key={m.id} meeting={m} onClose={() => setWorkspaceOpen(false)} onSaved={() => {
          refreshMeetings();
          if (needsDetail) setDetailAttempt((attempt) => attempt + 1);
          setWorkspaceOpen(false);
        }} />
      )}
      {/* Inline Rename Modal */}
      {renameOpen && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Rename meeting"
          onClick={() => setRenameOpen(false)}
        >
          <form
            className={styles.modalCard}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void submitRename(e)}
          >
            <h2>Rename meeting</h2>
            <input
              type="text"
              className={styles.addTaskInput}
              aria-label="Meeting title"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              autoFocus
            />
            {renameError && (
              <div role="alert" style={{ fontSize: 12.5, color: "var(--tw-danger)" }}>
                {renameError}
              </div>
            )}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setRenameOpen(false)}>
                Cancel
              </button>
              <button type="submit" className={styles.primaryBtn} disabled={renameBusy || !renameDraft.trim()}>
                {renameBusy ? "Saving…" : "Save title"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
