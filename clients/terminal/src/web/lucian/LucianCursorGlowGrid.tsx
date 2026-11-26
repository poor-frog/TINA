"use client";
// Lucian UX/UI Prompt #228 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#228
import { useEffect, useRef } from "react";
import "./lucian-228.css";

export interface CursorGlowCardItem {
  num: string;
  title: string;
  body: string;
}

export function LucianCursorGlowGrid({
  items,
  ariaLabel = "Use cases",
}: {
  items: ReadonlyArray<CursorGlowCardItem>;
  ariaLabel?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const rm =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let pt = { x: -500, y: -500 };
    let o = 0;
    let oT = 0;
    let raf = 0;
    let last = 0;

    const apply = () => {
      const rb = root.getBoundingClientRect();
      const k = root.offsetWidth / (rb.width || 1) || 1;
      for (const el of cardRefs.current) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const lx = pt.x - (r.left - rb.left) * k;
        const ly = pt.y - (r.top - rb.top) * k;
        el.style.setProperty("--cx", `${lx.toFixed(1)}px`);
        el.style.setProperty("--cy", `${ly.toFixed(1)}px`);
        el.style.setProperty("--o", o.toFixed(3));
        const inner = el.firstElementChild as HTMLElement | null;
        if (inner) {
          inner.style.setProperty("--cx", `${(lx - 1.5).toFixed(1)}px`);
          inner.style.setProperty("--cy", `${(ly - 1.5).toFixed(1)}px`);
        }
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (!root.isConnected) return;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      o += (oT - o) * (rm ? 1 : Math.min(1, dt * (oT ? 8 : 2.5)));
      apply();
      if (Math.abs(oT - o) > 0.005) {
        raf = window.requestAnimationFrame(frame);
      }
    };

    const kick = () => {
      if (!raf) {
        last = performance.now();
        raf = window.requestAnimationFrame(frame);
      }
    };

    const onMove = (e: PointerEvent) => {
      const b = root.getBoundingClientRect();
      const k = root.offsetWidth / (b.width || 1) || 1;
      pt = { x: (e.clientX - b.left) * k, y: (e.clientY - b.top) * k };
      oT = 1;
      apply();
      kick();
    };

    const onLeave = () => {
      oT = 0;
      kick();
    };

    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    apply();

    return () => {
      window.cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, [items.length]);

  return (
    <div className="tina-landing-ux-dark">
      <div ref={rootRef} className="ux u228" data-testid="lucian-cursor-glow-grid">
        <div className="u228-gd" role="list" aria-label={ariaLabel}>
          {items.map((item, i) => (
            <div
              key={item.num}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              className="u228-c"
              role="listitem"
            >
              <div className="u228-in">
                <div className="u228-top">
                  <span className="u228-ic" aria-hidden="true">
                    {i % 4 === 0 && (
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M5 19l7-14 7 14-7-3z" fill="#6EE7B7" />
                      </svg>
                    )}
                    {i % 4 === 1 && (
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M4 18V9M10 18V5M16 18v-6M22 18H2" stroke="#74C0FC" strokeWidth="2.2" strokeLinecap="round" />
                      </svg>
                    )}
                    {i % 4 === 2 && (
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" fill="#63E6BE" />
                      </svg>
                    )}
                    {i % 4 === 3 && (
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M4 14l4-4 4 4 8-8M14 6h6v6" stroke="#FFB547" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="u228-num">{item.num}</span>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
