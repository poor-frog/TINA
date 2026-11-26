"use client";
// Lucian UX/UI Prompt #459 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#459
import { useEffect, useRef, useState } from "react";
import type { MeetingMock } from "../../surfaces/meetingModel";
import "./lucian-459.css";

function formatElapsed(startIso?: string): string {
  if (!startIso) return "Live";
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return "Live";
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = sec % 60;
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LucianDynamicIsland({
  liveMeetings,
  onOpenMeeting,
}: {
  liveMeetings: MeetingMock[];
  onOpenMeeting: (meetingId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [index, setIndex] = useState(0);
  const [pressed, setPressed] = useState(false);
  const [, setTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const atRef = useRef<HTMLDivElement>(null);
  const islRef = useRef<HTMLDivElement>(null);
  const tapRef = useRef<HTMLButtonElement>(null);
  const swipedRef = useRef(false);
  const dragRef = useRef<{ x: number; dx: number; id: number; cap: boolean } | null>(null);

  const count = liveMeetings.length;
  const safeIdx = count > 0 ? index % count : 0;
  const active = liveMeetings[safeIdx];

  useEffect(() => {
    if (count === 0) {
      setExpanded(false);
      return;
    }
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [count]);

  useEffect(() => {
    if (!expanded) return;
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  if (!active) return null;

  const title = active.title_custom || active.title || "Live meeting";
  const elapsed = formatElapsed(active.start_time);

  const nudge = (dir: number) => {
    const el = atRef.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== "function") return;
    el.animate(
      [
        { transform: `translateX(${dir * 14}px)` },
        { transform: `translateX(${-dir * 4}px)`, offset: 0.55 },
        { transform: "none" },
      ],
      { duration: 520, easing: "ease-out" },
    );
  };

  const cycle = (dir: number, quiet = false) => {
    if (count <= 1) return;
    setIndex((cur) => (cur + dir + count) % count);
    setExpanded(false);
    if (!quiet) nudge(dir);
  };

  const finishDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    const d = drag.dx;
    dragRef.current = null;
    setPressed(false);
    if (atRef.current) {
      atRef.current.classList.remove("is-drag");
      atRef.current.style.transform = "";
    }
    if (count > 1 && Math.abs(d) > 36) {
      swipedRef.current = true;
      window.setTimeout(() => {
        swipedRef.current = false;
      }, 0);
      cycle(d < 0 ? 1 : -1, true);
    }
  };

  const islandWidth = expanded ? 316 : 168;
  const islandHeight = expanded ? 84 : 36;
  const islandRadius = expanded ? 42 : 18;
  const ariaLabel = `Live meeting: ${title}, ${elapsed}${expanded ? ", expanded" : ""}`;

  return (
    <div
      ref={rootRef}
      className={`ux u459 ${expanded ? "is-expanded" : ""}`}
      data-testid="lucian-dynamic-island"
    >
      <div ref={atRef} className="u459-at">
        <div
          ref={islRef}
          className={`u459-i ${pressed ? "is-press" : ""}`}
          style={{
            width: `${islandWidth}px`,
            height: `${islandHeight}px`,
            borderRadius: `${islandRadius}px`,
          }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".u459-v button")) return;
            if (swipedRef.current) {
              swipedRef.current = false;
              return;
            }
            setExpanded((v) => !v);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest(".u459-v button")) return;
            dragRef.current = { x: e.clientX, dx: 0, id: e.pointerId, cap: false };
            setPressed(true);
            atRef.current?.classList.add("is-drag");
          }}
          onPointerMove={(e) => {
            const drag = dragRef.current;
            if (!drag) return;
            drag.dx = e.clientX - drag.x;
            const r = Math.sign(drag.dx) * Math.min(48, Math.abs(drag.dx) * 0.4);
            if (atRef.current) atRef.current.style.transform = `translateX(${r.toFixed(1)}px)`;
            if (Math.abs(drag.dx) > 8) {
              setPressed(false);
              if (!drag.cap && islRef.current) {
                drag.cap = true;
                try {
                  islRef.current.setPointerCapture(drag.id);
                } catch {
                  /* ignore */
                }
              }
            }
          }}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
        >
          <button
            ref={tapRef}
            type="button"
            className="u459-tap"
            aria-expanded={expanded}
            aria-label={ariaLabel}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                cycle(e.key === "ArrowRight" ? 1 : -1);
              } else if (e.key === "Escape" && expanded) {
                e.preventDefault();
                e.stopPropagation();
                setExpanded(false);
              }
            }}
          />

          <div className={`u459-v u459-cp ${!expanded ? "is-on" : ""}`} aria-hidden={expanded || undefined}>
            <span className="u459-live-dot" aria-hidden="true" />
            <span className="u459-eq" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            <b className="u459-ct u459-grn">{elapsed}</b>
          </div>

          {expanded && (
            <div className="u459-v u459-xp is-on">
              <div className="u459-who">
                <span className="u459-av" aria-hidden="true">
                  {title.slice(0, 1).toUpperCase()}
                </span>
                <span className="u459-wt">
                  <small>
                    {active.platform} · <span className="u459-grn">{elapsed}</span>
                    {count > 1 ? ` · ${safeIdx + 1}/${count}` : ""}
                  </small>
                  <b>{title}</b>
                </span>
              </div>

              <div className="u459-bs">
                {count > 1 && (
                  <button
                    type="button"
                    className="u459-cb is-gry"
                    aria-label="Next live meeting"
                    title="Switch live meeting"
                    onClick={() => cycle(1)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  className="u459-cb is-grn"
                  aria-label="Open live meeting"
                  title="Jump to live meeting"
                  onClick={() => {
                    setExpanded(false);
                    onOpenMeeting(active.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 17 17 7M9 7h8v8" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <p className="u459-live" role="status">
        {expanded ? ariaLabel : ""}
      </p>
    </div>
  );
}
