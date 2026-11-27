"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { WebAvatar } from "./Avatar";
import { WebIcon } from "./Icons";
import { LucianSlidingTabs } from "./lucian/LucianSlidingTabs";
import { LucianSkeletonList } from "./lucian/LucianSkeletonCard";
import type { WebNavView } from "./Sidebar";
import { meetingPhase, type MeetingMock } from "../surfaces/meetingModel";
import { listWorkspaceTree } from "../surfaces/workspaceApi";
import { startStreamingDictation, type StreamingDictation } from "../ui-kit/micDictation";
import { useOwnBriefIndex } from "./useOwnBriefIndex";

function greetingByHour(): { text: string; emoji: string } {
  const hour = new Date().getHours();
  if (hour < 12) return { text: "Good Morning", emoji: "🌤️" };
  if (hour < 18) return { text: "Good Afternoon", emoji: "☀️" };
  return { text: "Good Evening", emoji: "🌙" };
}

export function HomeView({
  firstName,
  userName,
  meetings,
  listLoaded = true,
  meetingsOnly,
  onOpenMeeting,
  onAskTina,
  onNavigate,
  onOpenCapture,
}: {
  firstName: string;
  userName: string;
  meetings: MeetingMock[];
  listLoaded?: boolean;
  meetingsOnly: boolean;
  onOpenMeeting: (meetingId: string) => void;
  onAskTina: (prompt?: string) => void;
  onNavigate: (view: Exclude<WebNavView, "meeting">) => void;
  onOpenCapture: () => void;
}) {
  const [tab, setTab] = useState<"recent" | "upcoming" | "live">("recent");
  const [tabDir, setTabDir] = useState<"right" | "left">("right");
  const [draft, setDraft] = useState("");
  const [taskCount, setTaskCount] = useState<number | null>(null);
  const [dictating, setDictating] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const dictRef = useRef<StreamingDictation | null>(null);

  useEffect(() => {
    if (meetingsOnly) return;
    let active = true;
    const loadTasks = () => {
      void listWorkspaceTree()
        .then((tree) => {
          if (active) setTaskCount(tree.filter((p) => p.startsWith("kg/entities/task/")).length);
        })
        .catch(() => {
          if (active) setTaskCount(0);
        });
    };
    loadTasks();
    window.addEventListener("tina:tasks-changed", loadTasks);
    return () => {
      active = false;
      window.removeEventListener("tina:tasks-changed", loadTasks);
      dictRef.current?.cancel();
    };
  }, [meetingsOnly]);

  const liveMeetings = useMemo(() => meetings.filter((m) => meetingPhase(m) === "live"), [meetings]);
  const upcomingMeetings = useMemo(() => meetings.filter((m) => meetingPhase(m) === "prep"), [meetings]);
  const recentMeetings = useMemo(() => meetings.filter((m) => meetingPhase(m) === "post"), [meetings]);
  const briefIndex = useOwnBriefIndex(!meetingsOnly && upcomingMeetings.length > 0);
  const missingBriefCount = useMemo(
    () =>
      !meetingsOnly && briefIndex.loaded
        ? upcomingMeetings.filter((m) => !m.shared && !briefIndex.hasBrief(m)).length
        : 0,
    [briefIndex, meetingsOnly, upcomingMeetings],
  );

  const greeting = greetingByHour();
  const visibleFeed = tab === "live" ? liveMeetings : tab === "upcoming" ? upcomingMeetings : recentMeetings.slice(0, 6);

  const toggleMic = async () => {
    setMicError(null);
    if (dictRef.current) {
      const active = dictRef.current;
      dictRef.current = null;
      setDictating(false);
      const finalText = await active.stop().catch(() => "");
      if (finalText.trim()) setDraft(finalText.trim());
      return;
    }
    try {
      setDictating(true);
      dictRef.current = await startStreamingDictation({
        onUpdate: (confirmed, pending) => {
          const combined = [confirmed, pending].filter(Boolean).join(" ").trim();
          if (combined) setDraft(combined);
        },
        onError: (msg) => setMicError(msg),
      });
    } catch (err) {
      setDictating(false);
      setMicError(err instanceof Error ? err.message : "Microphone dictation is unavailable.");
    }
  };

  return (
    <div className="tina-web-home">
      <div className="tina-web-home-scroll">
        <div className="tina-web-home-inner">
          <div className="tina-web-greeting-row">
            <h1 className="tina-web-greeting">
              {greeting.text}, {firstName} <span aria-hidden="true">{greeting.emoji}</span>
            </h1>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {!meetingsOnly && (
                <button type="button" className="tina-web-section-action" onClick={() => onNavigate("knowledge")}>
                  <WebIcon name="bookOpen" size={15} />
                  <span>Knowledge</span>
                </button>
              )}
              <button type="button" className="tina-web-section-action" onClick={onOpenCapture}>
                <WebIcon name="plus" size={15} />
                <span>New meeting</span>
              </button>
            </div>
          </div>

          <div className="tina-web-section-head">
            <WebIcon name="sparkleSmall" size={16} />
            <h3>Personal Assistant</h3>
            <button type="button" className="tina-web-section-action" onClick={() => onNavigate("settings")}>
              <WebIcon name="settings" size={15} />
              <span>Manage</span>
            </button>
          </div>

          <div className="tina-web-pa-grid">
            <button
              type="button"
              className="tina-web-pa-card"
              onClick={() => {
                if (liveMeetings[0]) onOpenMeeting(liveMeetings[0].id);
                else if (recentMeetings[0]) onOpenMeeting(recentMeetings[0].id);
                else if (!meetingsOnly) onAskTina("Give me a brief of my recent meetings and open follow-ups.");
                else onNavigate("meetings");
              }}
            >
              <span className="tina-web-pa-icon teal">
                <WebIcon name="broadcast" size={19} />
              </span>
              <span className="tina-web-pa-title">Daily Brief</span>
              <span className="tina-web-pa-sub">
                {liveMeetings.length > 0
                  ? `${liveMeetings.length} live meeting right now`
                  : recentMeetings.length > 0
                    ? `From: ${recentMeetings.length} recent ${recentMeetings.length === 1 ? "meeting" : "meetings"}`
                    : "No recorded meetings yet"}
              </span>
            </button>

            <button
              type="button"
              className="tina-web-pa-card"
              onClick={() => {
                if (upcomingMeetings[0]) onOpenMeeting(upcomingMeetings[0].id);
                else onOpenCapture();
              }}
            >
              <span className="tina-web-pa-icon rose">
                <WebIcon name="calendarCheck" size={19} />
              </span>
              <span className="tina-web-pa-title">Meeting Prep</span>
              <span className="tina-web-pa-sub">
                {upcomingMeetings.length > 0
                  ? `${upcomingMeetings.length} upcoming ${upcomingMeetings.length === 1 ? "meeting" : "meetings"}${
                      missingBriefCount > 0 ? ` · ${missingBriefCount} needs brief` : ""
                    }`
                  : "No upcoming meetings"}
              </span>
            </button>

            <button
              type="button"
              className="tina-web-pa-card"
              onClick={() => onNavigate(meetingsOnly ? "meetings" : "tasks")}
            >
              <span className="tina-web-pa-icon sage">
                <WebIcon name="listChecks" size={19} />
              </span>
              <span className="tina-web-pa-title">{meetingsOnly ? "Meetings" : "Tasks"}</span>
              <span className="tina-web-pa-sub">
                {meetingsOnly
                  ? `${meetings.length} total meetings`
                  : taskCount === null
                    ? "Loading action items…"
                    : `${taskCount} ${taskCount === 1 ? "action item" : "action items"}`}
              </span>
            </button>
          </div>

          <div className="tina-web-tabs-row">
            <LucianSlidingTabs
              ariaLabel="Meeting feed filter"
              value={tab}
              onChange={(next) => {
                const order = { recent: 0, upcoming: 1, live: 2 };
                setTabDir(order[next] >= order[tab] ? "right" : "left");
                setTab(next);
              }}
              tabs={[
                { id: "recent", label: "Recent", count: recentMeetings.length },
                { id: "upcoming", label: "Upcoming", count: upcomingMeetings.length },
                { id: "live", label: "Live", count: liveMeetings.length },
              ]}
            />

            <button type="button" className="tina-web-section-action" onClick={() => onNavigate("meetings")}>
              <span>View all</span>
            </button>
          </div>

          <div
            key={tab}
            className={`tina-web-feed u039-panel-anim ${tabDir === "left" ? "dir-left" : ""}`}
            role="tabpanel"
          >
            {!listLoaded && meetings.length === 0 ? (
              <LucianSkeletonList count={4} variant="row" label="Loading meetings…" />
            ) : (
              <>
                {visibleFeed.map((meeting) => {
                  const phase = meetingPhase(meeting);
                  const label = meeting.title_custom || meeting.title;
                  return (
                    <button
                      key={meeting.id}
                      type="button"
                      className="tina-web-feed-row"
                      onClick={() => onOpenMeeting(meeting.id)}
                    >
                      <WebAvatar name={meeting.participants[0]?.name || userName} size={32} />
                      <span className="tina-web-feed-main">
                        <span className="tina-web-feed-title">
                          <span>{label}</span>
                          {phase === "live" && <span className="tina-web-status-pill live">Live</span>}
                          {phase === "prep" && <span className="tina-web-status-pill scheduled">Upcoming</span>}
                          {phase === "prep" && !meetingsOnly && briefIndex.loaded && !meeting.shared && (
                            <span
                              className={`tina-web-status-pill ${
                                briefIndex.hasBrief(meeting) ? "brief-ready" : "brief-missing"
                              }`}
                            >
                              {briefIndex.hasBrief(meeting) ? "Brief ready" : "No brief yet"}
                            </span>
                          )}
                          {meeting.shared && <span className="tina-web-status-pill completed">Shared</span>}
                        </span>
                        <span className="tina-web-feed-meta">
                          {meeting.platform} · {meeting.when}
                        </span>
                      </span>
                    </button>
                  );
                })}

                {visibleFeed.length === 0 && (
                  <div style={{ padding: "24px 8px", color: "var(--tw-text-4)", fontSize: 13.5 }}>
                    {tab === "live"
                      ? "No live meetings right now. Click Capture to send TINA into a call."
                      : tab === "upcoming"
                        ? "No upcoming meetings scheduled. Connect a calendar in Settings or click Capture."
                        : "No recent meetings yet. Start your first capture to see transcripts and notes here."}
                  </div>
                )}

                <div className="tina-web-caught-up">
                  <span>All caught up!</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {!meetingsOnly && (
        <div className="tina-web-composer-wrap">
          <form
            className="tina-web-composer"
            onSubmit={(event) => {
              event.preventDefault();
              onAskTina(draft.trim() || undefined);
              setDraft("");
            }}
          >
            <span className="tina-web-composer-glow" aria-hidden="true" />
            <span className="tina-web-composer-ring" aria-hidden="true" />
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={micError || "Ask Tina anything about your meetings or press ⌘K to search"}
              aria-label="Ask Tina"
            />
            <div className="tina-web-composer-actions">
              <button
                type="button"
                className={`tina-web-icon-btn ${dictating ? "recording" : ""}`}
                aria-label={dictating ? "Stop voice input" : "Voice input"}
                title={dictating ? "Stop dictation" : "Dictate with microphone"}
                onClick={() => void toggleMic()}
              >
                <WebIcon name="mic" size={16} />
              </button>
              <button type="submit" className="tina-web-send-btn" aria-label="Send to Ask Tina">
                <WebIcon name="sendUp" size={15} strokeWidth={2} />
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
