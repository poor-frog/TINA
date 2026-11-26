"use client";
// Lucian UX/UI Prompt #476 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#476
import { useEffect, useMemo, useRef, useState } from "react";
import "./lucian-476.css";

interface WordTiming {
  word: string;
  space: string;
  start: number;
  dur: number;
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

export function LucianReadAloud({
  text,
  textClassName,
  showControls = true,
  externalProgress,
  isExternallyPlaying = false,
  autoPlay = false,
  highlighted = false,
}: {
  text: string;
  textClassName?: string;
  showControls?: boolean;
  /** Optional 0..1 progress driven by external audio playback (e.g., MeetingBottomPlayer). */
  externalProgress?: number;
  isExternallyPlaying?: boolean;
  autoPlay?: boolean;
  highlighted?: boolean;
}) {
  const { words, totalMs } = useMemo(() => buildTimings(text), [text]);
  const [playing, setPlaying] = useState(autoPlay);
  const [engaged, setEngaged] = useState(autoPlay);
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedRef = useRef(0);
  const lastFrameRef = useRef(0);

  const isExternal = typeof externalProgress === "number";
  const effectiveElapsed = isExternal ? Math.max(0, Math.min(1, externalProgress)) * totalMs : elapsedMs;
  const isActiveMode = isExternal || engaged;
  const effectivePlaying = isExternal ? isExternallyPlaying : playing;

  useEffect(() => {
    if (isExternal) return;
    if (!playing) {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const reduced = prefersReducedMotion();
    let raf = 0;
    lastFrameRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();

    const tick = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - lastFrameRef.current));
      lastFrameRef.current = now;
      elapsedRef.current = Math.min(totalMs, elapsedRef.current + dt);
      setElapsedMs(elapsedRef.current);
      if (elapsedRef.current >= totalMs) {
        setPlaying(false);
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };

    if (typeof window.requestAnimationFrame === "function" && !reduced) {
      raf = window.requestAnimationFrame(tick);
    } else {
      const iv = window.setInterval(() => {
        elapsedRef.current = Math.min(totalMs, elapsedRef.current + 120);
        setElapsedMs(elapsedRef.current);
        if (elapsedRef.current >= totalMs) {
          window.clearInterval(iv);
          setPlaying(false);
        }
      }, 120);
      return () => window.clearInterval(iv);
    }

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [playing, totalMs, isExternal]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const togglePlay = () => {
    setEngaged(true);
    if (!playing && elapsedRef.current >= totalMs) {
      elapsedRef.current = 0;
      setElapsedMs(0);
    }
    const next = !playing;
    setPlaying(next);
    if (next && typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined") {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        window.speechSynthesis.speak(utter);
      } catch {
        /* ignore browsers blocking speechSynthesis */
      }
    }
  };

  const jumpToWord = (wordIndex: number) => {
    if (isExternal) return;
    const target = words[wordIndex];
    if (!target) return;
    setEngaged(true);
    elapsedRef.current = target.start;
    setElapsedMs(target.start);
    setPlaying(true);
  };

  const ratio = totalMs > 0 ? Math.min(1, Math.max(0, effectiveElapsed / totalMs)) : 0;

  return (
    <div
      className={`ux u476 ${effectivePlaying ? "is-play" : ""}`}
      data-testid="lucian-read-aloud"
    >
      {showControls && !isExternal && (
        <div className="u476-hd">
          <button
            type="button"
            className="u476-pl"
            aria-label={playing ? "Pause read aloud" : "Read aloud"}
            title={playing ? "Pause read aloud" : "Listen word by word"}
            style={{ "--u476-t": ratio.toFixed(4) } as React.CSSProperties}
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
          <span className="u476-lb">{playing ? "Reading…" : "Listen"}</span>
          <span className="u476-tm" aria-hidden="true">
            {fmtMs(effectiveElapsed)} / {fmtMs(totalMs + 999)}
          </span>
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
