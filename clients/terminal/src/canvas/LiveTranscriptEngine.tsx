"use client";
/** The ONE live-transcript render engine (P23: the terminal RENDERS, it does not re-derive). It paints a
 *  list of segments — CONFIRMED text is stable + append-only (consecutive same-speaker segments merge into
 *  one flowing block), while every in-flight PENDING speaker window stays visible as a dimmed live tail.
 *  Fed RAW segments (transcript) or PROCESSED segments
 *  (the cleaned mirror, which also carry keyword `tags` to research) by exactly the same code; the toggle
 *  picks the source, not the engine.
 *
 *  PROCESSED v2 rendering: when `entities` is supplied, entity mentions are highlighted INLINE (colored
 *  by kind, clickable → Research · Open entity doc) and copilot `signals` render as small
 *  actionable badges under the relevant block. RAW mode passes neither, so it stays plain text. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { recordAsrTiming } from "../lib/asrTelemetry";
import { splitTextIntoSpans, type SpanEntity } from "./inlineSpans";
import { entityColor } from "../ui-kit/docLinks";
import styles from "./MeetingTranscript.module.css";
import type { TranscriptLanguage } from "./MeetingTranslation";
import type { PhraseTranslation } from "./translationGroups";
import {formatTranscript} from '../../../../packages/transcript-rendering/src/format';

export interface EngineTag { label: string; kind: string }
export interface EngineEntity { id?: string; label: string; kind: string; docPath?: string }
export interface EngineSignal { id: string; kind: string; label: string }
export interface EngineSegment { speakerId?: string; speakerKey?: string; speaker?: string; text: string; tsMs?: number; endTsMs?: number; id?: string; completed?: boolean; tags?: EngineTag[]; stale?: boolean; evidence?: unknown[]; translation?: PhraseTranslation }

export function TranscriptEvidence({ evidence }: { evidence?: unknown[] }) {
  const [open, setOpen] = useState(false);
  const sources = (evidence ?? []).filter(e => e && typeof e === 'object' && typeof (e as Record<string, unknown>).quote === 'string') as Record<string, unknown>[];
  if (!sources.length) return null;
  return <span style={{ marginLeft: 6 }}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ border: 0, background: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 11 }}>Source</button>
    {open && <span role="note" style={{ display: 'block', maxHeight: 240, overflow: 'auto', padding: '6px 9px', borderLeft: '2px solid var(--line)', fontSize: 12, fontStyle: 'normal' }}>{sources.map((s, i) => <span key={i} style={{ display: 'block' }}>{typeof s.speaker_name === 'string' ? s.speaker_name : 'Speaker'}: “{s.quote as string}”</span>)}</span>}
  </span>;
}

export interface EngineActions {
  research?(entity: { id?: string; name: string; kind: string }): void;
  openEntityDoc?(entity: { id?: string; name: string; kind: string; docPath?: string }): void;
  onSignal?(signal: EngineSignal): void;
}

// Entity hues come from the ONE client-wide map (ui-kit/docLinks ENTITY_CHIP) so inline
// transcript highlights match [[wikilink]] chips exactly. Signals use semantic tokens.
const SIGNAL_HUE: Record<string, string> = { decision: "var(--violet)", "action-item": "var(--green)", action: "var(--green)", question: "var(--blue)", claim: "var(--warn)" };

function hueFor(kind: string): string {
  return entityColor(kind) ?? "var(--t2)";
}

/** An inline entity mention: colored, keyboard-focusable, opens a small action menu on click/Enter. */
function EntityMention({ entity, actions }: { entity: SpanEntity; actions?: EngineActions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const hue = hueFor(entity.kind);
  const arg = { id: entity.id, name: entity.label, kind: entity.kind, docPath: entity.docPath };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };  // consume: close-topmost beats nav.back
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const run = (fn?: (a: typeof arg) => void) => () => { setOpen(false); fn?.(arg); };

  return (
    <span ref={ref} style={{ position: "relative", display: "inline" }}>
      <span
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${entity.kind}: ${entity.label}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
        style={{
          color: hue, cursor: "pointer", borderBottom: `1px dotted ${hue}`,
          background: open ? "color-mix(in srgb, currentColor 12%, transparent)" : "transparent",
          borderRadius: 3, padding: "0 1px", outlineColor: hue,
        }}
      >
        {entity.label}
      </span>
      {open && (
        <span
          role="menu"
          style={{
            position: "absolute", top: "100%", left: 0, zIndex: 20, marginTop: 4, minWidth: 150,
            display: "flex", flexDirection: "column", background: "var(--bg)", border: "1px solid var(--line2)",
            borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.18)", padding: 4, fontSize: 12, fontWeight: 500,
          }}
        >
          <button type="button" role="menuitem" onClick={run(actions?.research)} style={menuItemStyle}>Research</button>
          <button type="button" role="menuitem" onClick={run(actions?.openEntityDoc)} style={menuItemStyle}>Open entity doc</button>
        </span>
      )}
    </span>
  );
}

const menuItemStyle: React.CSSProperties = {
  textAlign: "left", background: "transparent", border: "none", color: "var(--t1)",
  cursor: "pointer", padding: "5px 8px", borderRadius: 5, fontSize: 12, lineHeight: 1.3,
};

function ContestedText({ text }: { text: string }): React.ReactElement | null {
  const pattern = /⟦([^⟧]+)⟧\{([^}]+)\}/g;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) != null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      <span
        key={`contest-${match.index}`}
        data-contested="true"
        aria-label="Unresolved live transcript"
        style={{
          display: "inline",
          color: "var(--t3)",
          fontStyle: "italic",
        }}
      >
        {match[1]}
      </span>,
    );
    cursor = pattern.lastIndex;
  }
  if (!parts.length) return null;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Render a block's text. With `entities` → inline highlights; without → plain text (raw mode). */
function BlockText({ text, entities, actions }: { text: string; entities?: EngineEntity[]; actions?: EngineActions }) {
  if (/⟦[^⟧]+⟧\{[^}]+\}/.test(text)) return <ContestedText text={text} />;
  if (!entities || !entities.length) return <>{text}</>;
  const spans = splitTextIntoSpans(text, entities);
  return (
    <>
      {spans.map((span, i) =>
        span.entity
          ? <EntityMention key={`e${i}`} entity={span.entity} actions={actions} />
          : <span key={`t${i}`}>{span.text}</span>,
      )}
    </>
  );
}

export function LiveTranscriptEngine({
  segments,
  emptyLabel = "Waiting for transcript…",
  entities,
  signals,
  actions,
  onSegmentClick,
  playableSegmentIds,
  activeSegmentId,
  language = "vi",
  translationPaused = false,
}: {
  segments: EngineSegment[];
  emptyLabel?: string;
  entities?: EngineEntity[];
  signals?: EngineSignal[];
  actions?: EngineActions;
  onSegmentClick?: (segmentId: string) => void;
  playableSegmentIds?: ReadonlySet<string>;
  activeSegmentId?: string | null;
  language?: TranscriptLanguage;
  translationPaused?: boolean;
}) {
  const renderedAt = performance.now();
  useLayoutEffect(() => {
    if (!segments.length || document.hidden || !document.hasFocus()) return;
    const frame = requestAnimationFrame(() => {
      if (!document.hidden && document.hasFocus()) recordAsrTiming({ source: "meeting-view", at_ms: Date.now(),
        frame_ms: performance.now() - renderedAt });
    });
    return () => cancelAnimationFrame(frame);
    // Only transcript changes create render samples.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);
  // Confirmed (completed !== false) = stable. Merge consecutive same-speaker confirmed segments into
  // flowing blocks; every speaker's pending segment remains visible as a separate live tail.
  const displaySegments=useMemo(()=>segments.map(s=>({...s,display:formatTranscript(s.text,s.completed!==false,s.translation?.sourceParts)})),[segments]);
  const blocks: { speakerId?: string; speakerKey?: string; speaker?: string; tsMs?: number; text: string; key: string; segmentIds: string[]; tags: EngineTag[]; stale: boolean; evidence: unknown[] }[] = [];
  const identity = (value: Pick<EngineSegment, "speakerId" | "speakerKey" | "speaker">) =>
    value.speakerId ? `id:${value.speakerId}` : value.speaker?.trim() ? `name:${value.speaker}` : value.speakerKey ? `key:${value.speakerKey}` : undefined;
  for (const s of displaySegments) {
    if (s.completed === false) continue;
    const last = blocks[blocks.length - 1];
    const currentIdentity = identity(s);
    if (last && currentIdentity && identity(last) === currentIdentity && last.stale === !!s.stale) { last.text += " " + s.display.text; if (s.id) last.segmentIds.push(s.id); if (s.tags) last.tags.push(...s.tags); last.evidence.push(...(s.evidence ?? [])); }
    else blocks.push({ speakerId: s.speakerId, speakerKey: s.speakerKey, speaker: s.speaker, tsMs: s.tsMs, text: s.display.text, key: s.id ?? `b${blocks.length}`, segmentIds: s.id ? [s.id] : [], tags: [...(s.tags ?? [])], stale: !!s.stale, evidence: [...(s.evidence ?? [])] });
  }
  const pending = segments.filter((s) => s.completed === false && s.text.trim());

  if (!blocks.length && !pending.length) {
    return <div style={{ color: "var(--t3)", fontSize: 13, padding: "8px 2px" }}>{emptyLabel}</div>;
  }

  const head = (speaker?: string, tsMs?: number) =>
    speaker ? (
      <div className={styles.speaker}>
        {speaker}
        {typeof tsMs === "number" && (
          <time>{new Date(tsMs).toLocaleTimeString()}</time>
        )}
      </div>
    ) : null;

  if (language !== "vi") {
    return <div className={styles.flow}>
      {displaySegments.map((segment, index) => {
        const translated = segment.translation?.text;
        const draft = segment.completed === false;
        const originalVisible = language === "bilingual" || !translated;
        let pendingTranslation = draft ? "Chờ đoạn nói hoàn tất…" : translationPaused ? "Chưa dịch được · bản gốc vẫn được giữ" : segment.translation?.ready ? "Đang dịch…" : "Đang gom câu…";
        if (!draft && segment.translation?.status === "failed") pendingTranslation = "Chưa dịch được đoạn này · bấm Thử lại";
        if (!draft && segment.translation?.status === "retrying") pendingTranslation = "Đoạn này đang chờ thử lại…";
        const playable = !!segment.id && playableSegmentIds?.has(segment.id) && !!onSegmentClick;
        return <article data-segment-ids={segment.id || undefined} data-transcript-segments={JSON.stringify(segment.id ? [segment.id] : [])} tabIndex={-1} className={styles.turn} data-active={!!segment.id && segment.id === activeSegmentId} key={segment.translation?.groupId ?? segment.id ?? index}>
          {head(segment.speaker, segment.tsMs)}
          {originalVisible && <div className={styles.original} data-draft={draft}>
            {playable ? <button type="button" onClick={() => onSegmentClick?.(segment.id!)} aria-label="Play transcript segment"
              className={styles.play} aria-current={segment.id === activeSegmentId ? "true" : undefined}>{segment.display.text}</button> : segment.display.text}
          </div>}
          <div lang="en" className={styles.english} data-ready={String(!!translated)}>
            <span className={styles.languageLabel} aria-hidden="true">EN</span>
            <span className={styles.englishText}>{translated || pendingTranslation}</span>
          </div>
        </article>;
      })}
    </div>;
  }
  const pendingLine = (segment: EngineSegment, index: number) => (
    <div data-segment-ids={segment.id || undefined} key={segment.id ?? `pending-${index}`}>
      {head(segment.speaker, segment.tsMs)}
      <div style={{ fontSize: 13.5, color: "var(--t3)", lineHeight: 1.6, fontStyle: "italic" }}>
        <BlockText text={segment.text.trim()} entities={entities} actions={actions} /> …
      </div>
    </div>
  );

  // When a saved recording is available, keep the original ASR turns separate so each click maps to
  // that exact audio timestamp. The regular live transcript still merges same-speaker fragments.
  if (onSegmentClick && playableSegmentIds?.size) {
    const turns = displaySegments.filter((segment) => segment.completed !== false);
    let previousIdentity: string | undefined;
    return (
      <div className={styles.flow} style={{ gap: 5 }}>
        {turns.map((segment, index) => {
          const speakerIdentity = segment.speakerId ? `id:${segment.speakerId}`
            : segment.speaker?.trim() ? `name:${segment.speaker}`
              : segment.speakerKey ? `key:${segment.speakerKey}` : `segment:${segment.id ?? index}`;
          const showSpeaker = index === 0 || speakerIdentity !== previousIdentity;
          previousIdentity = speakerIdentity;
          const id = segment.id;
          const playable = !!id && playableSegmentIds.has(id);
          const active = !!id && id === activeSegmentId;
          const timestamp = typeof segment.tsMs === "number" && Number.isFinite(segment.tsMs)
            ? new Date(segment.tsMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
            : "";
          return (
            <div data-segment-ids={id || undefined} data-transcript-segments={JSON.stringify(id ? [id] : [])} tabIndex={-1} key={id ?? `playback-turn-${index}`}>
              {showSpeaker && head(segment.speaker)}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                {timestamp && <time style={{ flex: "none", paddingTop: 5, color: "var(--t3)", font: "11px var(--mono)", fontVariantNumeric: "tabular-nums" }}>{timestamp}</time>}
                {playable && id ? (
                  <button type="button" aria-label={`Play transcript from ${timestamp || "this segment"}`} aria-current={active ? "true" : undefined}
                    title="Play audio from this transcript segment" onClick={() => onSegmentClick(id)}
                    style={{ flex: 1, minWidth: 0, padding: "4px 7px", margin: "0 0 1px -7px", border: 0, borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent", borderRadius: 4, background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent", color: "var(--t1)", font: "inherit", fontSize: 14, lineHeight: 1.65, textAlign: "left", cursor: "pointer" }}>
                    <BlockText text={segment.display.text} entities={entities} actions={actions} />
                  </button>
                ) : (
                  <div style={{ flex: 1, minWidth: 0, padding: "4px 0", color: "var(--t1)", fontSize: 14, lineHeight: 1.65 }}>
                    <BlockText text={segment.display.text} entities={entities} actions={actions} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {pending.map(pendingLine)}
      </div>
    );
  }

  // dedupe tags by lowercased label (a keyword mentioned twice in a block shows once)
  const chips = (tags: EngineTag[]) => {
    const seen = new Set<string>();
    const uniq = tags.filter((t) => t.label && !seen.has(t.label.toLowerCase()) && seen.add(t.label.toLowerCase()));
    if (!uniq.length) return null;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {uniq.map((t, i) => {
          const hue = hueFor(t.kind);
          return (
            <span key={`${t.label}-${i}`} title={`research ${t.label}`}
              style={{ fontSize: 11, color: hue, border: `1px solid ${hue}`, background: "transparent", borderRadius: 999, padding: "1px 8px", lineHeight: 1.5, opacity: 0.9 }}>
              {t.label}
            </span>
          );
        })}
      </div>
    );
  };

  // Signal badges attach to the LAST confirmed block (the running edge of the conversation). Only in
  // processed mode (signals supplied). Clickable → onSignal (create task / fact-check via useActions).
  const signalBadges = (forLastBlock: boolean) => {
    if (!forLastBlock || !signals || !signals.length) return null;
    return (
      <div role="group" aria-label="signals" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {signals.map((sig) => {
          const hue = SIGNAL_HUE[sig.kind] ?? "var(--t2)";
          return (
            <button key={sig.id} type="button" title={`${sig.kind}: ${sig.label}`}
              onClick={() => actions?.onSignal?.(sig)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11,
                color: hue, border: `1px solid ${hue}`, background: "transparent", borderRadius: 6,
                padding: "1px 7px", lineHeight: 1.5, fontWeight: 600,
              }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: hue, flex: "none" }} />
              {sig.kind}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className={styles.flow}>
      {blocks.map((b, idx) => {
        const isLast = idx === blocks.length - 1;
        return (
          <div data-segment-ids={b.segmentIds.join(' ') || undefined} data-transcript-segments={JSON.stringify(b.segmentIds)} tabIndex={-1} key={b.key}>
            {head(b.speaker, b.tsMs)}
            {b.stale && <span role="status" style={{ color: 'var(--t3)', fontSize: 11 }}>Out of date</span>}
            <div style={{ fontSize: 14, color: "var(--t1)", lineHeight: 1.65 }}>
              <BlockText text={b.text} entities={entities} actions={actions} />
              <TranscriptEvidence evidence={b.evidence} />
            </div>
            {chips(b.tags)}
            {signalBadges(isLast && pending.length === 0)}
          </div>
        );
      })}
      {pending.map(pendingLine)}
      {pending.length > 0 && signalBadges(true)}
    </div>
  );
}
