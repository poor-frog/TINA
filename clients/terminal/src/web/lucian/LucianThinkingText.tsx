"use client";
// Lucian UX/UI Prompt #453 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#453
import { useEffect, useId, useRef, useState } from "react";
import "./lucian-453.css";

const SPIN_MS = 2400;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface LucianThinkingTextProps {
  label: string;
  done?: boolean;
  doneLabel?: string;
  lines?: string[];
  compact?: boolean;
  defaultExpanded?: boolean;
}

export function LucianThinkingText({
  label,
  done = false,
  doneLabel,
  lines = [],
  compact = false,
  defaultExpanded = false,
}: LucianThinkingTextProps) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [elapsedSec, setElapsedSec] = useState(1);
  const startedAtRef = useRef<number>(Date.now());
  const starSvgRef = useRef<SVGSVGElement>(null);
  const spinAnimRef = useRef<Animation | null>(null);
  const prevDoneRef = useRef<boolean>(done);

  useEffect(() => {
    if (done) return;
    startedAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSec(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [done]);

  useEffect(() => {
    const svg = starSvgRef.current;
    if (!svg || typeof svg.animate !== "function" || prefersReducedMotion()) return;

    if (!done) {
      spinAnimRef.current?.cancel();
      spinAnimRef.current = svg.animate(
        [
          { transform: "rotate(0deg) scale(1)" },
          { transform: "rotate(180deg) scale(.78)" },
          { transform: "rotate(360deg) scale(1)" },
        ],
        { duration: SPIN_MS, iterations: Infinity },
      );
      return () => {
        spinAnimRef.current?.cancel();
        spinAnimRef.current = null;
      };
    }

    // Settle gracefully onto the nearest 90° quarter turn when thinking completes
    const activeSpin = spinAnimRef.current;
    if (activeSpin) {
      const t = typeof activeSpin.currentTime === "number" ? activeSpin.currentTime : 0;
      const p = (t % SPIN_MS) / SPIN_MS;
      const deg = p * 360;
      const s = p < 0.5 ? 1 - 0.44 * p : 0.78 + 0.44 * (p - 0.5);
      activeSpin.cancel();
      spinAnimRef.current = null;
      svg.animate(
        [
          { transform: `rotate(${deg.toFixed(1)}deg) scale(${s.toFixed(3)})` },
          { transform: `rotate(${Math.ceil((deg + 25) / 90) * 90}deg) scale(1)` },
        ],
        { duration: 750, easing: "cubic-bezier(.3,1.45,.5,1)", fill: "forwards" },
      );
    }
  }, [done]);

  useEffect(() => {
    if (!prevDoneRef.current && done) {
      setElapsedSec(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)));
      setExpanded(false);
    }
    prevDoneRef.current = done;
  }, [done]);

  const hasDetails = lines.length > 0;
  const resolvedDoneLabel = doneLabel ?? `Thought for ${elapsedSec}s`;

  return (
    <div
      className={`ux u453 ${done ? "is-done" : ""} ${compact ? "is-compact" : ""}`}
      data-testid="lucian-thinking-text"
    >
      <div className="u453-w">
        <button
          type="button"
          className="u453-h"
          disabled={!hasDetails}
          aria-expanded={hasDetails ? expanded : undefined}
          aria-controls={hasDetails ? panelId : undefined}
          onClick={() => {
            if (hasDetails) setExpanded((v) => !v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && expanded) {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(false);
            }
          }}
        >
          <span className="u453-ic" aria-hidden="true">
            <svg ref={starSvgRef} viewBox="0 0 24 24">
              <path d="M12 1.6c.8 5.3 5.1 9.6 10.4 10.4-5.3.8-9.6 5.1-10.4 10.4C11.2 17.1 6.9 12.8 1.6 12 6.9 11.2 11.2 6.9 12 1.6Z" />
            </svg>
          </span>
          <span className="u453-tx">
            <span className="u453-a" aria-hidden={done || undefined}>
              {label}
            </span>
            <span className="u453-b" aria-hidden={!done || undefined}>
              {resolvedDoneLabel}
            </span>
          </span>
          {hasDetails && (
            <svg className="u453-cv" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m9.5 6 6 6-6 6" />
            </svg>
          )}
        </button>

        {hasDetails && (
          <div id={panelId} className="u453-pn">
            <div className="u453-in">
              <div className="u453-ls">
                {lines.map((line, idx) => (
                  <p key={`${idx}-${line}`} className="u453-ln is-on">
                    <span>
                      <span>{line}</span>
                    </span>
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="u453-live" role="status">
        {done ? resolvedDoneLabel : label}
      </p>
    </div>
  );
}
