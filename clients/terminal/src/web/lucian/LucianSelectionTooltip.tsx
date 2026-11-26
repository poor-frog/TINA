"use client";
// Lucian UX/UI Prompt #220 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#220
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { emitWebToast } from "./webToast";
import "./lucian-220.css";

interface SelectionState {
  text: string;
  x: number;
  y: number;
  segmentKey?: string;
}

export function LucianSelectionTooltip({
  containerRef,
  onAskQuote,
  onToggleHighlight,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onAskQuote?: (quote: string) => void;
  onToggleHighlight?: (segmentKey: string) => void;
}) {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [copied, setCopied] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setCopied(false);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const inspectSelection = () => {
      const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        clearSelection();
        return;
      }
      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      if (!anchor || !focus || !container.contains(anchor) || !container.contains(focus)) {
        clearSelection();
        return;
      }
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 3) {
        clearSelection();
        return;
      }
      const range = sel.getRangeAt(0);
      const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
      const rect = (rects && rects[0]) || range.getBoundingClientRect();
      if (!rect) return;
      const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
      const x = Math.max(96, Math.min(vw - 96, rect.left + rect.width / 2));
      const y = Math.max(54, rect.top);
      const anchorEl = anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement;
      const row = anchorEl?.closest?.("[data-quote-key]") as HTMLElement | null;
      setCopied(false);
      setSelection({ text, x, y, segmentKey: row?.dataset.quoteKey });
    };

    const onMouseDown = (e: MouseEvent) => {
      if (tipRef.current?.contains(e.target as Node)) return;
      clearSelection();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    const onScroll = () => clearSelection();

    container.addEventListener("mouseup", inspectSelection);
    container.addEventListener("keyup", inspectSelection);
    container.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      container.removeEventListener("mouseup", inspectSelection);
      container.removeEventListener("keyup", inspectSelection);
      container.removeEventListener("scroll", onScroll);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, [containerRef, clearSelection]);

  const handleCopy = () => {
    if (!selection) return;
    const quoted = `“${selection.text}”`;
    try {
      void navigator.clipboard?.writeText(quoted).catch(() => undefined);
    } catch {
      /* ignore */
    }
    setCopied(true);
    emitWebToast("Quote copied");
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(clearSelection, 650);
  };

  const handleAsk = () => {
    if (!selection || !onAskQuote) return;
    const quote = selection.text.slice(0, 420);
    onAskQuote(quote);
    window.getSelection?.()?.removeAllRanges();
    clearSelection();
  };

  const handleHighlight = () => {
    if (!selection?.segmentKey || !onToggleHighlight) return;
    onToggleHighlight(selection.segmentKey);
    emitWebToast({ message: "Quote highlighted", tone: "info" });
    window.getSelection?.()?.removeAllRanges();
    clearSelection();
  };

  return (
    <div
      ref={tipRef}
      className={`ux u220-tip ${selection ? "is-on" : ""}`}
      role="toolbar"
      aria-label="Quote tools"
      data-testid="lucian-selection-tooltip"
      style={
        selection
          ? { left: `${selection.x.toFixed(0)}px`, top: `${selection.y.toFixed(0)}px` }
          : undefined
      }
      onMouseDown={(e) => e.preventDefault()}
    >
      {onAskQuote && (
        <button
          type="button"
          className="u220-ask"
          aria-label="Ask Tina about selection"
          title="Ask Tina about this quote"
          onClick={handleAsk}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2c.7 4.7 4.5 8.5 9.2 9.2-4.7.7-8.5 4.5-9.2 9.2-.7-4.7-4.5-8.5-9.2-9.2C7.5 10.5 11.3 6.7 12 2Z"
              fill="currentColor"
            />
          </svg>
          <span>Ask Tina</span>
        </button>
      )}

      {onToggleHighlight && selection?.segmentKey && (
        <button
          type="button"
          className="u220-hl"
          aria-label="Highlight selection"
          title="Highlight quote"
          onClick={handleHighlight}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.5 2.5l4 4-6 6H3.5v-4z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M2 14.5h12" stroke="#FDE047" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}

      <button
        type="button"
        className={`u220-cp ${copied ? "is-ok" : ""}`}
        aria-label="Copy quote"
        title="Copy quote"
        onClick={handleCopy}
      >
        <svg className="u220-cpi" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <svg className="u220-ok" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="#4ADE80" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
