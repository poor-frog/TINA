"use client";
// Lucian UX/UI Prompt #435 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#435
import { useCallback, useEffect, useRef, useState } from "react";
import { WEB_TOAST_EVENT, type WebToastPayload, type WebToastTone } from "./webToast";
import "./lucian-435.css";

interface ToastEntry {
  id: number;
  message: string;
  tone: WebToastTone;
  undoLabel?: string;
  undoneMessage: string;
  onUndo?: () => void;
  undone: boolean;
  gone: boolean;
  entering: boolean;
  barKey: number;
  barMs: number;
  leftMs: number;
  startedAt: number;
}

const TOAST_H = 56;
const TOAST_GAP = 8;
const DEFAULT_LIFE = 4200;
const MAX_VISIBLE = 3;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LucianToastStack() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [fanned, setFanned] = useState(false);

  const nextIdRef = useRef(1);
  const toastsRef = useRef<ToastEntry[]>([]);
  toastsRef.current = toasts;
  const pausedRef = useRef(false);
  const timersRef = useRef<Map<number, number>>(new Map());
  const leaveTimerRef = useRef<number | null>(null);
  const elMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const rootRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    id: number;
    x0: number;
    dx: number;
    last: Array<[number, number]>;
  } | null>(null);

  const clearToastTimer = useCallback((id: number) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number, dir = 0, quiet = false) => {
      const target = toastsRef.current.find((t) => t.id === id);
      if (!target || target.gone) return;
      clearToastTimer(id);

      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, gone: true } : t)));

      const finalize = () => {
        elMapRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      };

      const el = elMapRef.current.get(id);
      if (!el || prefersReducedMotion() || typeof el.animate !== "function") {
        finalize();
        return;
      }

      el.style.pointerEvents = "none";
      const y = el.style.getPropertyValue("--y") || "0px";
      const s = Number(el.style.getPropertyValue("--s") || "1") || 1;
      const dx = dragRef.current?.id === id ? dragRef.current.dx : 0;

      if (dir) {
        const dist = 380;
        el.classList.add("is-drag");
        const anim = el.animate(
          [
            { transform: `translate3d(${dx}px,${y},0) scale(${s})`, opacity: 1 },
            { transform: `translate3d(${dir * dist}px,${y},0) scale(${s}) rotate(${dir * 6}deg)`, opacity: 0 },
          ],
          { duration: 240, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" },
        );
        anim.onfinish = finalize;
      } else {
        const anim = el.animate(
          [
            { opacity: quiet ? 0 : 1 },
            { transform: `translate3d(0,calc(${y} + 14px),0) scale(${(s * 0.94).toFixed(3)})`, opacity: 0 },
          ],
          { duration: 260, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" },
        );
        anim.onfinish = finalize;
      }
    },
    [clearToastTimer],
  );

  const scheduleTimer = useCallback(
    (id: number, leftMs: number) => {
      clearToastTimer(id);
      if (pausedRef.current) return;
      const handle = window.setTimeout(() => {
        dismiss(id);
      }, Math.max(250, leftMs));
      timersRef.current.set(id, handle);
    },
    [clearToastTimer, dismiss],
  );

  const pushToast = useCallback(
    (payload: WebToastPayload) => {
      const id = nextIdRef.current++;
      const life = payload.durationMs ?? DEFAULT_LIFE;
      const entry: ToastEntry = {
        id,
        message: payload.message,
        tone: payload.tone ?? "success",
        undoLabel: payload.onUndo ? payload.undoLabel ?? "Undo" : undefined,
        undoneMessage: payload.undoneMessage ?? "Undone",
        onUndo: payload.onUndo,
        undone: false,
        gone: false,
        entering: !prefersReducedMotion(),
        barKey: 1,
        barMs: life,
        leftMs: life,
        startedAt: Date.now(),
      };

      setToasts((prev) => {
        const next = [...prev, entry];
        const active = next.filter((t) => !t.gone);
        if (active.length > MAX_VISIBLE) {
          const oldest = active[0];
          window.setTimeout(() => dismiss(oldest.id, 0, true), 0);
        }
        return next;
      });

      scheduleTimer(id, life);

      if (entry.entering) {
        window.requestAnimationFrame(() => {
          setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, entering: false } : t)));
        });
      }
    },
    [dismiss, scheduleTimer],
  );

  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<WebToastPayload>).detail;
      if (detail?.message) pushToast(detail);
    };
    window.addEventListener(WEB_TOAST_EVENT, onEvent);
    return () => {
      window.removeEventListener(WEB_TOAST_EVENT, onEvent);
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
      timersRef.current.forEach((h) => window.clearTimeout(h));
      timersRef.current.clear();
    };
  }, [pushToast]);

  const setOpenState = useCallback(
    (open: boolean) => {
      if (pausedRef.current === open) return;
      pausedRef.current = open;
      setFanned(open);
      const now = Date.now();
      setToasts((prev) =>
        prev.map((t) => {
          if (t.gone) return t;
          if (open) {
            clearToastTimer(t.id);
            const remaining = Math.max(500, t.leftMs - (now - t.startedAt));
            return { ...t, leftMs: remaining };
          }
          scheduleTimer(t.id, t.leftMs);
          return { ...t, startedAt: now };
        }),
      );
    },
    [clearToastTimer, scheduleTimer],
  );

  const triggerUndo = useCallback(
    (entry: ToastEntry) => {
      if (entry.undone || entry.gone) return;
      entry.onUndo?.();
      const nextLife = 2000;
      setToasts((prev) =>
        prev.map((t) =>
          t.id === entry.id
            ? { ...t, undone: true, barKey: t.barKey + 1, barMs: nextLife, leftMs: nextLife, startedAt: Date.now() }
            : t,
        ),
      );
      scheduleTimer(entry.id, nextLife);
    },
    [scheduleTimer],
  );

  const liveToasts = toasts.filter((t) => !t.gone);
  const liveCount = liveToasts.length;
  const regionHeight =
    liveCount === 0
      ? 0
      : fanned && liveCount > 1
        ? liveCount * TOAST_H + (liveCount - 1) * TOAST_GAP
        : TOAST_H + Math.min(liveCount - 1, MAX_VISIBLE - 1) * 11;

  return (
    <div ref={rootRef} className="ux u435" data-testid="lucian-toast-stack">
      <section
        ref={regionRef}
        className={`u435-rg ${fanned ? "is-paused" : ""} ${liveCount === 0 ? "is-empty" : ""}`}
        aria-label="Notifications"
        style={{ height: regionHeight }}
        onPointerEnter={() => {
          if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
          if (liveCount > 0) setOpenState(true);
        }}
        onPointerLeave={() => {
          if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
          leaveTimerRef.current = window.setTimeout(() => {
            if (!regionRef.current?.contains(document.activeElement)) {
              setOpenState(false);
            }
          }, 120);
        }}
        onFocus={() => {
          if (liveCount > 0) setOpenState(true);
        }}
        onBlur={(e) => {
          if (!regionRef.current?.contains(e.relatedTarget as Node | null)) {
            setOpenState(false);
          }
        }}
      >
        {toasts.map((entry) => {
          const liveIdx = liveToasts.findIndex((t) => t.id === entry.id);
          const stackPos = liveIdx >= 0 ? liveCount - 1 - liveIdx : 0;
          const y = entry.entering
            ? 84
            : fanned
              ? -stackPos * (TOAST_H + TOAST_GAP)
              : -stackPos * 11;
          const s = entry.entering ? 0.9 : fanned ? 1 : 1 - stackPos * 0.055;
          const o = entry.entering ? 0 : stackPos < MAX_VISIBLE ? 1 : 0;
          const isBack = !fanned && stackPos > 0;

          return (
            <div
              key={entry.id}
              ref={(node) => {
                if (node) elMapRef.current.set(entry.id, node);
                else elMapRef.current.delete(entry.id);
              }}
              className={`u435-t ${entry.entering ? "is-in" : ""} ${isBack ? "is-back" : ""} ${entry.undone ? "is-undo" : ""}`}
              data-tone={entry.tone}
              role={entry.tone === "error" ? "alert" : "status"}
              style={
                {
                  "--y": `${y}px`,
                  "--s": s.toFixed(3),
                  "--o": String(o),
                  zIndex: 20 - stackPos,
                } as React.CSSProperties
              }
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  dismiss(entry.id);
                }
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || (e.target as HTMLElement).closest("button") || entry.gone) return;
                const el = elMapRef.current.get(entry.id);
                if (!el) return;
                dragRef.current = { id: entry.id, x0: e.clientX, dx: 0, last: [[e.clientX, e.timeStamp]] };
                el.classList.add("is-drag");
                try {
                  el.setPointerCapture(e.pointerId);
                } catch {
                  /* ignore */
                }
              }}
              onPointerMove={(e) => {
                const drag = dragRef.current;
                if (!drag || drag.id !== entry.id) return;
                const el = elMapRef.current.get(entry.id);
                if (!el) return;
                drag.dx = e.clientX - drag.x0;
                drag.last.push([e.clientX, e.timeStamp]);
                if (drag.last.length > 5) drag.last.shift();
                el.style.setProperty("--x", `${drag.dx.toFixed(1)}px`);
                el.style.opacity = String(Math.max(0.35, 1 - Math.abs(drag.dx) / 320));
              }}
              onPointerUp={() => {
                const drag = dragRef.current;
                if (!drag || drag.id !== entry.id) return;
                const el = elMapRef.current.get(entry.id);
                const a = drag.last[0];
                const b = drag.last[drag.last.length - 1];
                const v = b && a && b[1] > a[1] ? (b[0] - a[0]) / (b[1] - a[1]) : 0;
                if (el) el.style.opacity = "";
                if (Math.abs(drag.dx) > 80 || Math.abs(v) > 0.6) {
                  const dir = (Math.abs(v) > 0.6 ? v : drag.dx) > 0 ? 1 : -1;
                  dismiss(entry.id, dir);
                  dragRef.current = null;
                  return;
                }
                if (el) {
                  el.classList.remove("is-drag");
                  el.style.setProperty("--x", "0px");
                }
                dragRef.current = null;
              }}
              onPointerCancel={() => {
                const drag = dragRef.current;
                if (!drag || drag.id !== entry.id) return;
                const el = elMapRef.current.get(entry.id);
                if (el) {
                  el.style.opacity = "";
                  el.classList.remove("is-drag");
                  el.style.setProperty("--x", "0px");
                }
                dragRef.current = null;
              }}
            >
              <span className="u435-ic" aria-hidden="true">
                <span className="ok">
                  {entry.tone === "error" ? (
                    <svg viewBox="0 0 24 24">
                      <path d="M12 7v6M12 17h.01" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24">
                      <path d="m6 12.5 4 4 8-9" />
                    </svg>
                  )}
                </span>
                <span className="bk">
                  <svg viewBox="0 0 24 24">
                    <path d="M9 14 4.5 9.5 9 5" />
                    <path d="M4.5 9.5h9a5.5 5.5 0 0 1 0 11H11" />
                  </svg>
                </span>
              </span>

              <span className="u435-tx">
                <b aria-hidden={entry.undone || undefined}>{entry.message}</b>
                <b aria-hidden={!entry.undone || undefined}>{entry.undoneMessage}</b>
              </span>

              {entry.undoLabel && (
                <button
                  type="button"
                  className="u435-un"
                  onClick={() => triggerUndo(entry)}
                >
                  {entry.undoLabel}
                </button>
              )}

              <button
                type="button"
                className="u435-x"
                aria-label="Dismiss notification"
                onClick={() => dismiss(entry.id)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>

              <span className="u435-pb" aria-hidden="true">
                <i key={entry.barKey} style={{ animationDuration: `${entry.barMs}ms` }} />
              </span>
            </div>
          );
        })}
      </section>
    </div>
  );
}
