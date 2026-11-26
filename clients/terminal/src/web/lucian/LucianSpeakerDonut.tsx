"use client";
// Lucian UX/UI Prompt #097 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#097
import { useEffect, useMemo, useRef, useState } from "react";
import { formatTalkDuration, type SpeakerTalkStat } from "../SpeakerTalkTime";
import "./lucian-097.css";

const RADIUS = 66;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 3;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LucianSpeakerDonut({
  speakers,
  activeSpeaker,
  onSelectSpeaker,
}: {
  speakers: SpeakerTalkStat[];
  activeSpeaker: string;
  onSelectSpeaker: (speaker: string) => void;
}) {
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const [fractions, setFractions] = useState<number[]>(() => speakers.map(() => 0));
  const [swapKey, setSwapKey] = useState(0);

  const fractionsRef = useRef<number[]>(fractions);
  fractionsRef.current = fractions;
  const rafRef = useRef(0);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const includedFlags = useMemo(
    () => speakers.map((s) => !excluded[s.speaker]),
    [speakers, excluded],
  );

  const includedTotalMs = useMemo(
    () => speakers.reduce((sum, s, i) => sum + (includedFlags[i] ? Math.max(1, s.durationMs) : 0), 0),
    [speakers, includedFlags],
  );

  const targetFractions = useMemo(() => {
    if (includedTotalMs <= 0) return speakers.map(() => 0);
    return speakers.map((s, i) => (includedFlags[i] ? Math.max(1, s.durationMs) / includedTotalMs : 0));
  }, [speakers, includedFlags, includedTotalMs]);

  useEffect(() => {
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    const reduced = prefersReducedMotion();
    if (reduced || typeof window.requestAnimationFrame !== "function") {
      setFractions(targetFractions);
      return;
    }

    const from =
      fractionsRef.current.length === targetFractions.length
        ? fractionsRef.current.slice()
        : targetFractions.map(() => 0);
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dur = 580;

    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const ease = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const next = from.map((v, i) => v + (targetFractions[i] - v) * ease);
      setFractions(next);
      if (k < 1) {
        rafRef.current = window.requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
      }
    };

    rafRef.current = window.requestAnimationFrame(step);
    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [targetFractions]);

  useEffect(() => {
    setSwapKey((k) => k + 1);
  }, [hoveredIdx, includedTotalMs]);

  if (speakers.length === 0) return null;

  const includedCount = includedFlags.filter(Boolean).length;

  const toggleInclude = (speakerName: string) => {
    const isCurrentlyIncluded = !excluded[speakerName];
    if (isCurrentlyIncluded && includedCount <= 1) {
      const rowEl = rowRefs.current.get(speakerName);
      if (rowEl && !prefersReducedMotion() && typeof rowEl.animate === "function") {
        rowEl.animate(
          [
            { transform: "translateX(0)" },
            { transform: "translateX(-5px)" },
            { transform: "translateX(4px)" },
            { transform: "none" },
          ],
          { duration: 300 },
        );
      }
      return;
    }
    setExcluded((cur) => ({ ...cur, [speakerName]: !cur[speakerName] }));
  };

  const focusSpeaker =
    hoveredIdx >= 0 && includedFlags[hoveredIdx]
      ? speakers[hoveredIdx]
      : activeSpeaker
        ? speakers.find((s) => s.speaker === activeSpeaker && !excluded[s.speaker]) ?? null
        : null;

  const focusSharePct =
    focusSpeaker && includedTotalMs > 0
      ? Math.round((Math.max(1, focusSpeaker.durationMs) / includedTotalMs) * 100)
      : 0;

  let accLen = 0;
  const activeHoverValid = hoveredIdx >= 0 && includedFlags[hoveredIdx];

  return (
    <div
      className={`ux u097 ${activeHoverValid ? "has" : ""}`}
      data-testid="lucian-speaker-donut"
    >
      <div className="u097-dn">
        <svg
          viewBox="0 0 176 176"
          aria-hidden="true"
          onPointerLeave={() => setHoveredIdx(-1)}
        >
          <circle className="u097-trk" cx="88" cy="88" r={RADIUS} />
          {speakers.map((speaker, idx) => {
            const frac = fractions[idx] ?? 0;
            const len = frac * CIRCUMFERENCE;
            const vis = Math.max(0, len - (includedCount > 1 ? GAP : 0));
            const offset = -accLen - (includedCount > 1 ? GAP / 2 : 0);
            const mid = ((accLen + len / 2) / CIRCUMFERENCE) * Math.PI * 2;
            accLen += len;

            const isSliceHighlighted =
              includedFlags[idx] &&
              (hoveredIdx === idx || (hoveredIdx < 0 && activeSpeaker === speaker.speaker));
            const tx = isSliceHighlighted ? Math.cos(mid) * 6 : 0;
            const ty = isSliceHighlighted ? Math.sin(mid) * 6 : 0;

            return (
              <circle
                key={speaker.speaker}
                className={`u097-sg ${isSliceHighlighted ? "on" : ""}`}
                cx="88"
                cy="88"
                r={RADIUS}
                strokeDasharray={`${vis.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
                strokeDashoffset={offset.toFixed(2)}
                style={{
                  stroke: speaker.color,
                  transform: isSliceHighlighted
                    ? `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`
                    : undefined,
                }}
                onPointerEnter={() => setHoveredIdx(idx)}
                onClick={() => toggleInclude(speaker.speaker)}
              />
            );
          })}
        </svg>

        <div key={swapKey} className="u097-c sw" aria-live="polite">
          {focusSpeaker ? (
            <>
              <small>{focusSpeaker.speaker}</small>
              <b>{formatTalkDuration(focusSpeaker.durationMs)}</b>
              <span>
                {focusSharePct}% · {focusSpeaker.wpm || 0} wpm
              </span>
            </>
          ) : (
            <>
              <small>{includedCount === speakers.length ? "Total spoken" : `${includedCount} selected`}</small>
              <b>{formatTalkDuration(includedTotalMs)}</b>
              <span>
                {includedCount} {includedCount === 1 ? "speaker" : "speakers"}
              </span>
            </>
          )}
        </div>
      </div>

      <div
        className="u097-lg"
        role="group"
        aria-label="Speaker breakdown"
        onPointerLeave={() => setHoveredIdx(-1)}
      >
        {speakers.map((speaker, idx) => {
          const isIncluded = includedFlags[idx];
          const isFilterSelected = activeSpeaker === speaker.speaker;
          const liveSharePct =
            isIncluded && includedTotalMs > 0
              ? Math.round((Math.max(1, speaker.durationMs) / includedTotalMs) * 100)
              : 0;

          return (
            <div
              key={speaker.speaker}
              ref={(node) => {
                if (node) rowRefs.current.set(speaker.speaker, node);
                else rowRefs.current.delete(speaker.speaker);
              }}
              className={`u097-row ${!isIncluded ? "is-off" : ""}`}
            >
              <button
                type="button"
                className={`u097-it ${hoveredIdx === idx ? "on" : ""} ${isFilterSelected ? "is-filter" : ""}`}
                style={{ "--c": speaker.color } as React.CSSProperties}
                aria-pressed={isFilterSelected}
                title={
                  isFilterSelected
                    ? `Clear speaker filter (${speaker.speaker})`
                    : `Filter transcript by ${speaker.speaker}`
                }
                onPointerEnter={() => setHoveredIdx(idx)}
                onFocus={() => setHoveredIdx(idx)}
                onBlur={() => setHoveredIdx(-1)}
                onClick={() => onSelectSpeaker(isFilterSelected ? "" : speaker.speaker)}
              >
                <i aria-hidden="true" />
                <span className="u097-nm">{speaker.speaker}</span>
                <span className="u097-wpm">{speaker.wpm || 0}w</span>
                <small>{isIncluded ? `${liveSharePct}%` : "Off"}</small>
              </button>

              {speakers.length > 1 && (
                <span
                  role="checkbox"
                  tabIndex={0}
                  className="u097-ex"
                  aria-checked={isIncluded}
                  aria-label={`${isIncluded ? "Exclude" : "Include"} ${speaker.speaker} in donut chart`}
                  title={isIncluded ? `Exclude ${speaker.speaker} from chart` : `Include ${speaker.speaker} in chart`}
                  onClick={() => toggleInclude(speaker.speaker)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleInclude(speaker.speaker);
                    }
                  }}
                >
                  {isIncluded ? (
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4Z" />
                      <circle cx="8" cy="8" r="1.8" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2.5 2.5 13.5 13.5M4.6 4.7C3 5.8 2 8 2 8s2.4 4 6 4c1.3 0 2.4-.4 3.4-1.1M7 4.1c.3-.1.6-.1 1-.1 3.6 0 6 4 6 4s-.7 1.2-1.8 2.2" />
                    </svg>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
