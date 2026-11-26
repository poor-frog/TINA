"use client";
// Lucian UX/UI Prompt #471 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#471
import { useEffect, useRef, useState } from "react";
import "./lucian-471.css";

interface CapElement extends HTMLElement {
  _at?: number;
  _t?: number;
}

interface ButtonElement extends HTMLButtonElement {
  _t?: number;
}

export function LucianCommandKButton({
  label = "Search meetings, tasks, or actions",
  ariaLabel = "Search meetings and tasks",
  onTrigger,
}: {
  label?: string;
  ariaLabel?: string;
  onTrigger: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<ButtonElement>(null);
  const modRef = useRef<CapElement>(null);
  const keyRef = useRef<CapElement>(null);
  const ksRef = useRef<HTMLSpanElement>(null);
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  const [isMac, setIsMac] = useState(true);

  useEffect(() => {
    const plat =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      navigator.userAgent ||
      "";
    setIsMac(/mac|iphone|ipad|ipod/i.test(plat));
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const b = btnRef.current;
    const mod = modRef.current;
    const key = keyRef.current;
    const ks = ksRef.current;
    if (!root || !b || !mod || !key || !ks) return;

    const rm =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: number[] = [];
    let hovered = false;
    let modHeld = false;
    let pressed = false;
    let mounted = true;

    const later = (fn: () => void, ms: number) => {
      const t = window.setTimeout(() => {
        if (mounted && root.isConnected) fn();
      }, ms);
      timers.push(t);
      return t;
    };

    const down = (cap: CapElement) => {
      cap.classList.add("is-down");
      cap._at = performance.now();
    };

    const up = (cap: CapElement) => {
      const left = 150 - (performance.now() - (cap._at || 0));
      if (cap._t) window.clearTimeout(cap._t);
      if (left > 0) cap._t = later(() => cap.classList.remove("is-down"), left);
      else cap.classList.remove("is-down");
    };

    const answer = () => {
      if (!rm) {
        const br = b.getBoundingClientRect();
        const kr = ks.getBoundingClientRect();
        const sc = br.width / (b.offsetWidth || 1) || 1;
        const rp = document.createElement("span");
        rp.className = "u471-rp";
        rp.style.left = `${(kr.left + kr.width / 2 - br.left) / sc}px`;
        rp.style.top = `${(kr.top + kr.height / 2 - br.top) / sc}px`;
        b.appendChild(rp);
        later(() => rp.remove(), 800);
      }
      b.classList.remove("is-pop");
      void b.offsetWidth;
      b.classList.add("is-hit", "is-pop");
      if (b._t) window.clearTimeout(b._t);
      b._t = later(() => b.classList.remove("is-hit"), 420);
      later(() => b.classList.remove("is-pop"), 600);
    };

    const chord = () => {
      key.classList.remove("is-ask");
      const wasHeld = mod.classList.contains("is-down");
      if (!wasHeld) down(mod);
      later(
        () => {
          down(key);
          answer();
          later(
            () => {
              up(key);
              if (!modHeld) up(mod);
            },
            rm ? 120 : 170,
          );
        },
        wasHeld || rm ? 0 : 70,
      );
    };

    const isMod = (e: KeyboardEvent) => e.key === "Meta" || e.key === "Control" || e.key === "OS";

    const onKey = (e: KeyboardEvent) => {
      if (e.type === "keydown") {
        if (isMod(e)) {
          if (!e.repeat) {
            modHeld = true;
            down(mod);
            key.classList.add("is-ask");
          }
          return;
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K") && !e.altKey && !e.shiftKey) {
          if (!e.repeat) chord();
        }
      } else if (isMod(e)) {
        modHeld = false;
        key.classList.remove("is-ask");
        up(mod);
      }
    };

    const onDoc = (e: KeyboardEvent) => {
      if (root.contains(e.target as Node)) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && !root.contains(a) && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) {
        return;
      }
      if (e.type === "keydown" && (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K") && !e.altKey && !e.shiftKey) {
        if (!e.repeat) chord();
        return;
      }
      if (!hovered && !(e.type === "keyup" && modHeld)) return;
      onKey(e);
    };

    const reset = () => {
      modHeld = false;
      hovered = false;
      pressed = false;
      key.classList.remove("is-ask");
      mod.classList.remove("is-down");
      key.classList.remove("is-down");
      b.classList.remove("is-down");
    };

    const onPointerEnter = () => {
      hovered = true;
    };
    const onPointerLeave = () => {
      hovered = false;
      if (modHeld) {
        modHeld = false;
        key.classList.remove("is-ask");
        up(mod);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pressed = true;
      b.classList.add("is-down");
      down(mod);
      later(() => {
        if (pressed) down(key);
      }, rm ? 0 : 50);
    };
    const release = () => {
      if (!pressed) return;
      pressed = false;
      b.classList.remove("is-down");
      up(key);
      later(() => {
        if (!modHeld) up(mod);
      }, rm ? 0 : 40);
    };
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) chord();
      else answer();
      onTriggerRef.current();
    };

    root.addEventListener("keydown", onKey);
    root.addEventListener("keyup", onKey);
    root.addEventListener("pointerenter", onPointerEnter);
    root.addEventListener("pointerleave", onPointerLeave);
    b.addEventListener("pointerdown", onPointerDown);
    b.addEventListener("pointerup", release);
    b.addEventListener("pointerleave", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("click", onClick);
    window.addEventListener("keydown", onDoc, true);
    window.addEventListener("keyup", onDoc, true);
    window.addEventListener("blur", reset);

    return () => {
      mounted = false;
      timers.forEach((id) => window.clearTimeout(id));
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("keyup", onKey);
      root.removeEventListener("pointerenter", onPointerEnter);
      root.removeEventListener("pointerleave", onPointerLeave);
      b.removeEventListener("pointerdown", onPointerDown);
      b.removeEventListener("pointerup", release);
      b.removeEventListener("pointerleave", release);
      b.removeEventListener("pointercancel", release);
      b.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onDoc, true);
      window.removeEventListener("keyup", onDoc, true);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return (
    <div ref={rootRef} className="ux u471" data-testid="lucian-command-k">
      <button
        ref={btnRef}
        type="button"
        className="u471-b"
        aria-label={ariaLabel}
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      >
        <svg className="u471-ic" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <span className="u471-l">{label}</span>
        <span ref={ksRef} className="u471-ks" aria-hidden="true">
          <kbd ref={modRef} className={`u471-k ${!isMac ? "is-wide" : ""}`}>
            <span className="u471-t">{isMac ? "⌘" : "Ctrl"}</span>
          </kbd>
          <kbd ref={keyRef} className="u471-k">
            <span className="u471-t">K</span>
          </kbd>
        </span>
      </button>
    </div>
  );
}
