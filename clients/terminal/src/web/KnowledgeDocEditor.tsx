"use client";
/** KnowledgeDocEditor — Notion-style clean page editor for non-tech users with Developer view raw mode.
 *  - Normal mode: Hides YAML `---` frontmatter cleanly, exposes a large Page Title input + optional Status
 *    selector (for Projects/Tasks), distraction-free 1-column writer (with Preview & Split toggles), visual
 *    "Link page" picker + `[[` wikilink autocomplete, and a single clean Save (`⌘S`) action.
 *  - Developer view: Unlocks Raw Markdown + YAML editing and custom Git commit message controls. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { WebIcon } from "./Icons";
import { MdxDoc } from "../ui-kit/MdxDoc";
import { DocMetaContext, DocNavContext, type DocNavigate } from "../ui-kit/docLinks";
import {
  CATEGORY_BY_ID,
  categorizePath,
  friendlyPageTitle,
  parseDocumentClean,
  patchFrontmatterField,
  updateCleanDocumentBody,
  updateCleanDocumentTitle,
} from "./knowledgeFriendly";
import styles from "./knowledgeView.module.css";

type EditorMode = "write" | "split" | "preview" | "raw";

const STATUS_OPTIONS = ["", "active", "in-progress", "open", "completed", "on-hold"] as const;

export function KnowledgeDocEditor({
  path,
  slug,
  initialContent,
  draft,
  onDraftChange,
  files,
  busy,
  devView,
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
  devView: boolean;
  commitOnSave: boolean;
  onCommitOnSaveChange: (v: boolean) => void;
  commitMsg: string;
  onCommitMsgChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onNavigateDoc: DocNavigate;
}) {
  const [mode, setMode] = useState<EditorMode>("write");
  const [cursorPos, setCursorPos] = useState<number>(0);
  const [acIndex, setAcIndex] = useState<number>(0);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkPickerQuery, setLinkPickerQuery] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // If Developer view is turned off while in "raw" mode, gracefully return to clean Write mode
  useEffect(() => {
    if (!devView && mode === "raw") setMode("write");
  }, [devView, mode]);

  const parsed = useMemo(() => parseDocumentClean(draft, path), [draft, path]);
  const [titleInput, setTitleInput] = useState<string>(() => parseDocumentClean(initialContent, path).displayTitle);

  useEffect(() => {
    setTitleInput(parseDocumentClean(initialContent, path).displayTitle);
  }, [path, initialContent]);
  const category = useMemo(() => categorizePath(path), [path]);
  const catMeta = CATEGORY_BY_ID[category];
  const isDirty = draft !== initialContent;
  const isRawMode = mode === "raw" && devView;
  const editorValue = isRawMode ? draft : parsed.bodyWithoutLeadingH1;

  const showStatusControl =
    !isRawMode &&
    parsed.hasFrontmatter &&
    (category === "projects" || category === "tasks" || Boolean(parsed.fieldMap.status));

  const setEditorText = (nextText: string) => {
    if (isRawMode) {
      onDraftChange(nextText);
    } else {
      onDraftChange(updateCleanDocumentBody(draft, path, nextText));
    }
  };

  const linkCandidates = useMemo(() => {
    return files
      .filter((f) => f.endsWith(".md") && f !== path && categorizePath(f) !== "system")
      .map((f) => ({
        path: f,
        label: friendlyPageTitle(f),
        category: CATEGORY_BY_ID[categorizePath(f)].singular,
      }));
  }, [files, path]);

  const wikiQuery = useMemo(() => {
    const before = editorValue.slice(0, cursorPos);
    const m = before.match(/\[\[([^\[\]\n]*)$/);
    if (!m) return null;
    return { query: m[1], start: cursorPos - m[1].length - 2 };
  }, [editorValue, cursorPos]);

  const suggestions = useMemo(() => {
    if (!wikiQuery) return [];
    const q = wikiQuery.query.trim().toLowerCase();
    return linkCandidates
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
      .slice(0, 7);
  }, [wikiQuery, linkCandidates]);

  const pickerMatches = useMemo(() => {
    const q = linkPickerQuery.trim().toLowerCase();
    return linkCandidates
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q))
      .slice(0, 10);
  }, [linkCandidates, linkPickerQuery]);

  const applyWikilink = (label: string) => {
    if (!wikiQuery) return;
    const before = editorValue.slice(0, wikiQuery.start);
    const after = editorValue.slice(cursorPos);
    const inserted = `[[${label}]]`;
    const next = `${before}${inserted}${after}`;
    const nextPos = before.length + inserted.length;
    setEditorText(next);
    setCursorPos(nextPos);
    setAcIndex(0);
    window.requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(nextPos, nextPos);
    });
  };

  const insertPageLinkAtCursor = (label: string) => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? editorValue.length;
    const end = ta?.selectionEnd ?? editorValue.length;
    const inserted = `[[${label}]]`;
    const next = `${editorValue.slice(0, start)}${inserted}${editorValue.slice(end)}`;
    const nextPos = start + inserted.length;
    setEditorText(next);
    setCursorPos(nextPos);
    setLinkPickerOpen(false);
    setLinkPickerQuery("");
    window.requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(nextPos, nextPos);
    });
  };

  const wrapSelection = (prefix: string, suffix = "", placeholder = "") => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? editorValue.length;
    const end = ta?.selectionEnd ?? editorValue.length;
    const selected = editorValue.slice(start, end) || placeholder;
    const next = `${editorValue.slice(0, start)}${prefix}${selected}${suffix}${editorValue.slice(end)}`;
    const nextEnd = start + prefix.length + selected.length;
    setEditorText(next);
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

  const modeButtons: ReadonlyArray<readonly [EditorMode, string]> = devView
    ? [
        ["write", "Write"],
        ["split", "Split"],
        ["preview", "Preview"],
        ["raw", "Raw"],
      ]
    : [
        ["write", "Write"],
        ["split", "Split"],
        ["preview", "Preview"],
      ];

  return (
    <div className={styles.editorWrap}>
      {/* ── Clean Notion-style Title & Status Header (hidden in Raw dev mode) ── */}
      {!isRawMode && (
        <div className={styles.cleanEditorHeader}>
          <div className={styles.cleanEditorMetaRow}>
            <span className={styles.categoryPill}>
              <WebIcon name={catMeta.icon} size={12} />
              <span>{catMeta.singular}</span>
            </span>
            {showStatusControl && (
              <label className={styles.statusSelectWrap}>
                <span>Status</span>
                <select
                  aria-label="Page status"
                  className={styles.statusSelect}
                  value={(parsed.fieldMap.status ?? "").toLowerCase()}
                  onChange={(e) => onDraftChange(patchFrontmatterField(draft, "status", e.target.value))}
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt || "none"} value={opt}>
                      {opt ? opt.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "None"}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <input
            type="text"
            className={styles.cleanTitleInput}
            aria-label="Page title"
            placeholder="Untitled page"
            value={titleInput}
            onChange={(e) => {
              const nextTitle = e.target.value;
              setTitleInput(nextTitle);
              onDraftChange(updateCleanDocumentTitle(draft, path, nextTitle));
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                onSave();
              } else if (e.key === "Enter") {
                e.preventDefault();
                taRef.current?.focus();
              }
            }}
          />
        </div>
      )}

      {/* ── Formatting & View Toolbar ── */}
      <div className={styles.editorToolbar}>
        <div className={styles.railHeadActions} style={{ flexWrap: "wrap", position: "relative" }}>
          <button
            type="button"
            className={styles.tinyBtn}
            title="Add section heading"
            onClick={() => wrapSelection("## ", "", "Section heading")}
          >
            Heading
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            title="Bold"
            onClick={() => wrapSelection("**", "**", "bold text")}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            title="Italic"
            onClick={() => wrapSelection("_", "_", "italic")}
          >
            <em>I</em>
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            title="Bullet list"
            onClick={() => wrapSelection("- ", "", "Item")}
          >
            • List
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            title="Checklist item"
            onClick={() => wrapSelection("- [ ] ", "", "Follow up")}
          >
            ☐ Checklist
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            title="Link to another page in this space"
            aria-expanded={linkPickerOpen}
            onClick={() => {
              setLinkPickerOpen((v) => !v);
              setLinkPickerQuery("");
            }}
          >
            <WebIcon name="link" size={12} />
            <span>Link page</span>
          </button>
          {devView && (
            <button
              type="button"
              className={styles.tinyBtn}
              title="Inline code"
              onClick={() => wrapSelection("`", "`", "code")}
            >
              {"</>"}
            </button>
          )}

          {linkPickerOpen && (
            <div className={styles.linkPickerPopover} role="dialog" aria-label="Link another page">
              <div className={styles.searchBox} style={{ height: 30 }}>
                <WebIcon name="search" size={12} />
                <input
                  type="search"
                  autoFocus
                  aria-label="Search pages to link"
                  placeholder="Find a page to link…"
                  value={linkPickerQuery}
                  onChange={(e) => setLinkPickerQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setLinkPickerOpen(false);
                  }}
                />
              </div>
              <div className={styles.linkPickerList}>
                {pickerMatches.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className={styles.acItem}
                    onClick={() => insertPageLinkAtCursor(item.label)}
                  >
                    <span>{item.label}</span>
                    <span className={styles.wsTag}>{item.category}</span>
                  </button>
                ))}
                {pickerMatches.length === 0 && (
                  <div className={styles.cardSub} style={{ padding: "8px 10px" }}>
                    No other pages found.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className={styles.railHeadActions}>
          {isDirty && (
            <>
              <span className={styles.unsavedBadge}>● Unsaved</span>
              <button
                type="button"
                className={styles.tinyBtn}
                onClick={() => {
                  onDraftChange(initialContent);
                  setTitleInput(parseDocumentClean(initialContent, path).displayTitle);
                }}
              >
                Revert
              </button>
            </>
          )}
          <div className={styles.tabs} style={{ padding: 2 }}>
            {modeButtons.map(([m, label]) => (
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

      {/* ── Writing / Preview Canvas ── */}
      <div className={`${styles.editorGrid} ${mode === "split" ? styles.editorGridSplit : ""}`}>
        {mode !== "preview" && (
          <div style={{ position: "relative" }}>
            <textarea
              ref={taRef}
              className={`${styles.editorTextarea} ${isRawMode ? styles.editorTextareaRaw : styles.editorTextareaClean}`}
              aria-label={isRawMode ? "Raw Markdown editor" : "Page content editor"}
              placeholder={
                isRawMode
                  ? "Write Markdown and YAML frontmatter…"
                  : "Start writing your notes here… Type [[ to link another page."
              }
              value={editorValue}
              onChange={(e) => {
                setEditorText(e.target.value);
                setCursorPos(e.target.selectionStart);
                setAcIndex(0);
              }}
              onClick={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onKeyDown={handleKeyDown}
            />
            {suggestions.length > 0 && (
              <div className={styles.acPopover} role="listbox" aria-label="Page link suggestions">
                <div className={styles.acHead}>Link a page · Tab or Enter to insert</div>
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
                    <span className={styles.acPath}>{devView ? item.path : item.category}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {mode !== "write" && mode !== "raw" && (
          <div className={styles.editorPreviewPane}>
            <div className={styles.docProse}>
              <DocNavContext.Provider value={onNavigateDoc}>
                <DocMetaContext.Provider value={{ path, slug }}>
                  <MdxDoc>{parsed.bodyWithoutLeadingH1}</MdxDoc>
                </DocMetaContext.Provider>
              </DocNavContext.Provider>
            </div>
          </div>
        )}
      </div>

      {/* ── Save Bar (clean by default; Git commit options revealed in Developer view) ── */}
      <div className={styles.editorBar}>
        {devView ? (
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
        ) : (
          <span className={styles.cardSub} style={{ fontSize: 12 }}>
            Changes are automatically saved to version history.
          </span>
        )}
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
            <span>{busy ? "Saving…" : "Save changes"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
