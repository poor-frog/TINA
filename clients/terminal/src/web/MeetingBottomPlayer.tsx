"use client";
/** MeetingBottomPlayer — Studio-style docked bottom audio transport bar wired to TINA's real
 *  multi-fragment recording streams (`/api/recordings/{id}/master?type=audio`), with playback speed,
 *  ±10s jump, scrubber, download, bookmark/reviewed toggles, copy transcript, and Talk time toggle. */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { WebIcon } from "./Icons";
import type { MeetingAudioFragment, MeetingAudioPlayerHandle, MeetingAudioPosition } from "../canvas/MeetingAudioPlayer";
import styles from "./meetingDetail.module.css";

const SPEEDS = [1, 1.25, 1.5, 2] as const;

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export interface MeetingBottomPlayerHandle extends MeetingAudioPlayerHandle {
  togglePlay(): void;
}

export const MeetingBottomPlayer = forwardRef<
  MeetingBottomPlayerHandle,
  {
    fragments: MeetingAudioFragment[];
    audioLoading: boolean;
    audioMessage: string;
    isLive: boolean;
    fallbackDurationSec: number;
    starred: boolean;
    reviewed: boolean;
    copiedTranscript: boolean;
    smartSearchOpen: boolean;
    onToggleStar: () => void;
    onToggleReviewed: () => void;
    onCopyTranscript: () => void;
    onToggleSmartSearch: () => void;
    onPositionChange?: (position: MeetingAudioPosition) => void;
  }
>(function MeetingBottomPlayer(
  {
    fragments,
    audioLoading,
    audioMessage,
    isLive,
    fallbackDurationSec,
    starred,
    reviewed,
    copiedTranscript,
    smartSearchOpen,
    onToggleStar,
    onToggleReviewed,
    onCopyTranscript,
    onToggleSmartSearch,
    onPositionChange,
  },
  ref,
) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const playAfterLoad = useRef(false);

  const [fragmentIndex, setFragmentIndex] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [durations, setDurations] = useState<number[]>(() => fragments.map((f) => f.duration || 0));
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [error, setError] = useState("");

  useEffect(() => {
    setFragmentIndex(0);
    setCurrentTime(0);
    setPlaying(false);
    setError("");
    setDurations(fragments.map((f) => f.duration || 0));
  }, [fragments]);

  const fragment = fragments[fragmentIndex];
  const src = fragment?.src ?? "";
  const hasAudio = fragments.length > 0 && !!src;

  const offset = useMemo(
    () => durations.slice(0, fragmentIndex).reduce((sum, d) => sum + d, 0),
    [durations, fragmentIndex],
  );
  const totalDuration = useMemo(() => {
    const sum = durations.reduce((acc, d) => acc + d, 0);
    return sum > 0 ? sum : fallbackDurationSec;
  }, [durations, fallbackDurationSec]);

  const virtualTime = offset + currentTime;
  const progress = totalDuration > 0 ? Math.min(100, Math.max(0, (virtualTime / totalDuration) * 100)) : 0;

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, fragmentIndex]);

  const reportPosition = (index: number, seconds: number) => {
    const base = durations.slice(0, index).reduce((sum, d) => sum + d, 0);
    onPositionChange?.({ fragmentIndex: index, secondsInFragment: seconds, virtualTime: base + seconds });
  };

  const playElement = (audio: HTMLAudioElement) => {
    setError("");
    audio.playbackRate = speed;
    void audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => {
        setPlaying(false);
        setError("Audio playback was blocked or unavailable.");
      });
  };

  const seekToFragment = (index: number, seconds: number) => {
    const audio = audioRef.current;
    if (!audio || index < 0 || index >= fragments.length || !Number.isFinite(seconds) || seconds < 0) return;
    const limit = durations[index] > 0 ? Math.max(0, durations[index] - 0.05) : seconds;
    const target = Math.min(seconds, limit);
    setError("");
    reportPosition(index, target);
    if (index !== fragmentIndex) {
      pendingSeek.current = target;
      playAfterLoad.current = true;
      setLoading(true);
      setFragmentIndex(index);
      return;
    }
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      pendingSeek.current = target;
      playAfterLoad.current = true;
      setLoading(true);
      return;
    }
    audio.currentTime = target;
    setCurrentTime(target);
    playElement(audio);
  };

  const seekVirtual = (rawValue: number) => {
    if (!hasAudio) return;
    const clamped = Math.min(totalDuration || rawValue, Math.max(0, rawValue));
    let remaining = clamped;
    for (let index = 0; index < durations.length; index++) {
      const dur = durations[index] || totalDuration;
      if (remaining <= dur || index === durations.length - 1) {
        const audio = audioRef.current;
        if (!audio) return;
        const target = Math.max(0, remaining);
        if (index !== fragmentIndex) {
          pendingSeek.current = target;
          playAfterLoad.current = playing;
          setCurrentTime(target);
          setFragmentIndex(index);
          setLoading(true);
        } else if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
          pendingSeek.current = target;
          playAfterLoad.current = playing;
          setLoading(true);
        } else {
          audio.currentTime = target;
          setCurrentTime(target);
          reportPosition(index, target);
        }
        return;
      }
      remaining -= dur;
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !hasAudio) return;
    if (playing) audio.pause();
    else playElement(audio);
  };

  useImperativeHandle(ref, () => ({ seekToFragment, togglePlay }), [fragmentIndex, fragments, durations, playing, hasAudio, speed]);

  const onLoadedMetadata = (event: SyntheticEvent<HTMLAudioElement>) => {
    const audio = event.currentTarget;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (duration > 0) {
      setDurations((cur) => cur.map((val, i) => (i === fragmentIndex ? duration : val)));
    }
    audio.playbackRate = speed;
    setLoading(false);
    setError("");
    if (pendingSeek.current !== null) {
      const target = pendingSeek.current;
      pendingSeek.current = null;
      audio.currentTime = target;
      setCurrentTime(target);
      reportPosition(fragmentIndex, target);
      if (playAfterLoad.current) {
        playAfterLoad.current = false;
        playElement(audio);
      }
    }
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[(idx + 1) % SPEEDS.length]);
  };

  const statusNote = error
    ? error
    : isLive
      ? "Recording in progress"
      : audioLoading
        ? "Preparing recording…"
        : !hasAudio
          ? audioMessage || "No audio recording"
          : "";

  return (
    <footer className={styles.playerBar} aria-label="Meeting recording player">
      {hasAudio && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={(e) => {
            const sec = e.currentTarget.currentTime;
            setCurrentTime(sec);
            reportPosition(fragmentIndex, sec);
          }}
          onCanPlay={() => {
            setLoading(false);
            setError("");
          }}
          onWaiting={() => setLoading(true)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            if (fragmentIndex < fragments.length - 1) {
              pendingSeek.current = 0;
              playAfterLoad.current = true;
              setCurrentTime(0);
              setLoading(true);
              setFragmentIndex((i) => i + 1);
            } else {
              setPlaying(false);
            }
          }}
          onError={() => {
            setLoading(false);
            setPlaying(false);
            setError("Recording could not be loaded.");
          }}
        />
      )}

      {/* Full-width top-edge scrubber */}
      <div className={styles.scrubberWrap}>
        <div className={styles.scrubberTrack} aria-hidden="true">
          <span className={styles.scrubberFill} style={{ width: `${progress}%` }} />
        </div>
        <input
          className={styles.scrubberRange}
          type="range"
          min={0}
          max={totalDuration || 1}
          step={0.1}
          value={Math.min(virtualTime, totalDuration || virtualTime)}
          aria-label="Seek in meeting recording"
          disabled={!hasAudio || !totalDuration}
          onChange={(e) => seekVirtual(Number(e.currentTarget.value))}
        />
      </div>

      <div className={styles.playerLeft}>
        <span>
          {formatClock(virtualTime)}{" "}
          <span className={styles.playerTotal}>/ {formatClock(totalDuration)}</span>
        </span>
        {statusNote && (
          <span className={styles.playerStatus} role="status">
            {statusNote}
          </span>
        )}
      </div>

      <div className={styles.playerCenter}>
        <button
          type="button"
          className={styles.speedBtn}
          disabled={!hasAudio}
          onClick={cycleSpeed}
          aria-label={`Playback speed ${speed}x`}
          title="Change playback speed"
        >
          {speed}×
        </button>

        <button
          type="button"
          className={styles.iconBtn}
          disabled={!hasAudio}
          aria-label="Rewind 10 seconds"
          title="Rewind 10 seconds"
          onClick={() => seekVirtual(virtualTime - 10)}
        >
          <WebIcon name="rotateCcw" size={17} />
        </button>

        <button
          type="button"
          className={styles.playBtn}
          disabled={!hasAudio || (loading && !playing)}
          aria-label={playing ? "Pause recording" : "Play recording"}
          onClick={togglePlay}
        >
          <WebIcon name={playing ? "pause" : "play"} size={15} />
        </button>

        <button
          type="button"
          className={styles.iconBtn}
          disabled={!hasAudio}
          aria-label="Forward 10 seconds"
          title="Forward 10 seconds"
          onClick={() => seekVirtual(virtualTime + 10)}
        >
          <WebIcon name="rotateCw" size={17} />
        </button>

        <button
          type="button"
          className={styles.iconBtn}
          disabled={!hasAudio}
          aria-label={muted ? "Unmute recording" : "Mute recording"}
          title={muted ? "Unmute" : "Mute"}
          onClick={() => {
            const audio = audioRef.current;
            if (!audio) return;
            audio.muted = !muted;
            setMuted(!muted);
          }}
        >
          <WebIcon name={muted ? "volumeX" : "volume"} size={16} />
        </button>

        {hasAudio ? (
          <a
            href={src}
            download
            className={styles.iconBtn}
            aria-label="Download recording audio"
            title="Download recording"
          >
            <WebIcon name="download" size={16} />
          </a>
        ) : (
          <button
            type="button"
            className={styles.iconBtn}
            disabled
            aria-label="Download recording unavailable"
          >
            <WebIcon name="download" size={16} />
          </button>
        )}
      </div>

      <div className={styles.playerRight}>
        <button
          type="button"
          className={`${styles.iconBtn} ${smartSearchOpen ? styles.iconBtnActive : ""}`}
          aria-label="Talk time"
          aria-expanded={smartSearchOpen}
          title={smartSearchOpen ? "Hide Smart Search & Talk time" : "Show Smart Search & Talk time"}
          onClick={onToggleSmartSearch}
        >
          <WebIcon name="chart" size={16} />
        </button>

        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Copy transcript"
          title={copiedTranscript ? "Transcript copied" : "Copy full transcript"}
          onClick={onCopyTranscript}
        >
          <WebIcon name={copiedTranscript ? "check" : "copy"} size={16} />
        </button>

        <button
          type="button"
          className={`${styles.iconBtn} ${starred ? styles.starredBtn : ""}`}
          aria-label={starred ? "Remove bookmark" : "Bookmark meeting"}
          aria-pressed={starred}
          title={starred ? "Bookmarked" : "Bookmark meeting"}
          onClick={onToggleStar}
        >
          <WebIcon name="star" size={16} />
        </button>

        <button
          type="button"
          className={`${styles.iconBtn} ${reviewed ? styles.doneBtnActive : ""}`}
          aria-label={reviewed ? "Mark meeting not reviewed" : "Mark meeting reviewed"}
          aria-pressed={reviewed}
          title={reviewed ? "Marked reviewed" : "Mark reviewed"}
          onClick={onToggleReviewed}
        >
          <WebIcon name="checkSquare" size={16} />
        </button>
      </div>
    </footer>
  );
});
