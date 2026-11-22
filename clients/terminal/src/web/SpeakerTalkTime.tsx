"use client";
/** SpeakerTalkTime — Real per-speaker talk time, word pace (WPM), and share statistics computed
 *  directly from durable TINA transcript segments (`/api/transcripts/by-id/{meetingId}`). */
import { useCallback, useEffect, useMemo, useState } from "react";
import { WebIcon } from "./Icons";
import { fetchDurableTranscript } from "../surfaces/liveMeetings";
import type { MeetingMock, TranscriptLine } from "../surfaces/meetingModel";

export interface SpeakerTalkStat {
  speaker: string;
  durationMs: number;
  sharePct: number;
  words: number;
  wpm: number;
  turns: number;
  color: string;
}

export interface MeetingTalkSummary {
  speakers: SpeakerTalkStat[];
  totalDurationMs: number;
  totalWords: number;
  totalSegments: number;
  avgWpm: number;
}

const SPEAKER_RING_COLORS = [
  "#91d7be", // Tina quiet mint
  "#3bb29b", // Tina bright teal
  "#e2b278", // warm champagne gold
  "#7da8e8", // calm slate blue
  "#c69cf4", // soft lavender
  "#e8958f", // muted coral
];

const MAX_SEGMENT_DURATION_MS = 10 * 60_000;
const FALLBACK_WPM = 145;

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function estimateSegmentDurationMs(line: TranscriptLine, words: number): number {
  if (
    typeof line.tsMs === "number" &&
    typeof line.endTsMs === "number" &&
    Number.isFinite(line.tsMs) &&
    Number.isFinite(line.endTsMs) &&
    line.endTsMs > line.tsMs
  ) {
    return Math.min(line.endTsMs - line.tsMs, MAX_SEGMENT_DURATION_MS);
  }
  if (words <= 0) return 0;
  return Math.max(1200, Math.round((words / FALLBACK_WPM) * 60_000));
}

export function formatTalkDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

export function computeSpeakerStats(lines: TranscriptLine[]): MeetingTalkSummary {
  const bySpeaker = new Map<string, { durationMs: number; words: number; turns: number }>();

  for (const line of lines) {
    const words = countWords(line.text || "");
    const durMs = estimateSegmentDurationMs(line, words);
    if (words === 0 && durMs === 0) continue;
    const speaker = (line.speaker || "").trim() || "Speaker";
    const cur = bySpeaker.get(speaker) ?? { durationMs: 0, words: 0, turns: 0 };
    cur.durationMs += durMs;
    cur.words += words;
    cur.turns += 1;
    bySpeaker.set(speaker, cur);
  }

  const entries = [...bySpeaker.entries()].sort((a, b) => b[1].durationMs - a[1].durationMs || b[1].words - a[1].words);
  const totalDurationMs = entries.reduce((sum, [, v]) => sum + v.durationMs, 0);
  const totalWords = entries.reduce((sum, [, v]) => sum + v.words, 0);
  const totalSegments = entries.reduce((sum, [, v]) => sum + v.turns, 0);

  const speakers: SpeakerTalkStat[] = entries.map(([speaker, v], index) => {
    const sharePct = totalDurationMs > 0
      ? Math.round((v.durationMs / totalDurationMs) * 100)
      : totalWords > 0
        ? Math.round((v.words / totalWords) * 100)
        : 0;
    const mins = v.durationMs / 60_000;
    const wpm = mins >= 0.05 ? Math.round(v.words / mins) : 0;
    return {
      speaker,
      durationMs: v.durationMs,
      sharePct,
      words: v.words,
      wpm,
      turns: v.turns,
      color: SPEAKER_RING_COLORS[index % SPEAKER_RING_COLORS.length],
    };
  });

  const totalMins = totalDurationMs / 60_000;
  const avgWpm = totalMins >= 0.05 ? Math.round(totalWords / totalMins) : 0;

  return {
    speakers,
    totalDurationMs,
    totalWords,
    totalSegments,
    avgWpm,
  };
}

export function SpeakerTalkTimePanel({
  meetingId,
  meeting,
  isLive,
}: {
  meetingId: string;
  meeting?: MeetingMock;
  isLive: boolean;
}) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    else setRefreshing(true);
    try {
      const durable = await fetchDurableTranscript(meetingId);
      setLines(durable.lines);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [meetingId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!isLive) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [isLive, load]);

  const stats = useMemo(() => computeSpeakerStats(lines), [lines]);

  return (
    <aside className="tina-web-detail-insights" aria-label="Speaker talk time and meeting metrics">
      <div className="tina-web-insights-head">
        <div>
          <h2>Talk time &amp; metrics</h2>
          <p>{isLive ? "Updates from live transcript" : "Computed from meeting transcript"}</p>
        </div>
        <button
          type="button"
          className="tina-web-icon-btn"
          onClick={() => void load(true)}
          disabled={refreshing}
          title="Refresh speaker metrics"
          aria-label="Refresh speaker metrics"
        >
          <WebIcon name="refresh" size={14} />
        </button>
      </div>

      <div className="tina-web-metrics-grid">
        <div className="tina-web-metric-box">
          <span>Spoken time</span>
          <strong>{stats.totalDurationMs > 0 ? formatTalkDuration(stats.totalDurationMs) : "—"}</strong>
        </div>
        <div className="tina-web-metric-box">
          <span>Avg pace</span>
          <strong>{stats.avgWpm > 0 ? `${stats.avgWpm} wpm` : "—"}</strong>
        </div>
        <div className="tina-web-metric-box">
          <span>Speakers</span>
          <strong>{stats.speakers.length || meeting?.participants.length || 0}</strong>
        </div>
        <div className="tina-web-metric-box">
          <span>Words</span>
          <strong>{stats.totalWords > 0 ? stats.totalWords.toLocaleString() : "—"}</strong>
        </div>
      </div>

      <div className="tina-web-insights-section">
        <div className="tina-web-subblock-label">Speaker breakdown</div>
        {loading ? (
          <p className="tina-web-muted-note">Calculating speaker talk time…</p>
        ) : stats.speakers.length === 0 ? (
          <p className="tina-web-muted-note">
            {isLive
              ? "Waiting for transcript segments to calculate talk time."
              : "No transcript segments available for this meeting yet."}
          </p>
        ) : (
          <div className="tina-web-speaker-list">
            {stats.speakers.map((item) => (
              <div key={item.speaker} className="tina-web-speaker-card">
                <div className="tina-web-speaker-top">
                  <div
                    className="tina-web-speaker-ring"
                    style={{
                      background: `conic-gradient(${item.color} ${item.sharePct}%, var(--tw-line-strong) 0)`,
                    }}
                    aria-hidden="true"
                  >
                    <span>{item.sharePct}%</span>
                  </div>
                  <div className="tina-web-speaker-meta">
                    <strong title={item.speaker}>{item.speaker}</strong>
                    <span>
                      {formatTalkDuration(item.durationMs)} · {item.turns} {item.turns === 1 ? "turn" : "turns"}
                    </span>
                  </div>
                  {item.wpm > 0 && <span className="tina-web-speaker-wpm">{item.wpm} wpm</span>}
                </div>
                <div className="tina-web-speaker-bar-track" aria-hidden="true">
                  <div
                    className="tina-web-speaker-bar-fill"
                    style={{ width: `${Math.max(item.sharePct, 2)}%`, background: item.color }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {meeting && meeting.participants.length > 0 && (
        <div className="tina-web-insights-section">
          <div className="tina-web-subblock-label">Participants ({meeting.participants.length})</div>
          <div className="tina-web-participant-chips">
            {meeting.participants.map((p, idx) => (
              <span key={`${p.name}-${idx}`} className="tina-web-participant-chip">
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
