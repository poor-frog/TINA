"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { LoaderCircle, Pause, Play, Volume2, VolumeX } from "lucide-react";
import styles from "./MeetingAudioPlayer.module.css";

export interface MeetingAudioFragment {
  src: string;
  duration: number;
  sessionUid?: string;
  audioStartMs?: number;
  createdAt?: string;
}

export interface MeetingAudioPosition {
  fragmentIndex: number;
  secondsInFragment: number;
  virtualTime: number;
}

export interface MeetingAudioPlayerHandle {
  seekToFragment(fragmentIndex: number, secondsInFragment: number): void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export const MeetingAudioPlayer = forwardRef<MeetingAudioPlayerHandle, {
  fragments: MeetingAudioFragment[];
  onPositionChange?: (position: MeetingAudioPosition) => void;
}>(function MeetingAudioPlayer({ fragments, onPositionChange }, ref) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const playAfterLoad = useRef(false);
  const [fragmentIndex, setFragmentIndex] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [durations, setDurations] = useState(() => fragments.map((fragment) => fragment.duration || 0));
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDurations((current) => fragments.map((item, index) => item.duration || current[index] || 0));
  }, [fragments]);
  const fragment = fragments[fragmentIndex];
  const src = fragment?.src ?? "";
  const offset = useMemo(() => durations.slice(0, fragmentIndex).reduce((sum, duration) => sum + duration, 0), [durations, fragmentIndex]);
  const totalDuration = useMemo(() => durations.reduce((sum, duration) => sum + duration, 0), [durations]);
  const virtualTime = offset + currentTime;
  const progress = totalDuration > 0 ? Math.min(100, Math.max(0, virtualTime / totalDuration * 100)) : 0;

  const reportPosition = (index: number, seconds: number) => {
    const base = durations.slice(0, index).reduce((sum, duration) => sum + duration, 0);
    onPositionChange?.({ fragmentIndex: index, secondsInFragment: seconds, virtualTime: base + seconds });
  };

  const play = (audio: HTMLAudioElement) => {
    setError("");
    void audio.play().then(() => setPlaying(true)).catch(() => {
      setPlaying(false);
      setError("Could not play this recording. Try again or review a transcript segment.");
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
    play(audio);
  };

  useImperativeHandle(ref, () => ({ seekToFragment }), [fragmentIndex, fragments, durations]);

  const onLoadedMetadata = (event: SyntheticEvent<HTMLAudioElement>) => {
    const audio = event.currentTarget;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (duration > 0) setDurations((current) => current.map((value, index) => index === fragmentIndex ? duration : value));
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
        play(audio);
      }
    }
  };

  const seekVirtual = (value: number) => {
    let remaining = value;
    for (let index = 0; index < durations.length; index++) {
      if (remaining <= durations[index] || index === durations.length - 1) {
        const audio = audioRef.current;
        if (!audio) return;
        if (index !== fragmentIndex) {
          const target = Math.max(0, remaining);
          pendingSeek.current = target;
          playAfterLoad.current = playing;
          setCurrentTime(target);
          setFragmentIndex(index);
          setLoading(true);
        } else {
          const target = Math.max(0, remaining);
          if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
            pendingSeek.current = target;
            playAfterLoad.current = playing;
            setLoading(true);
            return;
          }
          audio.currentTime = target;
          setCurrentTime(target);
          reportPosition(index, target);
        }
        return;
      }
      remaining -= durations[index];
    }
  };

  return (
    <div className={styles.player} aria-label="Meeting recording player">
      <audio
        ref={audioRef}
        src={src || undefined}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={(event) => {
          const seconds = event.currentTarget.currentTime;
          setCurrentTime(seconds);
          reportPosition(fragmentIndex, seconds);
        }}
        onCanPlay={() => { setLoading(false); setError(""); }}
        onWaiting={() => setLoading(true)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (fragmentIndex < fragments.length - 1) {
            pendingSeek.current = 0;
            playAfterLoad.current = true;
            setCurrentTime(0);
            setLoading(true);
            setFragmentIndex((index) => index + 1);
          } else {
            setPlaying(false);
          }
        }}
        onError={() => { setLoading(false); setPlaying(false); setError("This meeting recording could not be loaded."); }}
      />
      <div className={styles.scrubber}>
        <div className={styles.track} aria-hidden="true"><span className={styles.progress} style={{ width: `${progress}%` }} /></div>
        <input
          className={styles.seek}
          type="range"
          min={0}
          max={totalDuration}
          step={0.1}
          value={Math.min(virtualTime, totalDuration || virtualTime)}
          aria-label="Seek in meeting recording"
          disabled={!totalDuration}
          onChange={(event) => seekVirtual(Number(event.currentTarget.value))}
        />
      </div>
      <div className={styles.controls}>
        <button type="button" className={`${styles.iconButton} ${styles.playButton}`} aria-label={playing ? "Pause recording" : "Play recording"} disabled={loading && !playing} onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (playing) audio.pause(); else play(audio);
        }}>
          {loading && !playing ? <LoaderCircle className={styles.spinner} size={16} /> : playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className={styles.timeCurrent}>{formatTime(virtualTime)}</span>
        <span className={styles.timeDivider} aria-hidden="true">/</span>
        <span className={styles.time}>{formatTime(totalDuration)}</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.iconButton} aria-label={muted ? "Unmute recording" : "Mute recording"} onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          audio.muted = !muted;
          setMuted(!muted);
        }}>
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>
      {error && <span className={styles.error} role="status">{error}</span>}
    </div>
  );
});
