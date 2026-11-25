"use client";
/** KnowledgeDocEditor — Upgraded Markdown editor with Split Live Preview, formatting toolbar,
 *  `[[` wikilink autocomplete popover, unsaved-draft status/revert, and Cmd/Ctrl+S save. */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { WebIcon } from "./Icons";
import { MdxDoc } from "../ui-kit/MdxDoc";
import { DocMetaContext, DocNavContext, type DocNavigate } from "../ui-kit/docLinks";
import styles from "./knowledgeView.module.css";

type EditorMode = "split" | "write" | "preview";

function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return m ? m[1] : text;
}

function labelFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

export function KnowledgeDocEditor({
  path,
  slug,
  initialContent,
  draft,
  onDraftChange,
  files,
  busy,
  commitOnSave,
  onCommitOnSaveChange,
  commitMsg,
  onCommitMsgChange,
  onSave,
  onCancel,
  onNavigateDoc,
}: {
  path: string;
  slug?: string;
  initialContent: string;
  draft: string;
  onDraftChange: (next: string) => void;
  files: string[];
  busy: boolean;
  commitOnSave: boolean;
  onCommitOnSaveChange: (v: boolean) => void;
  commitMsg: string;
  onCommitMsgChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onNavigateDoc: DocNavigate;
}) {
  const [mode, setMode] = useState<EditorMode>("split");
  const [cursorPos, setCursorPos] = useState<number>(0);
  const [acIndex, setAcIndex] = useState<number>(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const isDirty = draft !== initialContent;

  const linkCandidates = useMemo(() => {
    return files
      .filter((f) => f.endsWith(".md") && f !== path)
      .map((f) => ({
        path: f,
        label: labelFromPath(f),
      }));
  }, [files, path]);

  const wikiQuery = useMemo(() => {
    const before = draft.slice(0, cursorPos);
    const m = before.match(/\[\[([^\[\]\n]*)$/);
    if (!m) return null;
    return { query: m[1], start: cursorPos - m[1].length - 2 };
  }, [draft, cursorPos]);

  const suggestions = useMemo(() => {
    if (!wikiQuery) return [];
    const q = wikiQuery.query.trim().toLowerCase();
    return linkCandidates
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
      .slice(0, 7);
  }, [wikiQuery, linkCandidates]);

  const applyWikilink = (label: string) => {
    if (!wikiQuery) return;
    const before = draft.slice(0, wikiQuery.start);
    const after = draft.slice(cursorPos);
    const inserted = `[[${label}]]`;
    const next = `${before}${inserted}${after}`;
    const nextPos = before.length + inserted.length;
    onDraftChange(next);
    setCursorPos(nextPos);
    setAcIndex(0);
    window.requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(nextPos, nextPos);
    });
  };

  const wrapSelection = (prefix: string, suffix = "", placeholder = "") => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? draft.length;
    const end = ta?.selectionEnd ?? draft.length;
    const selected = draft.slice(start, end) || placeholder;
    const next = `${draft.slice(0, start)}${prefix}${selected}${suffix}${draft.slice(end)}`;
    const nextEnd = start + prefix.length + selected.length;
    onDraftChange(next);
    setCursorPos(nextEnd);
    window.requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(start + prefix.length, nextEnd);
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave();
      return;
    }
    if (suggestions.length > 0 && wikiQuery) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const chosen = suggestions[Math.min(acIndex, suggestions.length - 1)];
        if (chosen) applyWikilink(chosen.label);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCursorPos(0);
        return;
      }
    }
  };

  return (
    <div className={styles.editorWrap}>
      <div className={styles.editorToolbar}>
        <div className={styles.railHeadActions}>
          <button type="button" className={styles.tinyBtn} title="Heading 2" onClick={() => wrapSelection("## ", "", "Section heading")}>
            H2
          </button>
          <button type="button" className={styles.tinyBtn} title="Bold" onClick={() => wrapSelection("**", "**", "bold text")}>
            <strong>B</strong>
          </button>
          <button type="button" className={styles.tinyBtn} title="Italic" onClick={() => wrapSelection("_", "_", "italic")}>
            <em>I</em>
          </button>
          <button type="button" className={styles.tinyBtn} title="Bullet list" onClick={() => wrapSelection("- ", "", "Item")}>
            • List
          </button>
          <button type="button" className={styles.tinyBtn} title="Task checkbox" onClick={() => wrapSelection("- [ ] ", "", "Follow up")}>
            ☐ Task
          </button>
          <button type="button" className={styles.tinyBtn} title="Inline code" onClick={() => wrapSelection("`", "`", "code")}>
            {"</>"}
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            title="Insert [[wikilink]]"
            onClick={() => wrapSelection("[[", "", "")}
          >
            [[Link]]
          </button>
        </div>

        <div className={styles.railHeadActions}>
          {isDirty && (
            <>
              <span className={styles.unsavedBadge}>● Unsaved</span>
              <button
                type="button"
                className={styles.tinyBtn}
                onClick={() => onDraftChange(initialContent)}
              >
                Revert
              </button>
            </>
          )}
          <div className={styles.tabs} style={{ padding: 2 }}>
            {(
              [
                ["write", "Write"],
                ["split", "Split"],
                ["preview", "Preview"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                className={`${styles.tabBtn} ${mode === m ? styles.tabBtnActive : ""}`}
                style={{ height: 24, padding: "0 9px", fontSize: 11.5 }}
                onClick={() => setMode(m)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={`${styles.editorGrid} ${mode === "split" ? styles.editorGridSplit : ""}`}>
        {mode !== "preview" && (
          <div style={{ position: "relative" }}>
            <textarea
              ref={taRef}
              className={styles.editorTextarea}
              aria-label="Markdown editor"
              value={draft}
              onChange={(e) => {
                onDraftChange(e.target.value);
                setCursorPos(e.target.selectionStart);
                setAcIndex(0);
              }}
              onClick={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onKeyDown={handleKeyDown}
            />
            {suggestions.length > 0 && (
              <div className={styles.acPopover} role="listbox" aria-label="Wikilink suggestions">
                <div className={styles.acHead}>Insert [[wikilink]] · Tab/Enter to accept</div>
                {suggestions.map((item, idx) => (
                  <button
                    key={item.path}
                    type="button"
                    role="option"
                    aria-selected={idx === acIndex}
                    className={`${styles.acItem} ${idx === acIndex ? styles.acItemActive : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyWikilink(item.label);
                    }}
                  >
                    <span>{item.label}</span>
                    <span className={styles.acPath}>{item.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {mode !== "write" && (
          <div className={styles.editorPreviewPane}>
            <div className={styles.docProse}>
              <DocNavContext.Provider value={onNavigateDoc}>
                <DocMetaContext.Provider value={{ path, slug }}>
                  <MdxDoc>{stripFrontmatter(draft)}</MdxDoc>
                </DocMetaContext.Provider>
              </DocNavContext.Provider>
            </div>
          </div>
        )}
      </div>

      <div className={styles.editorBar}>
        <div className={styles.inlineForm}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={commitOnSave}
              onChange={(e) => onCommitOnSaveChange(e.target.checked)}
            />
            <span>Commit to Git history</span>
          </label>
          {commitOnSave && (
            <input
              type="text"
              className={styles.input}
              style={{ maxWidth: 280 }}
              placeholder={`Update ${path}`}
              aria-label="Commit message"
              value={commitMsg}
              onChange={(e) => onCommitMsgChange(e.target.value)}
            />
          )}
        </div>
        <div className={styles.inlineForm}>
          <button type="button" className={styles.btn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={busy}
            onClick={onSave}
          >
            <WebIcon name="check" size={13} />
            <span>{busy ? "Saving…" : "Save (⌘S)"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
