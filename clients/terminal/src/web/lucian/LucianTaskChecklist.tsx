"use client";
// Lucian UX/UI Prompt #014 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#014
// Lucian UX/UI Prompt #093 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#093
import { useCallback, useEffect, useRef, useState } from "react";
import "./lucian-014.css";
import "./lucian-093.css";

export interface ChecklistTaskRow {
  path: string;
  title: string;
  state: string;
  done: boolean;
  meta: string;
  priority: string;
}

const BURST_COLORS = ["#22C3A6", "#10B981", "#FFB547", "#91D7BE", "#7B61FF", "#3D8BFF"];

function tagColor(state: string, priority: string): string {
  if (state === "done" || state === "accepted" || state === "completed") return "var(--ux-mint)";
  if (priority === "high" || priority === "urgent" || state === "rejected") return "var(--ux-danger)";
  if (state === "draft" || state === "pending") return "var(--ux-warn)";
  return "var(--ux-accent)";
}

export function LucianTaskChecklist({
  tasks,
  totalCount,
  doneCount,
  selectedPath,
  togglingPath,
  readOnly = false,
  onSelect,
  onToggleDone,
}: {
  tasks: ChecklistTaskRow[];
  totalCount: number;
  doneCount: number;
  selectedPath: string | null;
  togglingPath: string | null;
  readOnly?: boolean;
  onSelect: (path: string) => void;
  onToggleDone: (path: string, nextDone: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const prevDoneRef = useRef(doneCount);
  const [celebrating, setCelebrating] = useState(false);
  const [liveMsg, setLiveMsg] = useState("");

  const allDone = totalCount > 0 && doneCount === totalCount;
  const pct = totalCount > 0 ? doneCount / totalCount : 0;

  const fireConfetti = useCallback(() => {
    const root = rootRef.current;
    const cv = canvasRef.current;
    if (!root || !cv) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const ctx = cv.getContext?.("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(260, root.offsetWidth || 340);
    const H = Math.max(260, root.offsetHeight || 340);
    cv.width = W * dpr;
    cv.height = H * dpr;

    const ps = Array.from({ length: 72 }, (_, i) => {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
      const v = 340 + Math.random() * 380;
      return {
        x: W / 2 + (Math.random() - 0.5) * 40,
        y: Math.min(180, H * 0.55),
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        r: Math.random() * 6,
        vr: (Math.random() - 0.5) * 14,
        w: 5 + Math.random() * 4,
        h: 7 + Math.random() * 5,
        col: BURST_COLORS[i % BURST_COLORS.length],
        t: 0,
        life: 1.5 + Math.random() * 0.8,
      };
    });

    let last = performance.now();
    window.cancelAnimationFrame(rafRef.current);

    const step = (now: number) => {
      if (!root.isConnected) return;
      const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000));
      last = now;
      let alive = 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      for (const p of ps) {
        p.t += dt;
        if (p.t > p.life || p.y > H + 20) continue;
        alive += 1;
        p.vy += 900 * dt;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.r += p.vr * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.globalAlpha = Math.min(1, (p.life - p.t) / 0.4);
        ctx.scale(1, Math.cos(p.t * 9 + p.w));
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive > 0) rafRef.current = window.requestAnimationFrame(step);
      else ctx.clearRect(0, 0, W, H);
    };

    rafRef.current = window.requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    const prev = prevDoneRef.current;
    prevDoneRef.current = doneCount;
    if (totalCount > 0 && doneCount === totalCount && prev < totalCount) {
      setCelebrating(true);
      setLiveMsg(`All ${totalCount} tasks completed!`);
      fireConfetti();
    } else if (doneCount < totalCount) {
      setCelebrating(false);
    }
  }, [doneCount, totalCount, fireConfetti]);

  useEffect(
    () => () => {
      window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const popBurst = (btn: HTMLButtonElement) => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const rr = root.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (!rr.width || !br.width) return;
    const cx = br.left + br.width / 2 - rr.left;
    const cy = br.top + br.height / 2 - rr.top;
    for (let i = 0; i < 8; i += 1) {
      const p = document.createElement("span");
      const a = (i / 8) * Math.PI * 2 + 0.3;
      const d = 18 + Math.random() * 8;
      p.className = "u093-p";
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;
      p.style.background = BURST_COLORS[i % BURST_COLORS.length];
      root.appendChild(p);
      if (typeof p.animate === "function") {
        p.animate(
          [
            { transform: "translate(0,0) scale(1)", opacity: 1 },
            { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px) scale(0)`, opacity: 1 },
          ],
          { duration: 500, easing: "cubic-bezier(.2,.7,.3,1)" },
        ).onfinish = () => p.remove();
      } else {
        p.remove();
      }
    }
  };

  return (
    <div
      ref={rootRef}
      className={`ux u014 u093-wrap ${allDone ? "is-all" : ""}`}
      style={{ "--p": pct.toFixed(3) } as React.CSSProperties}
      data-testid="lucian-task-checklist"
    >
      {totalCount > 0 && (
        <>
          <div className="u014-head">
            <div>
              <b>Action Checklist</b>
              <span className="u014-sub" aria-live="polite">
                <span>
                  {totalCount - doneCount} {totalCount - doneCount === 1 ? "task" : "tasks"} remaining
                </span>
                <span>All tasks completed</span>
              </span>
            </div>
            <div className="u014-ring" aria-hidden="true">
              <svg viewBox="0 0 48 48">
                <circle className="bg" cx="24" cy="24" r="20" />
                <circle className="fg" cx="24" cy="24" r="20" />
              </svg>
              <span className="u014-num">
                {doneCount}/{totalCount}
              </span>
              <span className="u014-done">
                <svg viewBox="0 0 16 16">
                  <path d="M3.5 8.4l3 3 6-6.4" />
                </svg>
              </span>
            </div>
          </div>

          <div className="u093-bar" aria-hidden="true">
            <i style={{ "--p": pct.toFixed(3) } as React.CSSProperties} />
          </div>
        </>
      )}

      <ul className="u014-list" aria-label="Workspace tasks">
        {tasks.map((task) => {
          const active = selectedPath === task.path;
          const busy = togglingPath === task.path;
          return (
            <li
              key={task.path}
              className={`u014-item ${task.done ? "is-checked" : ""} ${active ? "is-selected" : ""}`}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={task.done}
                aria-label={task.done ? `Mark "${task.title}" as open` : `Mark "${task.title}" as done`}
                className="u014-chk-btn"
                disabled={busy || readOnly}
                onClick={(e) => {
                  const nextDone = !task.done;
                  if (nextDone) popBurst(e.currentTarget);
                  setLiveMsg(`${task.title} marked ${nextDone ? "done" : "open"}`);
                  onToggleDone(task.path, nextDone);
                }}
              >
                <span className="u014-box" aria-hidden="true">
                  <svg viewBox="0 0 26 26">
                    <path d="M7.5 13.5l3.8 3.8 7.4-8" />
                  </svg>
                </span>
              </button>

              <button type="button" className="u014-open" onClick={() => onSelect(task.path)}>
                <span className="u014-title-row">
                  <span className="u014-t">{task.title}</span>
                  <span className="u014-tag" style={{ "--k": tagColor(task.state, task.priority) } as React.CSSProperties}>
                    {task.state}
                  </span>
                </span>
                <span className="u014-meta">{task.meta}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {celebrating && (
        <div className="u093-win" role="status" data-testid="lucian-task-celebration">
          <span className="u093-bdg" aria-hidden="true">
            <svg viewBox="0 0 42 42">
              <path d="M10 22l7.5 7.5L32 14" />
            </svg>
          </span>
          <p className="u093-wt">All tasks completed</p>
          <p className="u093-ws">Every action item in this workspace is checked off.</p>
          <span className="u093-st">
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path
                d="M9 1.5c.6 3-2.8 4.4-2.8 7.6a2.8 2.8 0 0 0 5.6 0c0-1-.4-1.8-.9-2.5 2.2.9 3.6 3 3.6 5.2a5.5 5.5 0 0 1-11 0C3.5 7.6 8.3 6 9 1.5z"
                fill="#FF8A3D"
              />
            </svg>
            <span>
              {doneCount}/{totalCount} cleared
            </span>
          </span>
          <button type="button" className="u093-again" onClick={() => setCelebrating(false)}>
            Keep reviewing
          </button>
        </div>
      )}

      <canvas ref={canvasRef} className="u093-cf" aria-hidden="true" />
      <span className="u093-sr" role="status">
        {liveMsg}
      </span>
    </div>
  );
}
