"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CanvasActionsProvider, useActions, OPEN_ENTITY_EVENT } from "./actions";
import { MeetingHealthBanner } from "./MeetingHealthBanner";
import { LiveTranscriptEngine, type EngineActions, type EngineEntity, type EngineSignal } from "./LiveTranscriptEngine";
import { useMeetingNotes } from "./notes";
import { deriveProcessingView } from "./processingView";
import { MeetingScopeProvider, MeetingSourceProvider, useEntities, useMeeting, useSignals } from "./useMeeting";
import { meetingPhase, type MeetingMock } from "../surfaces/meetingModel";
import { MeetingDetailsRail } from "./MeetingDetailsRail";
import dossierStyles from "./MeetingDetailsRail.module.css";
import transcriptStyles from "./MeetingTranscript.module.css";
import { MeetingMemory } from "../surfaces/MeetingMemory";
import { DiscussionReview } from "../surfaces/DiscussionReview";
import { SpeakerRegistry } from "../surfaces/SpeakerRegistry";
import { TranscriptReview } from "../surfaces/TranscriptReview";
import { MeetingAudioPlayer, type MeetingAudioFragment, type MeetingAudioPlayerHandle, type MeetingAudioPosition } from "./MeetingAudioPlayer";
import { TranslationControls, useMeetingTranslation, type TranscriptLanguage } from "./MeetingTranslation";
import { projectTranslationGroups, type TranslationGroup } from "./translationGroups";

export const MEETING_CANVAS_CONTENT_INSET = 18;

function filterSegments<T extends { speaker?: string; text: string }>(segments: T[], query: string, speaker: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle && !speaker) return segments;
  return segments.filter((segment) => {
    const matchesSpeaker = !speaker || (segment.speaker ?? "Speaker") === speaker;
    const matchesQuery = !needle || ((segment.speaker ?? "") + " " + segment.text).toLocaleLowerCase().includes(needle);
    return matchesSpeaker && matchesQuery;
  });
}

/** ONE render engine for both modes (P23: the terminal RENDERS, it does not re-derive). The toggle picks
 *  the SOURCE — raw segments vs the cleaned processed mirror — not a different renderer. */
function RawTranscript({ searchQuery, speakerFilter, onSegmentClick, playableSegmentIds, activeSegmentId, language, translationGroups = [], translationPaused, ended = false }: {
  searchQuery: string;
  speakerFilter: string;
  onSegmentClick?: (segmentId: string) => void;
  playableSegmentIds?: ReadonlySet<string>;
  activeSegmentId?: string | null;
  language?: TranscriptLanguage;
  translationGroups?: TranslationGroup[];
  translationPaused?: boolean;
  ended?: boolean;
}) {
  const { transcript } = useMeeting();
  const source = language && language !== "vi" ? transcript.segments.map(segment => ({ ...segment, text: segment.sourceText ?? segment.text })) : transcript.segments;
  const paired = projectTranslationGroups(source, language && language !== "vi" ? translationGroups : []);
  const searchable = paired.filter(segment => !searchQuery.trim() ||
    `${segment.speaker ?? ''} ${segment.text} ${segment.translation?.text ?? ''}`.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()));
  const segments = filterSegments(searchable, "", speakerFilter);
  return <LiveTranscriptEngine segments={segments} emptyLabel={searchQuery || speakerFilter ? "No transcript segments match these filters." : ended ? "No transcript is available for this meeting." : "Waiting for transcript…"}
    onSegmentClick={onSegmentClick} playableSegmentIds={playableSegmentIds} activeSegmentId={activeSegmentId}
    language={language} translationPaused={translationPaused} />;
}

// Map a copilot signal's loose context/kind onto the badge taxonomy (decision / action-item /
// question / claim). Unknown kinds fall through as-is so they still render with a neutral hue.
function signalKind(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase();
  if (/decis|commit/.test(k)) return "decision";
  if (/action|task|next.?step|follow/.test(k)) return "action-item";
  if (/question|ask|objection|concern/.test(k)) return "question";
  if (/claim|insight|fact/.test(k)) return "claim";
  return k || "signal";
}

/** PROCESSED v2 = the cleaned mirror with INLINE entity highlights (clickable → research / open entity
 *  doc) and actionable copilot SIGNAL badges, all through the SAME engine. */
function ProcessedTranscript({ searchQuery, speakerFilter, onSegmentClick, playableSegmentIds, activeSegmentId, ended = false }: {
  searchQuery: string;
  speakerFilter: string;
  onSegmentClick?: (segmentId: string) => void;
  playableSegmentIds?: ReadonlySet<string>;
  activeSegmentId?: string | null;
  ended?: boolean;
}) {
  const notes = useMeetingNotes();
  const entityItems = useEntities();
  const signalItems = useSignals();
  const actions = useActions();

  const segments = filterSegments(notes.map((n) => ({
    speaker: n.speaker, text: n.text, tsMs: n.tsMs, id: n.id, completed: n.completed,
    stale: n.stale, evidence: n.evidence,
    tags: (n.tags ?? []).map((t) => ({ label: t.label, kind: t.kind })),
  })), searchQuery, speakerFilter);

  // Only highlight taggable entities (people/companies/products); numbers/signals aren't worth inline
  // wrapping in flowing prose. `splitTextIntoSpans` re-finds each label so the merge/tail stay intact.
  const entities: EngineEntity[] = entityItems
    .filter((e) => e.kind === "person" || e.kind === "company" || e.kind === "product")
    .map((e) => ({ id: e.id, label: e.name, kind: e.kind, docPath: e.docPath }));

  const signals: EngineSignal[] = signalItems.map((s) => ({ id: s.id, kind: signalKind(s.context), label: s.name }));

  const engineActions: EngineActions = {
    // Research in the VISIBLE chat (so the user sees it), not a hidden fire-and-forget session.
    research: (e) => actions.ask(`Research the ${e.kind} "${e.name}" using the web and my knowledge graph. Write or update its entity doc and commit, then summarize what you found.`),
    // Open the entity's doc — by its path if known, else resolve by name; reveals the center if needed.
    openEntityDoc: (e) => { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_ENTITY_EVENT, { detail: { path: e.docPath, wikilink: e.name } })); },
    onSignal: (sig) => actions.ask(`Create a task / fact-check this ${sig.kind}: ${sig.label}`),
  };

  return (
    <LiveTranscriptEngine
      segments={segments}
      emptyLabel={searchQuery || speakerFilter ? "No transcript segments match these filters." : ended ? "No processed transcript is available. Switch to Original ASR." : "Processing transcript…"}
      entities={entities}
      signals={signals}
      actions={engineActions}
      onSegmentClick={onSegmentClick}
      playableSegmentIds={playableSegmentIds}
      activeSegmentId={activeSegmentId}
    />
  );
}

function MeetingCanvasBody({ meetingId, meetingRecord, onDeleteMeeting, deletingMeeting }: { meetingId?: string; meetingRecord?: MeetingMock; onDeleteMeeting?: () => Promise<string | null>; deletingMeeting?: boolean }) {
  const { meeting, transcript, diagnostics } = useMeeting();
  const live = meeting.live === true;
  const hasNotes = (transcript.notes?.length ?? 0) > 0;
  // Durable truth wins over a stale list `live` flag ([N8] — the row can stay stuck on a live
  // session_uid after a stop): once the effective status is TERMINAL the meeting is not
  // effectively-live, whatever the subscribe key says. THE view-mode rule is the shared
  // deriveProcessingView (processingView.ts) — this component holds no private copy of it.
  const durableTerminal = ["completed", "failed", "stopped", "past"].includes(meeting.status ?? "");
  const effectiveLive = live && !durableTerminal;
  const canPlayMeetingAudio = durableTerminal && !effectiveLive;
  // P0: `meetingId` (the tab id) is the meetings-domain ROW id; the human-readable native is on the
  // meeting state — pass BOTH to /api/meeting/process so it keys the copilot on the row id (leak-safe)
  // while naming the kg doc by the native.
  const nativeId = meeting.nativeId;

  // null = untouched → follow the default (which can flip once the durable notes hydrate).
  const [override, setOverride] = useState<boolean | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsId = useId();
  const [searchQuery, setSearchQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState("");
  const [audioFragments, setAudioFragments] = useState<MeetingAudioFragment[]>([]);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioMessage, setAudioMessage] = useState("");
  const [playbackPosition, setPlaybackPosition] = useState<MeetingAudioPosition | null>(null);
  const [playbackActive, setPlaybackActive] = useState(false);
  const audioPlayerRef = useRef<MeetingAudioPlayerHandle>(null);
  const audioRecordings = transcript.recordings ?? [];
  const audioRecordingSignature = audioRecordings
    .filter((recording) => ["completed", "in_progress"].includes(recording.status) && !!recording.playback_url?.audio)
    .map((recording) => `${recording.id}:${recording.status}:${recording.audio_start_ms ?? ""}:${recording.created_at ?? ""}:${recording.media_files?.map((file) => `${file.type}=${file.duration_seconds ?? ""}`).join(",") ?? ""}:${recording.playback_url?.audio ?? ""}`)
    .sort()
    .join("|");
  const audioRecordingsRef = useRef(audioRecordings);
  audioRecordingsRef.current = audioRecordings;
  const memoryOpen = useRef<(() => void) | null>(null);
  const speakersOpen = useRef<(() => void) | null>(null);
  const reviewOpen = useRef<(() => void) | null>(null);
  const discussionOpen = useRef<(() => void) | null>(null);
  const dialogMeetingId = meetingRecord?.id ?? meetingId ?? "";
  const [language, setLanguage] = useState<TranscriptLanguage>("bilingual");
  const translation = useMeetingTranslation(dialogMeetingId, language,
    transcript.segments.filter(segment => segment.completed !== false && !!segment.id).map(segment => segment.id!));
  const speakerOptions = Array.from(new Set(transcript.segments.map((segment) => segment.speaker?.trim()).filter((speaker): speaker is string => !!speaker)));
  const processing = deriveProcessingView({ override, live, hasNotes, durableTerminal });

  useEffect(() => {
    if (!canPlayMeetingAudio) {
      setAudioFragments([]);
      setAudioMessage("");
      setAudioLoading(false);
      setPlaybackActive(false);
      setPlaybackPosition(null);
      return;
    }
    const candidates = audioRecordingsRef.current
      .filter((recording) => ["completed", "in_progress"].includes(recording.status) && !!recording.playback_url?.audio)
      .sort((left, right) => (left.created_at ?? "").localeCompare(right.created_at ?? ""));
    let cancelled = false;
    setAudioFragments([]);
    setAudioMessage("");
    setAudioLoading(candidates.length > 0);
    if (!candidates.length) return () => { cancelled = true; };

    void Promise.all(candidates.map(async (recording) => {
      const response = await fetch(`/api/recordings/${recording.id}/master?type=audio`, { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Recording request failed (${response.status})`);
      const master = await response.json() as { raw_url?: string; url?: string; download_url?: string; duration_seconds?: number | null };
      const mediaUrl = master.raw_url || master.url || master.download_url || "";
      let src = "";
      if (mediaUrl.startsWith("/recordings/")) {
        if (!mediaUrl.startsWith(`/recordings/${recording.id}/media/`)) throw new Error("Recording service returned an invalid media path");
        src = `/api${mediaUrl}`;
      } else if (/^https?:\/\//.test(mediaUrl)) {
        src = mediaUrl;
      }
      if (!src) return null;
      const fileDuration = recording.media_files?.find((file) => file.type === "audio")?.duration_seconds;
      return {
        src,
        duration: master.duration_seconds ?? fileDuration ?? 0,
        ...(recording.session_uid ? { sessionUid: recording.session_uid } : {}),
        ...(recording.audio_start_ms != null ? { audioStartMs: recording.audio_start_ms } : {}),
        ...(recording.created_at ? { createdAt: recording.created_at } : {}),
      } satisfies MeetingAudioFragment;
    })).then((results) => {
      if (cancelled) return;
      const resolved = results.filter((fragment): fragment is MeetingAudioFragment => fragment !== null);
      setAudioFragments(resolved);
      if (!resolved.length) setAudioMessage("Recording is still being finalized.");
    }).catch((error: unknown) => {
      if (!cancelled) setAudioMessage(error instanceof Error ? error.message : "Could not load meeting audio.");
    }).finally(() => {
      if (!cancelled) setAudioLoading(false);
    });
    return () => { cancelled = true; };
  }, [audioRecordingSignature, canPlayMeetingAudio, meetingId]);

  const segmentAudioSeeks = useMemo(() => {
    const seeks = new Map<string, { fragmentIndex: number; secondsInFragment: number }>();
    if (!canPlayMeetingAudio) return seeks;
    for (const segment of transcript.segments) {
      const segmentId = segment.id;
      if (!segmentId || typeof segment.tsMs !== "number" || !Number.isFinite(segment.tsMs)) continue;
      const candidates = audioFragments.flatMap((fragment, fragmentIndex) => {
        const origin = fragment.audioStartMs;
        if (typeof origin !== "number" || !Number.isFinite(origin) || segment.tsMs! < origin - 500) return [];
        if (segment.sessionUid && fragment.sessionUid && segment.sessionUid !== fragment.sessionUid) return [];
        const secondsInFragment = Math.max(0, (segment.tsMs! - origin) / 1000);
        if (secondsInFragment < 0 || (fragment.duration > 0 && secondsInFragment >= fragment.duration)) return [];
        return [{ fragmentIndex, secondsInFragment }];
      });
      if (candidates.length === 1) {
        seeks.set(segmentId, candidates[0]);
        continue;
      }
      // Legacy single-file meetings have relative seconds but no verified recording origin.
      if (candidates.length === 0 && audioFragments.length === 1 && audioFragments[0].audioStartMs == null && segment.tsMs < 100_000_000_000) {
        const secondsInFragment = segment.tsMs / 1000;
        if (audioFragments[0].duration <= 0 || secondsInFragment < audioFragments[0].duration) seeks.set(segmentId, { fragmentIndex: 0, secondsInFragment });
      }
    }
    return seeks;
  }, [audioFragments, canPlayMeetingAudio, transcript.segments]);
  const playableSegmentIds = useMemo(() => new Set(segmentAudioSeeks.keys()), [segmentAudioSeeks]);

  const activeSegmentId = useMemo(() => {
    if (!playbackActive || !playbackPosition) return null;
    const fragment = audioFragments[playbackPosition.fragmentIndex];
    if (!fragment) return null;
    const playbackMs = typeof fragment.audioStartMs === "number" && Number.isFinite(fragment.audioStartMs)
      ? fragment.audioStartMs + playbackPosition.secondsInFragment * 1000
      : playbackPosition.virtualTime * 1000;
    const playable = transcript.segments.filter((segment) => segment.id && segmentAudioSeeks.has(segment.id)
      && segmentAudioSeeks.get(segment.id)?.fragmentIndex === playbackPosition.fragmentIndex
      && typeof segment.tsMs === "number");
    for (let index = playable.length - 1; index >= 0; index--) {
      const segment = playable[index];
      const start = segment.tsMs!;
      if (start > playbackMs + 500) continue;
      const end = segment.endTsMs;
      if ((typeof end === "number" && playbackMs <= end + 1000) || index === playable.length - 1 || playbackMs < (playable[index + 1]?.tsMs ?? Number.POSITIVE_INFINITY)) return segment.id!;
    }
    return null;
  }, [audioFragments, playbackActive, playbackPosition, segmentAudioSeeks, transcript.segments]);

  const handleAudioPosition = (position: MeetingAudioPosition) => {
    setPlaybackPosition(position);
    setPlaybackActive(true);
  };
  const handleSegmentClick = (segmentId: string) => {
    if (!canPlayMeetingAudio) return;
    const seek = segmentAudioSeeks.get(segmentId);
    if (!seek) return;
    setPlaybackActive(true);
    audioPlayerRef.current?.seekToFragment(seek.fragmentIndex, seek.secondsInFragment);
  };

  // LIVE: the toggle ALSO controls backend processing — ON enables the copilot (full-history backfill
  // the first time, else resume); OFF disables it. COMPLETED: pure view switch — there is nothing to
  // arm any more, so we must NOT hit the process endpoint (a stale-live row counts as completed).
  const toggleProcessing = () => {
    const next = !processing;
    setOverride(next);
    if (meetingId && effectiveLive) {
      void fetch("/api/meeting/process", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // meeting_id = the ROW id (the copilot keys on it); native_id = the display native (kg doc name).
        body: JSON.stringify({ meeting_id: meetingId, native_id: nativeId ?? meetingId, on: next }),
      }).catch(() => { /* best-effort — the view still reflects the toggle */ });
    }
  };

  const retryProcessing = async (enabled = true) => {
    if (!meetingId) return;
    setRetryBusy(true); setRetryError(false);
    try {
      const response = await fetch('/api/meeting/process', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meeting_id: meetingId, native_id: nativeId ?? meetingId, on: enabled }) });
      if (!response.ok) throw new Error('Could not retry');
      if (enabled) setOverride(true);
      window.dispatchEvent(new CustomEvent('tina:transcript-corrected', { detail: { meetingId } }));
    } catch { setRetryError(true); }
    finally { setRetryBusy(false); }
  };

  const notesControl = diagnostics?.processedNotesStatus === "failed"
    ? {
        message: "AI notes could not be refreshed.",
        label: "Retry processing",
        onClick: () => void retryProcessing(),
      }
    : durableTerminal && (!diagnostics?.processedNotesStatus || diagnostics.processedNotesStatus === "disabled")
      ? {
          message: "Create readable notes with source evidence.",
          label: "Generate AI notes",
          onClick: () => void retryProcessing(),
        }
      : durableTerminal && diagnostics?.processedNotesStatus
        ? {
            message: diagnostics.processedNotesStatus === "pending" ? "Updating AI notes…" : "AI updates enabled.",
            ...(diagnostics.processedNotesStatus !== "pending" ? { label: "Disable AI updates", onClick: () => void retryProcessing(false) } : {}),
          }
        : undefined;

  return (
    <div className={dossierStyles.layout + (meetingRecord && detailsOpen ? " " + dossierStyles.layoutWithRail : "")}>
      <div className={`${dossierStyles.canvas} ${transcriptStyles.canvas}`}>
      {dialogMeetingId && <>
        <MeetingMemory hideTrigger meetingId={dialogMeetingId} openRef={memoryOpen} />
        <SpeakerRegistry hideTrigger meetingId={dialogMeetingId} openRef={speakersOpen} />
        <TranscriptReview hideTrigger meetingId={dialogMeetingId} openRef={reviewOpen} />
        {durableTerminal && <DiscussionReview key={dialogMeetingId} meetingId={dialogMeetingId} openRef={discussionOpen} />}
      </>}
      <MeetingHealthBanner hideEnded={!!meetingRecord && meetingPhase(meetingRecord) === "post"} />
      <section className={dossierStyles.transcriptPanel}>
        <header className={transcriptStyles.toolbar} data-recap={durableTerminal}>
          <div className={transcriptStyles.headingRow}>
          <div className={transcriptStyles.heading}>
            <strong>Transcript</strong>
            <button
              type="button"
              className={transcriptStyles.source}
              onClick={toggleProcessing}
              disabled={language !== "vi"}
              aria-pressed={language === "vi" && processing}
              title={processing ? "Showing the cleaned, copilot-processed view. Switch to original ASR." : (effectiveLive ? "Showing original ASR. Switch to processed view." : "Showing original ASR. Switch to processed view.")}
            >
              {language !== "vi" ? "Original ASR" : processing ? "Processed view" : "Original ASR"}
            </button>
            {!canPlayMeetingAudio && meetingRecord?.has_recording && <span className={transcriptStyles.meta}>Recording available</span>}
          </div>
          {meetingRecord && <button type="button" className={transcriptStyles.info} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen ? "Hide meeting info" : "Meeting info"}
          </button>}
          {durableTerminal && dialogMeetingId && <button type="button" className={transcriptStyles.toolToggle} aria-label="Meeting tools" title="Meeting tools" aria-expanded={toolsOpen} aria-controls={toolsId} onClick={() => setToolsOpen((open) => !open)}>
            Tools <span aria-hidden="true">{toolsOpen ? "⌃" : "⌄"}</span>
          </button>}
          {!durableTerminal && dialogMeetingId && <div className={transcriptStyles.tools} role="group" aria-label="Meeting tools">
            <button type="button" className={transcriptStyles.tool} onClick={() => memoryOpen.current?.()}>Meeting memory</button>
            <button type="button" className={transcriptStyles.tool} onClick={() => speakersOpen.current?.()}>Speaker identities</button>
            <button type="button" className={transcriptStyles.tool} onClick={() => reviewOpen.current?.()}>Review transcript</button>
          </div>}
          </div>
          {durableTerminal && dialogMeetingId && <div id={toolsId} className={transcriptStyles.recapTools} role="group" aria-label="Meeting tools" hidden={!toolsOpen}>
            <button type="button" className={transcriptStyles.tool} onClick={() => discussionOpen.current?.()}>Discussion review</button>
            <button type="button" className={transcriptStyles.tool} onClick={() => memoryOpen.current?.()}>Meeting memory</button>
            <button type="button" className={transcriptStyles.tool} onClick={() => speakersOpen.current?.()}>Speaker identities</button>
            <button type="button" className={transcriptStyles.tool} onClick={() => reviewOpen.current?.()}>Review transcript</button>
          </div>}
          {canPlayMeetingAudio && (audioLoading || audioMessage || audioFragments.length > 0) && <div className={transcriptStyles.recordingRow} aria-label="Meeting recording">
            <span className={transcriptStyles.recordingLabel}>Recording</span>
            {audioFragments.length > 0
              ? <div className={dossierStyles.recordingPlayer}><MeetingAudioPlayer ref={audioPlayerRef} fragments={audioFragments} onPositionChange={handleAudioPosition} /></div>
              : <div className={dossierStyles.recordingMessage} role="status">{audioLoading ? "Preparing recording…" : audioMessage}</div>}
          </div>}
          <div className={transcriptStyles.filters}>
            <div className={transcriptStyles.search}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
              <input className={transcriptStyles.input} aria-label="Search transcript" placeholder="Search transcript…" value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} />
            </div>
            <select className={transcriptStyles.select} aria-label="Filter transcript by speaker" value={speakerFilter} onChange={(event) => setSpeakerFilter(event.currentTarget.value)} disabled={!speakerOptions.length}>
              <option value="">All speakers</option>
              {speakerOptions.map((speaker) => <option key={speaker} value={speaker}>{speaker}</option>)}
            </select>
            <TranslationControls language={language} onChange={setLanguage} snapshot={translation.snapshot}
              error={translation.error} onRetry={translation.retry} disabled={!translation.valid} />
          </div>

        </header>
        <main className={transcriptStyles.body}>
          <div className={transcriptStyles.bodyContent}>
            {processing && language === "vi"
              ? <ProcessedTranscript searchQuery={searchQuery} speakerFilter={speakerFilter} ended={durableTerminal}
                  onSegmentClick={canPlayMeetingAudio && audioFragments.length ? handleSegmentClick : undefined}
                  playableSegmentIds={playableSegmentIds} activeSegmentId={activeSegmentId} />
              : <RawTranscript searchQuery={searchQuery} speakerFilter={speakerFilter} ended={durableTerminal}
                  language={language} translationGroups={translation.snapshot?.groups} translationPaused={!!translation.error || translation.snapshot?.status === "paused"}
                  onSegmentClick={canPlayMeetingAudio && audioFragments.length ? handleSegmentClick : undefined}
                  playableSegmentIds={playableSegmentIds} activeSegmentId={activeSegmentId} />}
          </div>
        </main>
      </section>
      </div>
      {meetingRecord && detailsOpen && <MeetingDetailsRail meeting={meetingRecord} segments={transcript.segments} recordingAvailable={canPlayMeetingAudio && audioFragments.length > 0} onDeleteMeeting={onDeleteMeeting} deletingMeeting={deletingMeeting} notesControl={notesControl ? {
        ...notesControl,
        ...(retryBusy ? { busy: true } : {}),
        ...(retryError ? { error: "Could not update AI notes. Try again shortly." } : {}),
      } : undefined} />}
    </div>
  );
}

export function MeetingCanvasView({ meetingId, meetingRecord, onDeleteMeeting, deletingMeeting }: { meetingId?: string; meetingRecord?: MeetingMock; onDeleteMeeting?: () => Promise<string | null>; deletingMeeting?: boolean }) {
  return (
    <MeetingScopeProvider meetingId={meetingId}>
      <MeetingSourceProvider meetingId={meetingId}>
        <CanvasActionsProvider>
          <MeetingCanvasBody meetingId={meetingId} meetingRecord={meetingRecord} onDeleteMeeting={onDeleteMeeting} deletingMeeting={deletingMeeting} />
        </CanvasActionsProvider>
      </MeetingSourceProvider>
    </MeetingScopeProvider>
  );
}
