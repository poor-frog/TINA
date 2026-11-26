"use client";
// Lucian UX/UI Prompt #194 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#194
import { useEffect, useState } from "react";
import "./lucian-194.css";

const WAVE_BARS = [
  20, 44, 70, 23, 53, 85, 44, 80, 43, 83, 50, 94, 65, 38, 88, 65, 44, 25, 83, 68, 55, 44, 35,
  28, 23, 20, 94, 20, 23, 28, 35, 44, 55, 68, 83, 25, 44, 65, 88, 38, 65, 94, 50, 83, 43, 80,
];

function fmtSec(sec: number): string {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  const s = (safe % 60).toFixed(1).padStart(4, "0");
  return m > 0 ? `${m}:${s}` : `${safe.toFixed(1)}s`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LucianAudioLoopRegion({
  durationSec,
  currentSec,
  hasAudio,
  loopActive,
  startPct,
  endPct,
  onChangeRange,
  onToggleLoop,
}: {
  durationSec: number;
  currentSec: number;
  hasAudio: boolean;
  loopActive: boolean;
  startPct: number;
  endPct: number;
  onChangeRange: (startPct: number, endPct: number) => void;
  onToggleLoop: () => void;
}) {
  const [simPos, setSimPos] = useState(startPct);
  const effectiveDuration = durationSec > 0 ? durationSec : 10;

  useEffect(() => {
    setSimPos(startPct);
  }, [startPct, endPct]);

  // Silent visual cursor preview when looping without loaded audio
  useEffect(() => {
    if (!loopActive || hasAudio || prefersReducedMotion()) return;
    const timer = window.setInterval(() => {
      setSimPos((cur) => {
        const next = cur + 0.8;
        return next > endPct ? startPct : next;
      });
    }, 60);
    return () => window.clearInterval(timer);
  }, [loopActive, hasAudio, startPct, endPct]);

  const startSec = (startPct / 100) * effectiveDuration;
  const endSec = (endPct / 100) * effectiveDuration;
  const spanSec = Math.max(0.1, endSec - startSec);
  const cursorPct = hasAudio && durationSec > 0 ? Math.min(100, Math.max(0, (currentSec / durationSec) * 100)) : simPos;

  return (
    <div
      className={`ux u194 ${loopActive ? "playing" : ""}`}
      data-testid="lucian-audio-loop"
      data-state={`loop-${startPct}-${endPct}-${loopActive}`}
    >
      <div className="wave">
        {WAVE_BARS.map((h, idx) => (
          <i key={idx} style={{ "--h": `${h}%` } as React.CSSProperties} />
        ))}
        <span
          className="band"
          aria-hidden="true"
          style={
            {
              "--start": `${startPct}%`,
              "--width": `${Math.max(1, endPct - startPct)}%`,
            } as React.CSSProperties
          }
        />
        <span
          className="cursor"
          aria-hidden="true"
          style={{ "--cursor": `${cursorPct.toFixed(2)}%` } as React.CSSProperties}
        />
        <input
          type="range"
          aria-label="Loop start"
          min={0}
          max={100}
          value={startPct}
          onChange={(e) => {
            const next = Math.min(Number(e.currentTarget.value), endPct - 5);
            onChangeRange(Math.max(0, next), endPct);
          }}
        />
        <input
          type="range"
          aria-label="Loop end"
          min={0}
          max={100}
          value={endPct}
          onChange={(e) => {
            const next = Math.max(Number(e.currentTarget.value), startPct + 5);
            onChangeRange(startPct, Math.min(100, next));
          }}
        />
      </div>

      <div className="loop-footer">
        <div className="loop-times">
          <output className="in">{fmtSec(startSec)}</output>
          <span aria-hidden="true">→</span>
          <output className="out">{fmtSec(endSec)}</output>
        </div>
        <button
          type="button"
          className="preview"
          aria-pressed={loopActive}
          onClick={onToggleLoop}
        >
          {loopActive ? "■ " : "▶ "}
          {spanSec.toFixed(1)}s loop
        </button>
      </div>
    </div>
  );
}
