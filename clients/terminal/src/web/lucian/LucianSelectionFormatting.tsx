"use client";
// Lucian UX/UI Prompt #140 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#140
import { useState } from "react";
import "./lucian-140.css";

export function LucianSelectionFormatting({
  selectedText,
  onWrap,
}: {
  selectedText: string;
  onWrap: (prefix: string, suffix: string, placeholder: string) => void;
}) {
  const [status, setStatus] = useState("");
  const visible = selectedText.trim().length > 0;

  const isBold = /^\*\*[\s\S]+\*\*$/.test(selectedText.trim());
  const isItalic = /^_[\s\S]+_$/.test(selectedText.trim()) || /^\*[^*][\s\S]*[^*]\*$/.test(selectedText.trim());
  const isCode = /^`[\s\S]+`$/.test(selectedText.trim());
  const isLink = /^\[\[[\s\S]+\]\]$/.test(selectedText.trim());

  const apply = (prefix: string, suffix: string, placeholder: string, name: string) => {
    onWrap(prefix, suffix, placeholder);
    setStatus(`${name} applied`);
  };

  return (
    <div
      className={`ux u140-bar ${visible ? "is-on" : ""}`}
      role="toolbar"
      aria-label="Selection text formatting"
      data-testid="lucian-selection-formatting"
      aria-hidden={!visible || undefined}
      onPointerDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        aria-label="Bold selected text"
        aria-pressed={isBold}
        tabIndex={visible ? 0 : -1}
        onClick={() => apply("**", "**", "bold text", "Bold")}
      >
        B
      </button>
      <button
        type="button"
        aria-label="Italicize selected text"
        aria-pressed={isItalic}
        tabIndex={visible ? 0 : -1}
        onClick={() => apply("_", "_", "italic", "Italic")}
      >
        <em>I</em>
      </button>
      <button
        type="button"
        aria-label="Format selected text as code"
        aria-pressed={isCode}
        tabIndex={visible ? 0 : -1}
        onClick={() => apply("`", "`", "code", "Inline code")}
      >
        {"</>"}
      </button>
      <button
        type="button"
        aria-label="Link selected text as page"
        aria-pressed={isLink}
        tabIndex={visible ? 0 : -1}
        onClick={() => apply("[[", "]]", "Page name", "Page link")}
      >
        [[ ]]
      </button>
      <span className="u140-sr" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
