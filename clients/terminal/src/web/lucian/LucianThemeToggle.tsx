"use client";
// Lucian UX/UI Prompt #219 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#219
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { applyTheme, getTheme, THEME_CHANGED_EVENT, type Theme } from "../../app/theme";
import "./lucian-219.css";

interface ViewTransitionLike {
  ready: Promise<void>;
  finished: Promise<void>;
}

type DocumentWithVT = Document & {
  startViewTransition?: (updateCallback: () => void) => ViewTransitionLike;
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LucianThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  const btnRef = useRef<HTMLButtonElement>(null);
  const veilTimerRef = useRef<number | null>(null);
  const veilNodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const syncFromDom = () => {
      const domTheme = document.documentElement.getAttribute("data-theme");
      if (domTheme === "light" || domTheme === "dark") {
        setTheme(domTheme);
      } else {
        setTheme(getTheme());
      }
    };
    syncFromDom();

    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<Theme>).detail;
      if (next === "dark" || next === "light") setTheme(next);
    };
    window.addEventListener(THEME_CHANGED_EVENT, onChanged);

    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, onChanged);
      if (veilTimerRef.current !== null) window.clearTimeout(veilTimerRef.current);
      if (veilNodeRef.current) {
        veilNodeRef.current.remove();
        veilNodeRef.current = null;
      }
      document.documentElement.classList.remove("u219-revealing");
    };
  }, []);

  const handleToggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const rect = btnRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth - 28;
    const cy = rect ? rect.top + rect.height / 2 : 28;
    const maxR = Math.ceil(
      Math.hypot(
        Math.max(cx, window.innerWidth - cx),
        Math.max(cy, window.innerHeight - cy),
      ),
    );

    const reduced = prefersReducedMotion();
    const doc = document as DocumentWithVT;

    if (!reduced && typeof doc.startViewTransition === "function") {
      document.documentElement.classList.add("u219-revealing");
      const vt = doc.startViewTransition(() => {
        flushSync(() => {
          setTheme(next);
          applyTheme(next);
        });
      });

      void vt.ready
        .then(() => {
          if (typeof document.documentElement.animate !== "function") return;
          document.documentElement.animate(
            {
              clipPath: [
                `circle(0px at ${cx.toFixed(0)}px ${cy.toFixed(0)}px)`,
                `circle(${maxR}px at ${cx.toFixed(0)}px ${cy.toFixed(0)}px)`,
              ],
            },
            {
              duration: 700,
              easing: "cubic-bezier(.65, 0, .35, 1)",
              pseudoElement: "::view-transition-new(root)",
            },
          );
        })
        .catch(() => undefined);

      void vt.finished
        .finally(() => {
          document.documentElement.classList.remove("u219-revealing");
        })
        .catch(() => undefined);
      return;
    }

    setTheme(next);
    applyTheme(next);

    if (!reduced && typeof document !== "undefined" && document.body) {
      if (veilTimerRef.current !== null) window.clearTimeout(veilTimerRef.current);
      if (veilNodeRef.current) veilNodeRef.current.remove();
      const veil = document.createElement("div");
      veil.className = "u219-fallback-veil";
      veil.setAttribute("aria-hidden", "true");
      veil.style.setProperty("--u219-cx", `${cx.toFixed(0)}px`);
      veil.style.setProperty("--u219-cy", `${cy.toFixed(0)}px`);
      veil.style.setProperty("--u219-r", `${maxR}px`);
      veil.style.background = next === "dark" ? "#0d0e11" : "#f6f8f7";
      document.body.appendChild(veil);
      veilNodeRef.current = veil;
      veilTimerRef.current = window.setTimeout(() => {
        veil.remove();
        if (veilNodeRef.current === veil) veilNodeRef.current = null;
        veilTimerRef.current = null;
      }, 720);
    }
  };

  const toDark = theme === "light";
  const label = toDark ? "Switch to dark mode" : "Switch to light mode";

  return (
    <button
      ref={btnRef}
      type="button"
      className="ux u219-tg"
      data-theme-mode={theme}
      aria-label={label}
      aria-pressed={theme === "dark"}
      title={label}
      onClick={handleToggle}
    >
      <svg className="u219-sun" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
        </g>
      </svg>
      <svg className="u219-moon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.5 9.8A5.6 5.6 0 0 1 6.2 2.5a5.6 5.6 0 1 0 7.3 7.3z" fill="currentColor" />
      </svg>
    </button>
  );
}
