"use client";
// Lucian UX/UI Prompt #250 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#250
import { useEffect, useRef, useState } from "react";
import "./lucian-250.css";

export function LucianUnsavedBar({
  dirty,
  changeCount,
  saving = false,
  saveDisabled = false,
  savedMessage = "Saved",
  warnSignal = 0,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  changeCount?: number;
  saving?: boolean;
  saveDisabled?: boolean;
  savedMessage?: string;
  warnSignal?: number;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const [showSaved, setShowSaved] = useState(false);
  const [warnActive, setWarnActive] = useState(false);
  const prevSavingRef = useRef(saving);
  const prevDirtyRef = useRef(dirty);
  const saveBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Transition from saving -> saved (dirty became false)
    if (prevSavingRef.current && !saving && !dirty) {
      setShowSaved(true);
      const timer = window.setTimeout(() => setShowSaved(false), 1100);
      prevSavingRef.current = saving;
      prevDirtyRef.current = dirty;
      return () => window.clearTimeout(timer);
    }
    if (dirty && !prevDirtyRef.current) {
      setShowSaved(false);
    }
    prevSavingRef.current = saving;
    prevDirtyRef.current = dirty;
  }, [saving, dirty]);

  useEffect(() => {
    if (!warnSignal || !dirty) return;
    setWarnActive(true);
    saveBtnRef.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setWarnActive(false), 1600);
    return () => window.clearTimeout(timer);
  }, [warnSignal, dirty]);

  const isOpen = dirty || showSaved;
  const labelText = showSaved
    ? savedMessage
    : warnActive
      ? "Save or discard first"
      : typeof changeCount === "number" && changeCount > 0
        ? `Unsaved changes: ${changeCount}`
        : "Unsaved changes";

  return (
    <div
      className={`ux u250-wrap ${isOpen ? "is-open" : ""}`}
      data-testid="lucian-unsaved-bar"
      aria-hidden={!isOpen || undefined}
    >
      <div className="u250-inner">
        <div
          className={`u250-br ${warnActive ? "is-warn" : ""} ${showSaved ? "is-ok" : ""}`}
          role="status"
        >
          <span className="u250-tx">{labelText}</span>
          <button
            type="button"
            className="u250-cx"
            tabIndex={isOpen && !showSaved ? 0 : -1}
            disabled={saving || showSaved}
            onClick={onDiscard}
          >
            Discard
          </button>
          <button
            ref={saveBtnRef}
            type="button"
            className={`u250-sv ${saving ? "is-busy" : ""}`}
            tabIndex={isOpen && !showSaved ? 0 : -1}
            disabled={saving || saveDisabled || showSaved}
            aria-label="Save unsaved changes"
            onClick={onSave}
          >
            <i aria-hidden="true" />
            <b>Save</b>
          </button>
        </div>
      </div>
    </div>
  );
}
