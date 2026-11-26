"use client";
// Lucian UX/UI Prompt #046 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#046
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { WebIcon, type WebIconName } from "../Icons";
import "./lucian-046.css";

export interface LucianCommandItem {
  id: string;
  group: string;
  label: string;
  detail: string;
  icon: WebIconName;
  gradient?: string;
  shortcut?: string;
  run: () => void;
}

function renderMatch(text: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function LucianCommandPalette({
  query,
  onQueryChange,
  items,
  onClose,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  items: LucianCommandItem[];
  onClose: () => void;
}) {
  const uid = useId();
  const [activeIdx, setActiveIdx] = useState(0);
  const [ranLabel, setRanLabel] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const firstMeasureRef = useRef(true);

  useEffect(() => {
    setActiveIdx(0);
    firstMeasureRef.current = true;
  }, [query, items.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const safeIdx = items.length > 0 ? Math.min(Math.max(activeIdx, 0), items.length - 1) : -1;

  useLayoutEffect(() => {
    const hl = hlRef.current;
    const body = bodyRef.current;
    if (!hl || !body) return;
    const opt = safeIdx >= 0 ? optionRefs.current[safeIdx] : null;
    if (!opt) {
      hl.style.opacity = "0";
      return;
    }
    const instant = firstMeasureRef.current;
    firstMeasureRef.current = false;
    if (instant) hl.style.transition = "none";
    const top = opt.offsetTop + 6;
    const h = opt.offsetHeight || 50;
    hl.style.opacity = "1";
    hl.style.height = `${h}px`;
    hl.style.setProperty("--y", `${top}px`);
    if (instant) {
      void hl.offsetWidth;
      hl.style.transition = "";
    }
    if (typeof body.scrollTo === "function") {
      if (top + h > body.scrollTop + body.clientHeight) {
        body.scrollTo({ top: top + h - body.clientHeight + 6, behavior: instant ? "auto" : "smooth" });
      } else if (top < body.scrollTop + 30) {
        body.scrollTo({ top: safeIdx === 0 ? 0 : Math.max(0, top - 30), behavior: instant ? "auto" : "smooth" });
      }
    }
  }, [safeIdx, items]);

  const executeItem = (idx: number) => {
    const item = items[idx];
    if (!item) return;
    const opt = optionRefs.current[idx];
    if (opt && typeof opt.animate === "function") {
      opt.animate([{ transform: "scale(.98)" }, { transform: "none" }], { duration: 220, easing: "ease-out" });
    }
    setRanLabel(`Ran '${item.label}'`);
    item.run();
  };

  let lastGroup = "";

  return (
    <div className="ux u046" data-testid="lucian-command-palette" onClick={(e) => e.stopPropagation()}>
      <div className="u046-pal">
        <label className="u046-field">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          <input
            ref={inputRef}
            className="u046-in"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={`${uid}-list`}
            aria-activedescendant={safeIdx >= 0 ? `${uid}-opt-${safeIdx}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (items.length === 0) return;
                setActiveIdx((cur) => (cur + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (safeIdx >= 0) executeItem(safeIdx);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
            placeholder="Search meetings, knowledge, or run a command…"
            aria-label="Search query"
          />
          <button type="button" className="u046-close" aria-label="Close search" onClick={onClose}>
            <kbd className="u046-kbd">esc</kbd>
          </button>
        </label>

        <div ref={bodyRef} className="u046-body">
          <span ref={hlRef} className="u046-hl" aria-hidden="true" />
          <ul id={`${uid}-list`} className="u046-list" role="listbox" aria-label="Search results and commands">
            {items.map((item, idx) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.id} role="presentation">
                  {showGroup && (
                    <li className="u046-g" role="presentation">
                      {item.group}
                    </li>
                  )}
                  <li
                    ref={(el) => {
                      optionRefs.current[idx] = el;
                    }}
                    id={`${uid}-opt-${idx}`}
                    role="option"
                    aria-selected={idx === safeIdx}
                    className="u046-op"
                    style={{ "--i": Math.min(idx, 10) } as React.CSSProperties}
                    onPointerMove={() => {
                      if (activeIdx !== idx) setActiveIdx(idx);
                    }}
                    onClick={() => executeItem(idx)}
                  >
                    <span
                      className={`u046-ic ${item.gradient ? "" : "plain"}`}
                      style={item.gradient ? ({ "--c": item.gradient } as React.CSSProperties) : undefined}
                      aria-hidden="true"
                    >
                      <WebIcon name={item.icon} size={15} />
                    </span>
                    <span className="u046-copy">
                      <span className="u046-title">{renderMatch(item.label, query)}</span>
                      <span className="u046-detail">{item.detail}</span>
                    </span>
                    {item.shortcut && <kbd className="u046-kbd">{item.shortcut}</kbd>}
                  </li>
                </div>
              );
            })}

            {items.length === 0 && (
              <li className="u046-empty" role="presentation">
                <b>No results for “{query.trim()}”</b>
                Try another meeting title, page, or command.
              </li>
            )}
          </ul>
        </div>

        <div className="u046-foot" aria-hidden="true">
          <span>
            <kbd className="u046-kbd">↑↓</kbd>Move
          </span>
          <span>
            <kbd className="u046-kbd">↵</kbd>Run
          </span>
          <span className={`u046-done ${ranLabel ? "show" : ""}`}>{ranLabel}</span>
        </div>
      </div>
    </div>
  );
}
