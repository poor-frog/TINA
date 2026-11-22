"use client";
/** MeetingDetailView — End-user meeting view backed by TINA's real MeetingCanvasView
 *  (LiveTranscriptEngine + bilingual translation + audio player), MeetingKnowledge ("Ask TINA"),
 *  real-time Live Assist (`LiveAssistRunningView`), and Speaker Talk Time analytics. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import { SpeakerTalkTimePanel } from "./SpeakerTalkTime";
import { MeetingCanvasView } from "../canvas/MeetingCanvasView";
import { MeetingKnowledge } from "../surfaces/MeetingKnowledge";
import { LiveAssistRunningView } from "../surfaces/LiveAssistRunningView";
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
import { meetingPhase, type MeetingMock } from "../surfaces/meetingModel";
import { fetchMeetingById, refreshMeetings } from "../surfaces/liveMeetings";
import { readApiFailure } from "../surfaces/apiClient";
import { deletePlannedMeeting, updatePlannedMeeting } from "../surfaces/plannedApi";
import { parseMeetingInput, meetingUrlFor } from "../surfaces/meetingId";
import { defaultBotName } from "../surfaces/defaultBotName";
import { terminalMeetingPath } from "../app/meetingRoute";

export function MeetingDetailView({
  meetingId,
  meetings,
  listLoaded,
  wsConnected,
  meetingsOnly,
  canOpenTerminal,
  onBack,
}: {
  meetingId: string;
  meetings: MeetingMock[];
  listLoaded: boolean;
  wsConnected: boolean;
  meetingsOnly: boolean;
  canOpenTerminal: boolean;
  onBack: () => void;
}) {
  const [askOpen, setAskOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1280 : false,
  );
  const [deleting, setDeleting] = useState(false);
  const [detail, setDetail] = useState<{ id: string; row: MeetingMock | null; error?: string }>();
  const [detailAttempt, setDetailAttempt] = useState(0);
  const byId = /^[1-9]\d*$/.test(meetingId);
  const listed = meetings.find((row) => row.id === meetingId || (!byId && row.native_id === meetingId));
  const needsDetail = byId && !listed;
  const fetched = detail?.id === meetingId ? detail : undefined;
  const m = listed ?? fetched?.row ?? undefined;

  useEffect(() => {
    if (!needsDetail) return;
    const controller = new AbortController();
    void fetchMeetingById(meetingId, controller.signal).then(
      (row) => { if (!controller.signal.aborted) setDetail({ id: meetingId, row }); },
      (error) => {
        if (!controller.signal.aborted)
          setDetail({ id: meetingId, row: null, error: presentMeetingActionFailure(error) });
      },
    );
    return () => controller.abort();
  }, [needsDetail, meetingId, detailAttempt]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("askTina") === "1") {
      setAskOpen(true);
      url.searchParams.delete("askTina");
      try {
        window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      } catch {
        /* ignore sandboxed history */
      }
    }
  }, [meetingId]);

  const phase = m ? meetingPhase(m) : "live";
  const liveAssistMeetingId = m && phase === "live" ? String(m.id) : "";

  // ── Real-time Live Assist state (mirrors MeetingTab in src/surfaces/meeting.tsx) ──
  const [liveAssistState, setLiveAssistState] = useState<LiveMeetingStateSnapshot | null>(null);
  const [transcriptViewMeetingId, setTranscriptViewMeetingId] = useState("");
  const liveAssistEnabled = !!(liveAssistMeetingId && liveAssistState?.enabled);
  const showingLiveAssist = liveAssistEnabled && transcriptViewMeetingId !== liveAssistMeetingId;
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
        if (!controller.signal.aborted && ticket === liveAssistRequestSerial.current) {
          setLiveAssistError(reason instanceof Error ? reason.message : "Could not load Live Assist state");
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      liveAssistRequestSerial.current++;
    };
  }, [liveAssistMeetingId, publishLiveAssistState]);

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
      setTranscriptViewMeetingId("");
      publishLiveAssistState(enabled, true, false);
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
      let pending = readPlannedLiveAssistDraft(id);
      if (action === "edit" && request.id === "goal" && typeof request.patch?.text === "string") {
        pending = { ...pending, goal: null };
      } else if (action === "edit" && request.id && typeof request.patch?.text === "string") {
        pending = { ...pending, agendaEdits: pending.agendaEdits.filter((item) => item.id !== request.id) };
      } else if (action === "add" && request.type === "agenda" && typeof request.text === "string") {
        const index = pending.agendaItems.findIndex((item) => item.text === request.text);
        if (index >= 0) pending = { ...pending, agendaItems: pending.agendaItems.filter((_, i) => i !== index) };
      }
      writePlannedLiveAssistDraft(id, pending);
      setLiveAssistDraft(pending);
      return true;
    } catch (reason) {
      setLiveAssistError(reason instanceof Error ? reason.message : "Could not save Live Assist state");
      const request =
        payload && typeof payload === "object"
          ? (payload as { id?: string; type?: string; text?: string; patch?: { text?: string } })
          : {};
      let pending = readPlannedLiveAssistDraft(id);
      let retained = false;
      if (action === "edit" && request.id === "goal" && typeof request.patch?.text === "string") {
        pending = { ...pending, goal: request.patch.text };
        retained = true;
      } else if (action === "edit" && request.id && typeof request.patch?.text === "string") {
        const revision = liveAssistStateRef.current?.items?.find((item) => item.id === request.id)?.revision ?? 0;
        pending = {
          ...pending,
          agendaEdits: [
            ...pending.agendaEdits.filter((item) => item.id !== request.id),
            { id: request.id, text: request.patch.text, revision },
          ],
        };
        retained = true;
      } else if (action === "add" && request.type === "agenda" && typeof request.text === "string") {
        const draftId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `draft-${Date.now()}`;
        pending = { ...pending, agendaItems: [...pending.agendaItems, { id: draftId, text: request.text }] };
        retained = true;
      }
      if (retained) {
        writePlannedLiveAssistDraft(id, pending);
        setLiveAssistDraft(pending);
      }
      return retained;
    } finally {
      setLiveAssistBusy(false);
    }
  };

  const resolution = meetingResolution(m, byId ? !!fetched : listLoaded);

  if (!listed && fetched?.error) {
    return (
      <div className="tina-web-detail">
        <p role="alert">{fetched.error}</p>
        <button type="button" onClick={() => { setDetail(undefined); setDetailAttempt((attempt) => attempt + 1); }}>Try again</button>
        <button type="button" onClick={onBack}>Back to meetings</button>
      </div>
    );
  }

  if (needsDetail && resolution === "resolving") {
    return <div className="tina-web-detail" role="status">Loading meeting…</div>;
  }

  if (resolution === "not-found") {
    return (
      <div className="tina-web-detail">
        <MeetingNotFound meetingId={meetingId} onOpenToday={onBack} />
      </div>
    );
  }

  const headerState = meetingHeaderState(m, wsConnected);
  const title = m ? (m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "")) : "Meeting";
  const when = m ? meetingWhenLabel(m) : "";
  const canDelete =
    !!m &&
    m.status === "past" &&
    !!m.native_id &&
    !m.shared &&
    ["completed", "failed", "stopped"].includes(m.live_status ?? "");

  const deleteMeeting = async (): Promise<string | null> => {
    if (!m || !canDelete || deleting) return "This meeting is not available to delete.";
    setDeleting(true);
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      if (!response.ok) throw await readApiFailure(response);
      refreshMeetings();
      onBack();
      return null;
    } catch (err) {
      return presentMeetingActionFailure(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="tina-web-detail">
      <header className="tina-web-detail-head">
        <div className="tina-web-detail-id">
          <button type="button" className="tina-web-btn-ghost" onClick={onBack} aria-label="Back to meetings">
            <WebIcon name="arrowLeft" size={15} />
            <span>Back</span>
          </button>

          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 className="tina-web-detail-title">{title}</h1>
              {headerState === "live" && <span className="tina-web-status-pill live">Live</span>}
              {headerState === "pending" && <span className="tina-web-status-pill scheduled">Joining</span>}
              {headerState === "reconnecting" && <span className="tina-web-status-pill scheduled">Reconnecting…</span>}
              {phase === "prep" && <span className="tina-web-status-pill scheduled">Planned</span>}
              {headerState === "recap" && phase === "post" && (
                <span className="tina-web-status-pill completed">Recap</span>
              )}
            </div>
            {m && (
              <div className="tina-web-detail-meta">
                <span>{m.platform}</span>
                {when && <span>· {when}</span>}
                {m.participants.length > 0 && <span>· {m.participants.length} participants</span>}
                {m.has_recording && <span style={{ color: "var(--tw-mint)" }}>· Audio available</span>}
              </div>
            )}
          </div>
        </div>

        <div className="tina-web-detail-actions">
          {liveAssistMeetingId && liveAssistState?.can_configure && !liveAssistState.enabled && (
            <button
              type="button"
              className="tina-web-btn-primary"
              disabled={liveAssistBusy}
              onClick={() => void enableLiveAssist()}
            >
              <WebIcon name="fileText" size={14} />
              <span>{liveAssistBusy ? "Enabling…" : "Enable live assist"}</span>
            </button>
          )}

          {liveAssistEnabled && (
            <div className="tina-web-view-tabs" role="tablist" aria-label="Meeting view mode">
              <button
                type="button"
                role="tab"
                aria-selected={!showingLiveAssist}
                className={`tina-web-view-tab ${!showingLiveAssist ? "active" : ""}`}
                onClick={() => setTranscriptViewMeetingId(liveAssistMeetingId)}
              >
                <WebIcon name="list" size={13} />
                <span>Transcript</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={showingLiveAssist}
                className={`tina-web-view-tab ${showingLiveAssist ? "active" : ""}`}
                onClick={() => setTranscriptViewMeetingId("")}
              >
                <WebIcon name="fileText" size={13} />
                <span>Live Assist</span>
              </button>
            </div>
          )}

          {phase !== "prep" && (
            <button
              type="button"
              className={insightsOpen ? "tina-web-btn-ghost active" : "tina-web-btn-ghost"}
              aria-expanded={insightsOpen}
              onClick={() => setInsightsOpen((v) => !v)}
            >
              <WebIcon name="chart" size={14} />
              <span>Talk time</span>
            </button>
          )}

          {m && !meetingsOnly && phase !== "prep" && (
            <button
              type="button"
              className={askOpen ? "tina-web-btn-primary" : "tina-web-btn-ghost"}
              aria-expanded={askOpen}
              onClick={() => setAskOpen((v) => !v)}
            >
              <WebIcon name="tinaAsk" size={14} />
              <span>{askOpen ? "Hide Ask TINA" : "Ask TINA"}</span>
            </button>
          )}
          {m && <BotControls m={m} connected={wsConnected} />}
          {m?.id && !m.shared && <ShareSessionButton key={m.id} meetingId={m.id} />}
          {canOpenTerminal && (
            <a
              href={terminalMeetingPath(m?.id ?? meetingId)}
              className="tina-web-btn-ghost"
              title="Inspect this meeting in TINA Terminal"
            >
              <WebIcon name="terminal" size={14} />
              <span>Terminal</span>
            </a>
          )}
        </div>
      </header>

      {liveAssistError && !liveAssistState?.enabled && (
        <div role="alert" className="tina-web-detail-banner danger">
          {liveAssistError}
        </div>
      )}

      {m && phase === "prep" ? (
        <PlannedMeetingEditor key={m.id} meeting={m} onBack={onBack}
          onUpdated={() => { refreshMeetings(); if (needsDetail) setDetailAttempt((attempt) => attempt + 1); }} />
      ) : (
        <div className="tina-web-detail-body">
          {insightsOpen && (
            <SpeakerTalkTimePanel meetingId={m?.id ?? meetingId} meeting={m} isLive={phase === "live"} />
          )}

          <div className="tina-web-detail-canvas">
            <div className="tina-web-detail-pane" hidden={showingLiveAssist}>
              <MeetingCanvasView
                key={m?.id ?? meetingId}
                meetingId={m?.id ?? meetingId}
                meetingRecord={m}
                onDeleteMeeting={canDelete ? deleteMeeting : undefined}
                deletingMeeting={deleting}
              />
            </div>
            {liveAssistMeetingId && liveAssistState?.enabled && (
              <div className="tina-web-detail-pane" hidden={!showingLiveAssist}>
                <LiveAssistRunningView
                  key={liveAssistMeetingId}
                  meetingId={liveAssistMeetingId}
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
            )}
          </div>

          {m && !meetingsOnly && askOpen && (
            <aside className="tina-web-detail-ask" aria-label="Ask TINA about this meeting">
              <MeetingKnowledge key={`web-knowledge-${m.id}`} meetingId={String(m.id)} />
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function PlannedMeetingEditor({ meeting, onBack, onUpdated }: { meeting: MeetingMock; onBack: () => void; onUpdated: () => void }) {
  const [title, setTitle] = useState(meeting.title_custom || meeting.title || "");
  const [meetingUrl, setMeetingUrl] = useState(meeting.meeting_url || "");
  const [scheduledAt, setScheduledAt] = useState(() => {
    if (!meeting.scheduled_at) return "";
    const dt = new Date(meeting.scheduled_at);
    if (!Number.isFinite(dt.getTime())) return "";
    return new Date(dt.getTime() - dt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [autoJoin, setAutoJoin] = useState(meeting.auto_join !== false);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatusMsg(null);
    try {
      await updatePlannedMeeting(meeting.id, {
        title: title.trim() || null,
        meeting_url: meetingUrl.trim() || null,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        auto_join: autoJoin,
      });
      onUpdated();
      setStatusMsg("Saved meeting plan.");
    } catch (err) {
      setError(presentMeetingActionFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const joinNow = async () => {
    const parsed = parseMeetingInput(meetingUrl || meeting.native_id || "");
    if (!parsed) {
      setError("Add a valid Google Meet, Zoom, Teams, Jitsi, or Discord link first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: parsed.platform,
          native_meeting_id: parsed.native_meeting_id,
          meeting_url: meetingUrlFor(parsed, meetingUrl || meeting.native_id || ""),
          bot_name: defaultBotName(),
        }),
      });
      if (!r.ok) throw await readApiFailure(r);
      onUpdated();
      setStatusMsg("Bot dispatched to meeting.");
    } catch (err) {
      setError(presentMeetingActionFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deletePlannedMeeting(meeting.id);
      refreshMeetings();
      onBack();
    } catch (err) {
      setError(presentMeetingActionFailure(err));
      setBusy(false);
    }
  };

  return (
    <div className="tina-web-view-scroll">
      <div className="tina-web-page-wrap" style={{ maxWidth: 680 }}>
        <div className="tina-web-panel">
          <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 600 }}>Meeting Prep</h2>
          <p style={{ margin: "0 0 18px", fontSize: 13.5, color: "var(--tw-text-3)" }}>
            Configure details before the call starts. Once TINA joins, live bilingual transcription opens here automatically.
          </p>

          <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label className="tina-web-field">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
            </label>
            <label className="tina-web-field">
              <span>Meeting link</span>
              <input
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                disabled={busy}
                placeholder="https://meet.google.com/abc-defg-hij"
              />
            </label>
            <label className="tina-web-field">
              <span>Scheduled time</span>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                disabled={busy}
              />
            </label>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "var(--tw-text-2)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={autoJoin}
                onChange={(e) => setAutoJoin(e.target.checked)}
                disabled={busy}
              />
              <span>Auto-join at start time</span>
            </label>

            {statusMsg && <div style={{ fontSize: 12.5, color: "var(--tw-mint)" }}>{statusMsg}</div>}
            {error && (
              <div role="alert" style={{ fontSize: 12.5, color: "var(--tw-danger)" }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              <button type="submit" className="tina-web-btn-primary" disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </button>
              <button type="button" className="tina-web-btn-ghost" disabled={busy} onClick={() => void joinNow()}>
                <WebIcon name="play" size={14} />
                <span>Send bot now</span>
              </button>
              <button
                type="button"
                className="tina-web-btn-ghost"
                disabled={busy}
                onClick={() => void remove()}
                style={{ marginLeft: "auto", color: "var(--tw-danger)" }}
              >
                <WebIcon name="trash" size={14} />
                <span>Delete plan</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
