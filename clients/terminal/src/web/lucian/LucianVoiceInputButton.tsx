"use client";
// Lucian UX/UI Prompt #457 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#457
import { useEffect, useRef, useState } from "react";
import "./lucian-457.css";

const BAR_COUNT = 16;
const IDLE_W = 34;
const REC_W = 214;
const PILL_H = 34;

function formatElapsed(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface LucianVoiceInputButtonProps {
  recording: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onCancel?: () => void;
}

export function LucianVoiceInputButton({
  recording,
  disabled = false,
  onToggle,
  onCancel,
}: LucianVoiceInputButtonProps) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const waveRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const waveEl = waveRef.current;
    if (!recording) {
      setElapsedSec(0);
      if (waveEl) {
        Array.from(waveEl.children).forEach((child) => {
          (child as HTMLElement).style.transform = "scaleY(.12)";
        });
      }
      return;
    }

    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const clock = window.setInterval(() => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      setElapsedSec(Math.floor((now - t0) / 1000));
    }, 250);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        (onCancel ?? onToggle)();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    const reduced = prefersReducedMotion();
    const bars = waveEl ? (Array.from(waveEl.children) as HTMLElement[]) : [];
    const levels = bars.map(() => 0.12);
    let raf = 0;

    if (reduced) {
      bars.forEach((bar, i) => {
        bar.style.transform = `scaleY(${(0.3 + 0.4 * Math.abs(Math.sin(i * 1.3))).toFixed(2)})`;
      });
    } else if (typeof window.requestAnimationFrame === "function" && bars.length > 0) {
      const tick = (now: number) => {
        const t = (now - t0) / 1000;
        const env = 0.18 + 0.82 * Math.pow(Math.abs(Math.sin(t * 2.4) * Math.sin(t * 3.9 + 1.2)), 0.55);
        for (let i = 0; i < bars.length; i++) {
          const mid = 1 - (Math.abs(i - (bars.length - 1) / 2) / (bars.length / 2)) * 0.5;
          const n = 0.5 + 0.5 * Math.sin(t * (6.5 + (i % 5) * 1.7) + i * 2.3);
          const target = 0.12 + 0.88 * env * mid * (0.3 + 0.7 * n);
          levels[i] += (target - levels[i]) * 0.3;
          bars[i].style.transform = `scaleY(${levels[i].toFixed(3)})`;
        }
        raf = window.requestAnimationFrame(tick);
      };
      raf = window.requestAnimationFrame(tick);
    }

    return () => {
      window.clearInterval(clock);
      window.removeEventListener("keydown", onKeyDown);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [recording, onCancel, onToggle]);

  return (
    <div className="ux u457" data-testid="lucian-voice-input">
      <div
        className="u457-p"
        data-s={recording ? "rec" : "idle"}
        style={
          {
            "--u457-w": `${recording ? REC_W : IDLE_W}px`,
            "--u457-h": `${PILL_H}px`,
          } as React.CSSProperties
        }
      >
        <div className="u457-rec" aria-hidden="true">
          <i className="u457-dot" />
          <span className="u457-tm">{formatElapsed(elapsedSec)}</span>
          <span ref={waveRef} className="u457-wv">
            {Array.from({ length: BAR_COUNT }, (_, idx) => (
              <i key={idx} />
            ))}
          </span>
        </div>

        <button
          type="button"
          className="u457-b"
          disabled={disabled}
          aria-label={recording ? "Stop dictation" : "Voice input"}
          title={recording ? "Stop dictation (Esc to cancel)" : "Dictate with microphone"}
          onClick={onToggle}
        >
          <svg className="u457-mic" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11.5" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
          </svg>
          <i className="u457-sq" aria-hidden="true" />
        </button>
      </div>
      <p className="u457-live" role="status">
        {recording ? "Listening" : ""}
      </p>
    </div>
  );
}
