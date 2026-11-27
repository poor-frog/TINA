"use client";
// Lucian UX/UI Prompt #476 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#476
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./lucian-476.css";

interface WordTiming {
  word: string;
  space: string;
  start: number;
  dur: number;
}

const MAX_CACHED_AUDIO_BLOBS = 25;
const audioBlobCache = new Map<string, Blob>();
let activePlayerStopper: (() => void) | null = null;

function getCachedAudioBlob(key: string): Blob | undefined {
  const hit = audioBlobCache.get(key);
  if (!hit) return undefined;
  audioBlobCache.delete(key);
  audioBlobCache.set(key, hit);
  return hit;
}

function putCachedAudioBlob(key: string, blob: Blob): void {
  if (audioBlobCache.has(key)) audioBlobCache.delete(key);
  audioBlobCache.set(key, blob);
  while (audioBlobCache.size > MAX_CACHED_AUDIO_BLOBS) {
    const oldest = audioBlobCache.keys().next().value;
    if (oldest === undefined) break;
    audioBlobCache.delete(oldest);
  }
}

export function clearReadAloudAudioCache(): void {
  audioBlobCache.clear();
  activePlayerStopper = null;
}

function claimActivePlayer(stopSelf: () => void): void {
  if (activePlayerStopper && activePlayerStopper !== stopSelf) {
    activePlayerStopper();
  }
  activePlayerStopper = stopSelf;
}

function releaseActivePlayer(stopSelf: () => void): void {
  if (activePlayerStopper === stopSelf) {
    activePlayerStopper = null;
  }
}

function buildTimings(text: string): { words: WordTiming[]; totalMs: number } {
  const parts = text.trim().split(/(\s+)/);
  const words: WordTiming[] = [];
  let at = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const word = parts[i] ?? "";
    const space = parts[i + 1] ?? "";
    if (!word) continue;
    const latin = (word.match(/[A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
    const cjk = (word.match(/[\uAC00-\uD7A3\u4E00-\u9FFF]/g) || []).length;
    const dur = 150 + 62 * cjk + 34 * latin;
    const gap = /[.!?]$/.test(word) ? 320 : /[,;:]$/.test(word) ? 150 : 0;
    words.push({ word, space, start: at, dur });
    at += dur + gap;
  }
  return { words, totalMs: Math.max(400, at) };
}

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function extractAudioError(res: Response): Promise<string> {
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail.trim()) {
        return body.detail.trim();
      }
    } catch {
      /* fall back to status-based message */
    }
  }
  if (res.status === 404) {
    return "Không tìm thấy âm thanh cho câu trả lời này.";
  }
  if (res.status === 503 || res.status === 504 || res.status === 429) {
    return "Dịch vụ giọng đọc VieNeu đang bận hoặc tạm thời chưa sẵn sàng. Vui lòng thử lại.";
  }
  return "Chưa thể phát giọng đọc VieNeu. Vui lòng thử lại.";
}

export function LucianReadAloud({
  text,
  textClassName,
  showControls = true,
  externalProgress,
  isExternallyPlaying = false,
  audioUrl,
  highlighted = false,
}: {
  text: string;
  textClassName?: string;
  showControls?: boolean;
  /** Optional 0..1 progress driven by external audio playback (e.g., MeetingBottomPlayer). */
  externalProgress?: number;
  isExternallyPlaying?: boolean;
  /** Authenticated endpoint returning audio/wav synthesized by VieNeu TTS. */
  audioUrl?: string;
  /** @deprecated Browser auto-play is intentionally disabled for VieNeu audio playback. */
  autoPlay?: boolean;
  highlighted?: boolean;
}) {
  const { words, totalMs } = useMemo(() => buildTimings(text), [text]);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioElapsedMs, setAudioElapsedMs] = useState(0);
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingSeekRatioRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const cacheKey = audioUrl ? `${audioUrl}\0${text}` : "";
  const isExternal = typeof externalProgress === "number";
  const displayDurationMs = audioDurationMs ?? totalMs;
  const localRatio =
    displayDurationMs > 0 ? Math.min(1, Math.max(0, audioElapsedMs / displayDurationMs)) : 0;
  const ratio = isExternal ? Math.max(0, Math.min(1, externalProgress)) : localRatio;
  const effectiveElapsed = ratio * totalMs;
  const isActiveMode = isExternal || engaged;
  const effectivePlaying = isExternal ? isExternallyPlaying : playing;

  const pauseSelf = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    pendingSeekRatioRef.current = null;
    const el = audioRef.current;
    if (el && !el.paused) {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
    }
    if (mountedRef.current) {
      setLoading(false);
      setPlaying(false);
    }
  }, []);

  const disposeAudio = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    pendingSeekRatioRef.current = null;
    releaseActivePlayer(pauseSelf);
    const el = audioRef.current;
    if (el) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load?.();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {
        /* ignore */
      }
      objectUrlRef.current = null;
    }
    loadedKeyRef.current = null;
  }, [pauseSelf]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposeAudio();
    };
  }, [disposeAudio]);

  // Reset audio element if the target audio URL or reply text changes
  useEffect(() => {
    disposeAudio();
    setPlaying(false);
    setLoading(false);
    setError(null);
    setAudioElapsedMs(0);
    setAudioDurationMs(null);
  }, [cacheKey, disposeAudio]);

  // Keep karaoke highlight & elapsed time synced smoothly to the real <audio> clock
  useEffect(() => {
    if (isExternal || !playing) return;
    const syncClock = () => {
      const el = audioRef.current;
      if (!el) return;
      if (Number.isFinite(el.duration) && el.duration > 0) {
        const durMs = Math.round(el.duration * 1000);
        setAudioDurationMs((prev) => (prev === durMs ? prev : durMs));
        setAudioElapsedMs(Math.min(durMs, Math.max(0, Math.round(el.currentTime * 1000))));
      } else {
        setAudioElapsedMs(Math.max(0, Math.round(el.currentTime * 1000)));
      }
    };

    const reduced = prefersReducedMotion();
    let raf = 0;
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function" && !reduced) {
      const tick = () => {
        syncClock();
        raf = window.requestAnimationFrame(tick);
      };
      raf = window.requestAnimationFrame(tick);
      return () => {
        if (raf) window.cancelAnimationFrame(raf);
      };
    }
    const iv = window.setInterval(syncClock, 120);
    return () => window.clearInterval(iv);
  }, [isExternal, playing]);

  const attachBlobToAudio = useCallback(
    (blob: Blob, key: string): HTMLAudioElement => {
      disposeAudio();
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      loadedKeyRef.current = key;
      const el = new Audio(objectUrl);
      el.preload = "auto";

      const updateDuration = () => {
        if (!mountedRef.current) return;
        if (Number.isFinite(el.duration) && el.duration > 0) {
          const durMs = Math.round(el.duration * 1000);
          setAudioDurationMs(durMs);
          if (pendingSeekRatioRef.current !== null) {
            const seekSec = Math.max(0, Math.min(el.duration, pendingSeekRatioRef.current * el.duration));
            pendingSeekRatioRef.current = null;
            el.currentTime = seekSec;
            setAudioElapsedMs(Math.round(seekSec * 1000));
          }
        }
      };

      el.addEventListener("loadedmetadata", updateDuration);
      el.addEventListener("durationchange", updateDuration);
      el.addEventListener("timeupdate", () => {
        if (!mountedRef.current) return;
        setAudioElapsedMs(Math.max(0, Math.round(el.currentTime * 1000)));
      });
      el.addEventListener("ended", () => {
        if (!mountedRef.current) return;
        const durMs = Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : totalMs;
        setAudioElapsedMs(durMs);
        setPlaying(false);
        releaseActivePlayer(pauseSelf);
      });
      el.addEventListener("pause", () => {
        if (!mountedRef.current) return;
        if (!el.ended) {
          setPlaying(false);
          releaseActivePlayer(pauseSelf);
        }
      });
      el.addEventListener("error", () => {
        if (!mountedRef.current) return;
        setLoading(false);
        setPlaying(false);
        setError("Không thể phát âm thanh VieNeu. Vui lòng thử lại.");
        releaseActivePlayer(pauseSelf);
      });

      audioRef.current = el;
      return el;
    },
    [disposeAudio, pauseSelf, totalMs]
  );

  const playElement = useCallback(
    async (el: HTMLAudioElement) => {
      claimActivePlayer(pauseSelf);
      if (Number.isFinite(el.duration) && el.duration > 0) {
        const durMs = Math.round(el.duration * 1000);
        setAudioDurationMs(durMs);
        if (pendingSeekRatioRef.current !== null) {
          const seekSec = Math.max(0, Math.min(el.duration, pendingSeekRatioRef.current * el.duration));
          pendingSeekRatioRef.current = null;
          el.currentTime = seekSec;
          setAudioElapsedMs(Math.round(seekSec * 1000));
        } else if (el.ended || el.currentTime >= el.duration - 0.05) {
          el.currentTime = 0;
          setAudioElapsedMs(0);
        }
      }
      try {
        await el.play();
        if (!mountedRef.current) return;
        setLoading(false);
        setError(null);
        setPlaying(true);
      } catch {
        if (!mountedRef.current) return;
        setLoading(false);
        setPlaying(false);
        setError("Trình duyệt chưa phát được âm thanh VieNeu. Vui lòng thử lại.");
        releaseActivePlayer(pauseSelf);
      }
    },
    [pauseSelf]
  );

  const startPlayback = useCallback(
    async (seekRatio?: number) => {
      if (!audioUrl) {
        setError("Chưa có nguồn âm thanh VieNeu cho câu trả lời này.");
        return;
      }
      setEngaged(true);
      setError(null);
      if (typeof seekRatio === "number") {
        pendingSeekRatioRef.current = Math.max(0, Math.min(1, seekRatio));
      }
      claimActivePlayer(pauseSelf);

      if (audioRef.current && loadedKeyRef.current === cacheKey) {
        await playElement(audioRef.current);
        return;
      }

      const cached = getCachedAudioBlob(cacheKey);
      if (cached) {
        const el = attachBlobToAudio(cached, cacheKey);
        await playElement(el);
        return;
      }

      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      setLoading(true);
      try {
        const res = await fetch(audioUrl, { cache: "no-store", signal: abort.signal });
        if (abort.signal.aborted || !mountedRef.current) return;
        if (!res.ok) {
          const msg = await extractAudioError(res);
          if (abort.signal.aborted || !mountedRef.current) return;
          setLoading(false);
          setPlaying(false);
          setError(msg);
          releaseActivePlayer(pauseSelf);
          return;
        }
        const contentType = (res.headers.get("Content-Type") || "").toLowerCase();
        if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
          setLoading(false);
          setPlaying(false);
          setError("Phản hồi âm thanh VieNeu không hợp lệ. Vui lòng thử lại.");
          releaseActivePlayer(pauseSelf);
          return;
        }
        const blob = await res.blob();
        if (abort.signal.aborted || !mountedRef.current) return;
        if (!blob || blob.size === 0) {
          setLoading(false);
          setPlaying(false);
          setError("Âm thanh VieNeu trống. Vui lòng thử lại.");
          releaseActivePlayer(pauseSelf);
          return;
        }
        putCachedAudioBlob(cacheKey, blob);
        const el = attachBlobToAudio(blob, cacheKey);
        await playElement(el);
      } catch {
        if (abort.signal.aborted || !mountedRef.current) return;
        setLoading(false);
        setPlaying(false);
        setError("Không thể kết nối dịch vụ giọng đọc VieNeu. Vui lòng thử lại.");
        releaseActivePlayer(pauseSelf);
      } finally {
        if (abortRef.current === abort) {
          abortRef.current = null;
        }
      }
    },
    [attachBlobToAudio, audioUrl, cacheKey, pauseSelf, playElement]
  );

  const togglePlay = () => {
    if (loading) {
      pauseSelf();
      releaseActivePlayer(pauseSelf);
      return;
    }
    if (playing) {
      pauseSelf();
      releaseActivePlayer(pauseSelf);
      return;
    }
    void startPlayback();
  };

  const jumpToWord = (wordIndex: number) => {
    if (isExternal || !audioUrl) return;
    const target = words[wordIndex];
    if (!target) return;
    const targetRatio = totalMs > 0 ? target.start / totalMs : 0;
    void startPlayback(targetRatio);
  };

  const formattedTotal =
    audioDurationMs !== null
      ? fmtMs(Math.max(1000, Math.ceil(audioDurationMs / 1000) * 1000))
      : fmtMs(totalMs + 999);

  return (
    <div
      className={`ux u476 ${effectivePlaying ? "is-play" : ""} ${loading ? "is-load" : ""}`}
      data-testid="lucian-read-aloud"
    >
      {showControls && !isExternal && (
        <div className="u476-hd">
          <button
            type="button"
            className="u476-pl"
            aria-label={loading ? "Cancel loading audio" : playing ? "Pause read aloud" : "Read aloud"}
            aria-busy={loading}
            title={loading ? "Đang tạo giọng VieNeu…" : playing ? "Tạm dừng" : "Nghe giọng VieNeu"}
            style={{ "--u476-t": (loading ? 0.35 : ratio).toFixed(4) } as React.CSSProperties}
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
          >
            <svg className="u476-rg" viewBox="0 0 44 44" aria-hidden="true">
              <circle cx="22" cy="22" r="21" />
            </svg>
            <span className="u476-ic" aria-hidden="true">
              <i />
              <i />
            </span>
          </button>
          <span className="u476-lb">
            {loading ? "Loading…" : playing ? "Playing…" : "Listen"}
          </span>
          <span className="u476-tm" aria-hidden="true">
            {fmtMs(isExternal ? effectiveElapsed : audioElapsedMs)} / {formattedTotal}
          </span>
        </div>
      )}

      {error && showControls && !isExternal && (
        <div className="u476-err" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="u476-retry"
            onClick={(e) => {
              e.stopPropagation();
              void startPlayback();
            }}
          >
            Thử lại
          </button>
        </div>
      )}

      {!isActiveMode ? (
        <p className={`${textClassName ?? "u476-tx"} u220-s ${highlighted ? "is-hl" : ""}`}>
          {text}
        </p>
      ) : (
        <p className={`${textClassName ?? "u476-tx"} u476-tx is-karaoke u220-s ${highlighted ? "is-hl" : ""}`}>
          {words.map((item, idx) => {
            const p = Math.max(0, Math.min(1, (effectiveElapsed - item.start) / item.dur));
            const isDone = p >= 1;
            const isNow =
              effectivePlaying &&
              effectiveElapsed >= item.start &&
              effectiveElapsed < item.start + item.dur;
            return (
              <span
                key={`${idx}-${item.word}`}
                className={`u476-w ${isDone ? "is-done" : ""} ${isNow ? "is-now" : ""}`}
                style={p > 0 && p < 1 ? ({ "--u476-p": p.toFixed(3) } as React.CSSProperties) : undefined}
                onClick={(e) => {
                  if (isExternal) return;
                  e.stopPropagation();
                  jumpToWord(idx);
                }}
              >
                {item.word}
                {item.space}
              </span>
            );
          })}
        </p>
      )}
    </div>
  );
}
