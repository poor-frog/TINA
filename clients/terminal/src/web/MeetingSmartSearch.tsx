"use client";
/** MeetingSmartSearch — Left rail for MeetingDetailView: AI Filters (real Tasks / Questions / Decisions),
 *  Conversation Signals (real Discussion Review breakdown or transcript metrics), interactive Speaker Talk Time
 *  (real WPM + share donut rings with click-to-filter), and Topic Trackers (real chapters/docs + custom keywords). */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import { computeSpeakerStats, formatTalkDuration } from "./SpeakerTalkTime";
import { LucianSpeakerDonut } from "./lucian/LucianSpeakerDonut";
import type { MeetingMock, TranscriptLine } from "../surfaces/meetingModel";
import type { LiveMeetingStateSnapshot } from "../surfaces/liveMeetingStateApi";
import styles from "./meetingDetail.module.css";

const TRACKERS_STORAGE_KEY = "tina.web.topicTrackers.v1";

function loadCustomTrackers(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(TRACKERS_STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
  } catch {
    return [];
  }
}

function saveCustomTrackers(list: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRACKERS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore storage errors */
  }
}

export interface DiscussionSignalSummary {
  onTopicPct: number;
  advancingPct: number;
  totalWindows: number;
}

export function MeetingSmartSearch({
  meeting,
  lines,
  liveAssistState,
  taskCount,
  questionCount,
  decisionCount,
  discussionSignals,
  isLive,
  refreshing,
  activeSpeaker,
  questionsOnly,
  activeTracker,
  onRefresh,
  onSelectTasks,
  onToggleQuestions,
  onSelectSpeaker,
  onSelectTracker,
}: {
  meeting?: MeetingMock;
  lines: TranscriptLine[];
  liveAssistState: LiveMeetingStateSnapshot | null;
  taskCount: number;
  questionCount: number;
  decisionCount: number;
  discussionSignals: DiscussionSignalSummary | null;
  isLive: boolean;
  refreshing: boolean;
  activeSpeaker: string;
  questionsOnly: boolean;
  activeTracker: string;
  onRefresh: () => void;
  onSelectTasks: () => void;
  onToggleQuestions: () => void;
  onSelectSpeaker: (speaker: string) => void;
  onSelectTracker: (keyword: string) => void;
}) {
  const [openFilters, setOpenFilters] = useState(true);
  const [openSignals, setOpenSignals] = useState(true);
  const [openTalkTime, setOpenTalkTime] = useState(true);
  const [openTrackers, setOpenTrackers] = useState(true);
  const [addingTracker, setAddingTracker] = useState(false);
  const [trackerDraft, setTrackerDraft] = useState("");
  const [customTrackers, setCustomTrackers] = useState<string[]>([]);

  useEffect(() => {
    setCustomTrackers(loadCustomTrackers());
  }, []);

  const stats = useMemo(() => computeSpeakerStats(lines), [lines]);

  // Combine custom trackers + real agenda/doc topics from this meeting and compute true transcript hit counts
  const trackers = useMemo(() => {
    const corpus = lines.map((l) => (l.text || "").toLowerCase());
    const autoTopics = new Set<string>();
    for (const item of liveAssistState?.items ?? []) {
      if (item.type === "agenda" && item.text.trim()) {
        autoTopics.add(item.text.trim().slice(0, 36));
      }
    }
    for (const topic of meeting?.mentioned ?? []) {
      if (topic.trim()) autoTopics.add(topic.trim());
    }
    const merged = Array.from(new Set([...customTrackers, ...autoTopics]));
    return merged.map((term) => {
      const needle = term.toLowerCase();
      const hits = corpus.reduce((sum, text) => sum + (text.includes(needle) ? 1 : 0), 0);
      return { term, hits, custom: customTrackers.includes(term) };
    });
  }, [customTrackers, lines, liveAssistState?.items, meeting?.mentioned]);

  const addTracker = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = trackerDraft.trim();
    if (!cleaned) return;
    if (!customTrackers.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
      const next = [...customTrackers, cleaned];
      setCustomTrackers(next);
      saveCustomTrackers(next);
    }
    setTrackerDraft("");
    setAddingTracker(false);
  };

  const removeTracker = (term: string) => {
    const next = customTrackers.filter((item) => item !== term);
    setCustomTrackers(next);
    saveCustomTrackers(next);
    if (activeTracker === term) onSelectTracker("");
  };

  return (
    <aside className={styles.smartRail} aria-label="Smart Search and Talk time & metrics">
      <header className={styles.smartHead}>
        <div className={styles.smartHeadTitle}>
          <h2>Smart Search</h2>
          <span className={styles.smartHeadSub}>Talk time &amp; metrics</span>
        </div>
        <button
          type="button"
          className={styles.iconBtn}
          disabled={refreshing}
          onClick={onRefresh}
          title="Refresh transcript metrics"
          aria-label="Refresh speaker metrics"
        >
          <WebIcon name="refresh" size={14} />
        </button>
      </header>

      {/* AI Filters */}
      <section className={styles.smartGroup} aria-label="AI filters">
        <button
          type="button"
          className={styles.smartGroupToggle}
          aria-expanded={openFilters}
          onClick={() => setOpenFilters((v) => !v)}
        >
          <span>AI Filters</span>
          <WebIcon name={openFilters ? "chevronUp" : "chevronDown"} size={14} />
        </button>

        {openFilters && (
          <div className={styles.filterGrid}>
            <button type="button" className={styles.filterTile} onClick={onSelectTasks}>
              <span className={`${styles.dot} ${styles.dotWarn}`} aria-hidden="true" />
              <span>Tasks</span>
              <b>{taskCount}</b>
            </button>
            <button
              type="button"
              className={`${styles.filterTile} ${questionsOnly ? styles.filterTileActive : ""}`}
              aria-pressed={questionsOnly}
              onClick={onToggleQuestions}
            >
              <span className={`${styles.dot} ${styles.dotDanger}`} aria-hidden="true" />
              <span>Questions</span>
              <b>{questionCount}</b>
            </button>
            {decisionCount > 0 && (
              <button
                type="button"
                className={styles.filterTile}
                style={{ gridColumn: "1 / -1" }}
                onClick={onSelectTasks}
              >
                <span className={styles.dot} aria-hidden="true" />
                <span>Decisions</span>
                <b>{decisionCount}</b>
              </button>
            )}
          </div>
        )}
      </section>

      {/* Signals / Transcript Metrics (100% real data, never fabricated sentiment) */}
      <section className={styles.smartGroup} aria-label="Meeting signals">
        <button
          type="button"
          className={styles.smartGroupToggle}
          aria-expanded={openSignals}
          onClick={() => setOpenSignals((v) => !v)}
        >
          <span>{discussionSignals ? "Discussion Signals" : "Meeting Metrics"}</span>
          <WebIcon name={openSignals ? "chevronUp" : "chevronDown"} size={14} />
        </button>

        {openSignals && (
          <div className={styles.signalList}>
            {discussionSignals ? (
              <>
                <div className={styles.signalRow}>
                  <span className={styles.dot} aria-hidden="true" />
                  <span>On-topic</span>
                  <b>{discussionSignals.onTopicPct}%</b>
                </div>
                <div className={styles.signalRow}>
                  <span className={`${styles.dot} ${styles.dotBlue}`} aria-hidden="true" />
                  <span>Advancing</span>
                  <b>{discussionSignals.advancingPct}%</b>
                </div>
              </>
            ) : (
              <>
                <div className={styles.signalRow}>
                  <span className={styles.dot} aria-hidden="true" />
                  <span>Spoken time</span>
                  <b>{stats.totalDurationMs > 0 ? formatTalkDuration(stats.totalDurationMs) : "0s"}</b>
                </div>
                <div className={styles.signalRow}>
                  <span className={`${styles.dot} ${styles.dotBlue}`} aria-hidden="true" />
                  <span>Words transcribed</span>
                  <b>{stats.totalWords.toLocaleString()}</b>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/* Speaker Talk Time */}
      <section className={styles.smartGroup} aria-label="Speaker talk time">
        <button
          type="button"
          className={styles.smartGroupToggle}
          aria-expanded={openTalkTime}
          onClick={() => setOpenTalkTime((v) => !v)}
        >
          <span>Speaker Talk Time</span>
          <WebIcon name={openTalkTime ? "chevronUp" : "chevronDown"} size={14} />
        </button>

        {openTalkTime && (
          <>
            {stats.speakers.length === 0 ? (
              <p className={styles.trackerEmpty} style={{ padding: 0, textAlign: "left", alignItems: "flex-start" }}>
                <span>
                  {isLive
                    ? "Waiting for live transcript segments to calculate talk time."
                    : "No transcript segments recorded for this meeting yet."}
                </span>
              </p>
            ) : (
              <LucianSpeakerDonut
                speakers={stats.speakers}
                activeSpeaker={activeSpeaker}
                onSelectSpeaker={onSelectSpeaker}
              />
            )}
          </>
        )}
      </section>

      {/* Topic Trackers */}
      <section className={styles.smartGroup} aria-label="Topic trackers">
        <div className={styles.smartGroupHeadRow}>
          <button
            type="button"
            className={styles.smartGroupToggle}
            aria-expanded={openTrackers}
            onClick={() => setOpenTrackers((v) => !v)}
          >
            <span>Topic Trackers</span>
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Add topic tracker"
            title="Track a keyword in this meeting"
            onClick={() => {
              setOpenTrackers(true);
              setAddingTracker((v) => !v);
            }}
          >
            <WebIcon name="plus" size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={openTrackers ? "Collapse topic trackers" : "Expand topic trackers"}
            onClick={() => setOpenTrackers((v) => !v)}
          >
            <WebIcon name={openTrackers ? "chevronUp" : "chevronDown"} size={14} />
          </button>
        </div>

        {openTrackers && (
          <>
            {addingTracker && (
              <form className={styles.trackerForm} onSubmit={addTracker}>
                <input
                  type="text"
                  className={styles.trackerInput}
                  aria-label="New topic keyword"
                  placeholder="Keyword (e.g. pricing, launch)"
                  value={trackerDraft}
                  onChange={(e) => setTrackerDraft(e.target.value)}
                  autoFocus
                />
                <button type="submit" className={styles.primaryBtn} disabled={!trackerDraft.trim()}>
                  Add
                </button>
              </form>
            )}

            {trackers.length === 0 ? (
              <div className={styles.trackerEmpty}>
                <span className={styles.trackerHash} aria-hidden="true">
                  <WebIcon name="hash" size={14} />
                </span>
                <p>No topic tracker</p>
                <span>Track keywords across meetings to jump directly to mentions.</span>
              </div>
            ) : (
              <div className={styles.trackerList}>
                {trackers.map((item) => {
                  const active = activeTracker.toLowerCase() === item.term.toLowerCase();
                  return (
                    <div key={item.term} className={styles.trackerChipRow}>
                      <button
                        type="button"
                        className={styles.trackerChipBtn}
                        aria-pressed={active}
                        onClick={() => onSelectTracker(active ? "" : item.term)}
                      >
                        <WebIcon name="hash" size={13} />
                        <span>{item.term}</span>
                        <span className={styles.trackerCount}>{item.hits}</span>
                      </button>
                      {item.custom && (
                        <button
                          type="button"
                          className={styles.iconBtn}
                          aria-label={`Remove ${item.term}`}
                          onClick={() => removeTracker(item.term)}
                        >
                          <WebIcon name="close" size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    </aside>
  );
}
