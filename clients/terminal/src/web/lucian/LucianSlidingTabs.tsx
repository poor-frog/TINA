"use client";
// Lucian UX/UI Prompt #039 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#039
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import "./lucian-039.css";

export interface SlidingTabOption<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: ReactNode;
}

export function LucianSlidingTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  fullWidth = false,
}: {
  tabs: ReadonlyArray<SlidingTabOption<T>>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  fullWidth?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const firstRef = useRef(true);

  const activeIdx = Math.max(
    0,
    tabs.findIndex((t) => t.id === value),
  );

  const measure = useCallback((animate: boolean) => {
    const pill = pillRef.current;
    const btn = tabRefs.current[activeIdx];
    if (!pill || !btn) return;
    if (!animate) pill.style.transition = "none";
    const w = btn.offsetWidth;
    if (w > 0) {
      pill.style.opacity = "1";
      pill.style.setProperty("--x", `${btn.offsetLeft}px`);
      pill.style.setProperty("--w", `${w}px`);
    } else {
      pill.style.opacity = "0";
    }
    if (!animate) {
      void pill.offsetWidth;
      pill.style.transition = "";
    }
  }, [activeIdx]);

  useLayoutEffect(() => {
    measure(!firstRef.current);
    firstRef.current = false;
  }, [measure, tabs]);

  useEffect(() => {
    const onResize = () => measure(false);
    window.addEventListener("resize", onResize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && listRef.current) {
      ro = new ResizeObserver(() => measure(false));
      ro.observe(listRef.current);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [measure]);

  return (
    <div
      ref={listRef}
      className={`ux u039-tabs ${fullWidth ? "is-full" : ""}`}
      role="tablist"
      aria-label={ariaLabel}
      data-testid="lucian-sliding-tabs"
    >
      <span ref={pillRef} className="u039-pill" aria-hidden="true" />
      {tabs.map((tab, idx) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className="u039-tab"
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const nextIdx = (idx + d + tabs.length) % tabs.length;
              const nextTab = tabs[nextIdx];
              if (nextTab) {
                onChange(nextTab.id);
                tabRefs.current[nextIdx]?.focus();
              }
            }}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {typeof tab.count === "number" && tab.count > 0 && (
              <span className="u039-count">({tab.count})</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
