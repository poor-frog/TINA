"use client";
/** Shared `@` mention & `/` slash command controller hook for AskTinaView,
 *  KnowledgeCopilotDrawer, and MeetingSidePanel. Centralizes keyboard navigation,
 *  Vietnamese IME composition guards, blur dismissal, atomic Backspace, non-destructive
 *  `/` template insertion, and `@` chip ↔ textarea synchronization. */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  detectMentionAtCursor,
  filterMentionTargets,
  findMentionBeforeCursor,
  type MentionMatch,
  type MentionTarget,
} from "./LucianMentionPicker";
import {
  detectSlashAtStart,
  filterSlashCommands,
  type SlashCommandDef,
  type SlashCommandId,
  type SlashMatch,
} from "./LucianSlashPicker";

export interface UseChatComposerPickersOptions {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  mentionCatalog: MentionTarget[];
  mentionLimit?: number;
  allowedSlashIds?: readonly SlashCommandId[];
  mentionedTargets: MentionTarget[];
  setMentionedTargets: Dispatch<SetStateAction<MentionTarget[]>>;
  onPickMentionExtra?: (target: MentionTarget) => void;
  onRemoveMentionExtra?: (target: MentionTarget) => void;
  onInstantSlash: (command: SlashCommandDef) => void;
  onSubmit: () => void;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function useChatComposerPickers({
  value,
  setValue,
  textareaRef,
  mentionCatalog,
  mentionLimit = 10,
  allowedSlashIds,
  mentionedTargets,
  setMentionedTargets,
  onPickMentionExtra,
  onRemoveMentionExtra,
  onInstantSlash,
  onSubmit,
}: UseChatComposerPickersOptions) {
  const mentionListboxId = useId();
  const slashListboxId = useId();

  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0);
  const [mentionDismissedAnchor, setMentionDismissedAnchor] = useState(-1);

  const [slashMatch, setSlashMatch] = useState<SlashMatch | null>(null);
  const [slashActiveIdx, setSlashActiveIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const filteredMentions = useMemo(() => {
    if (!mentionMatch) return [];
    return filterMentionTargets(mentionCatalog, mentionMatch.query, mentionLimit);
  }, [mentionCatalog, mentionLimit, mentionMatch]);

  const filteredSlashCommands = useMemo(() => {
    if (!slashMatch) return [];
    return filterSlashCommands(slashMatch.query, allowedSlashIds);
  }, [allowedSlashIds, slashMatch]);

  const mentionOpen = Boolean(mentionMatch && filteredMentions.length > 0);
  const slashOpen = Boolean(!mentionOpen && slashMatch && filteredSlashCommands.length > 0);

  const caretRafRef = useRef<number | null>(null);
  const cancelPendingCaret = useCallback(() => {
    if (caretRafRef.current !== null) {
      window.cancelAnimationFrame(caretRafRef.current);
      caretRafRef.current = null;
    }
  }, []);

  const scheduleCaret = useCallback(
    (expectedValue: string, pos: number, focus = false, preventScroll = false) => {
      cancelPendingCaret();
      caretRafRef.current = window.requestAnimationFrame(() => {
        caretRafRef.current = null;
        const node = textareaRef.current;
        if (!node || node.value !== expectedValue) return;
        if (focus) node.focus(preventScroll ? { preventScroll: true } : undefined);
        node.setSelectionRange(pos, pos);
      });
    },
    [cancelPendingCaret, textareaRef],
  );

  useEffect(() => cancelPendingCaret, [cancelPendingCaret]);

  const closePickers = useCallback(() => {
    cancelPendingCaret();
    setMentionMatch(null);
    setSlashMatch(null);
    setSlashDismissed(false);
    setMentionDismissedAnchor(-1);
  }, [cancelPendingCaret]);

  const syncPickers = useCallback(
    (nextValue: string, cursorPos: number) => {
      cancelPendingCaret();
      const mMatch = detectMentionAtCursor(nextValue, cursorPos);
      if (mMatch) {
        setSlashMatch(null);
        if (mMatch.anchor !== mentionDismissedAnchor) {
          setMentionMatch((prev) => {
            if (!prev || prev.anchor !== mMatch.anchor || prev.query !== mMatch.query) {
              setMentionActiveIdx(0);
            }
            return mMatch;
          });
        }
        return;
      }
      setMentionDismissedAnchor(-1);
      setMentionMatch(null);

      const sMatch = detectSlashAtStart(nextValue, cursorPos);
      if (!sMatch) {
        setSlashDismissed(false);
        setSlashMatch(null);
        return;
      }
      if (!slashDismissed) {
        setSlashMatch((prev) => {
          if (!prev || prev.query !== sMatch.query) setSlashActiveIdx(0);
          return sMatch;
        });
      }
    },
    [cancelPendingCaret, mentionDismissedAnchor, slashDismissed],
  );

  const pickMention = useCallback(
    (target: MentionTarget) => {
      const el = textareaRef.current;
      const cursor = el?.selectionStart ?? value.length;
      const anchor = mentionMatch?.anchor ?? cursor;
      const insertion = `@${target.label} `;
      const nextValue = value.slice(0, anchor) + insertion + value.slice(cursor);
      const nextPos = anchor + insertion.length;

      setValue(nextValue);
      setMentionMatch(null);
      setMentionDismissedAnchor(-1);
      setMentionActiveIdx(0);
      setMentionedTargets((prev) => (prev.some((x) => x.id === target.id) ? prev : [...prev, target]));
      onPickMentionExtra?.(target);

      scheduleCaret(nextValue, nextPos, true);
    },
    [mentionMatch, onPickMentionExtra, scheduleCaret, setMentionedTargets, setValue, textareaRef, value],
  );

  const pickSlashCommand = useCallback(
    (cmd: SlashCommandDef) => {
      const tokenEnd = slashMatch ? slashMatch.anchor + 1 + slashMatch.query.length : 0;
      const afterToken = slashMatch ? value.slice(tokenEnd).trimStart() : value.trimStart();

      setSlashMatch(null);
      setSlashDismissed(false);
      setSlashActiveIdx(0);

      if (cmd.instant) {
        if (cmd.id === "new") {
          setValue("");
        } else {
          // Preserve any draft text the user had after `/schedule` or `/save`
          setValue(afterToken);
        }
        onInstantSlash(cmd);
        return;
      }

      // Preserve any existing text after the leading `/query` token so choosing a command never wipes text.
      const nextValue = afterToken ? `${cmd.command} ${afterToken}` : cmd.insertTemplate;
      const caretPos = afterToken ? cmd.command.length + 1 : nextValue.length;
      setValue(nextValue);

      scheduleCaret(nextValue, caretPos, true);
    },
    [onInstantSlash, scheduleCaret, setValue, slashMatch, value],
  );

  const triggerMention = useCallback(() => {
    const el = textareaRef.current;
    setSlashMatch(null);
    if (mentionOpen && mentionMatch && mentionMatch.query === "") {
      setMentionDismissedAnchor(mentionMatch.anchor);
      setMentionMatch(null);
      el?.focus({ preventScroll: true });
      return;
    }
    const focused = el && document.activeElement === el;
    const start = focused ? (el.selectionStart ?? value.length) : value.length;
    const end = focused ? (el.selectionEnd ?? value.length) : value.length;
    const existing = start === end ? detectMentionAtCursor(value, start) : null;
    if (existing && existing.query === "") {
      setMentionDismissedAnchor(-1);
      setMentionActiveIdx(0);
      setMentionMatch(existing);
      el?.focus({ preventScroll: true });
      return;
    }
    const before = value.slice(0, start);
    const ins = (before && !/\s$/.test(before) ? " " : "") + "@";
    const nextValue = before + ins + value.slice(end);
    const nextPos = start + ins.length;
    setValue(nextValue);
    setMentionDismissedAnchor(-1);
    setMentionActiveIdx(0);
    setMentionMatch({ anchor: nextPos - 1, query: "" });
    el?.focus({ preventScroll: true });
    scheduleCaret(nextValue, nextPos, true, true);
  }, [mentionMatch, mentionOpen, scheduleCaret, setValue, textareaRef, value]);

  const triggerSlash = useCallback(() => {
    const el = textareaRef.current;
    setMentionMatch(null);
    if (slashOpen) {
      setSlashDismissed(true);
      setSlashMatch(null);
      el?.focus({ preventScroll: true });
      return;
    }
    const trimmedStart = value.trimStart();
    if (trimmedStart.startsWith("/")) {
      const leadingSpaces = value.length - trimmedStart.length;
      const token = trimmedStart.split(/\s/)[0] ?? "/";
      const query = token.slice(1);
      const caretPos = leadingSpaces + token.length;
      setSlashDismissed(false);
      setSlashActiveIdx(0);
      setSlashMatch({ anchor: leadingSpaces, query });
      el?.focus({ preventScroll: true });
      scheduleCaret(value, caretPos, true, true);
      return;
    }
    const nextValue = trimmedStart ? `/ ${trimmedStart}` : "/";
    setValue(nextValue);
    setSlashDismissed(false);
    setSlashActiveIdx(0);
    setSlashMatch({ anchor: 0, query: "" });
    el?.focus({ preventScroll: true });
    scheduleCaret(nextValue, 1, true, true);
  }, [scheduleCaret, setValue, slashOpen, textareaRef, value]);

  const removeMentionChip = useCallback(
    (id: string) => {
      const target = mentionedTargets.find((x) => x.id === id);
      if (!target) return;
      setMentionedTargets((prev) => prev.filter((x) => x.id !== id));
      onRemoveMentionExtra?.(target);
      setValue((cur) =>
        cur.replace(new RegExp(`@${escapeRegExp(target.label)}\\s?`, "g"), "").trimStart(),
      );
    },
    [mentionedTargets, onRemoveMentionExtra, setMentionedTargets, setValue],
  );

  const handleBlur = useCallback((e: FocusEvent<HTMLTextAreaElement>) => {
    const next = e.relatedTarget as HTMLElement | null;
    if (next?.closest?.(".u451-pop, .u451-at")) return;
    setMentionMatch(null);
    setSlashMatch(null);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Guard Vietnamese / CJK IME composition so pressing Enter to commit accents never submits or picks prematurely.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

      if (mentionOpen) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setMentionActiveIdx(
            (cur) => (cur + (e.key === "ArrowDown" ? 1 : -1) + filteredMentions.length) % filteredMentions.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const chosen = filteredMentions[Math.min(mentionActiveIdx, filteredMentions.length - 1)];
          if (chosen) pickMention(chosen);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (mentionMatch) setMentionDismissedAnchor(mentionMatch.anchor);
          setMentionMatch(null);
          return;
        }
      }

      if (slashOpen) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIdx(
            (cur) =>
              (cur + (e.key === "ArrowDown" ? 1 : -1) + filteredSlashCommands.length) %
              filteredSlashCommands.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const chosen = filteredSlashCommands[Math.min(slashActiveIdx, filteredSlashCommands.length - 1)];
          if (chosen) pickSlashCommand(chosen);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setSlashDismissed(true);
          setSlashMatch(null);
          return;
        }
      }

      if (e.key === "Backspace") {
        const el = e.currentTarget;
        const selStart = el.selectionStart ?? 0;
        const selEnd = el.selectionEnd ?? 0;
        if (selStart === selEnd && selStart > 0) {
          const labels = Array.from(
            new Set([
              ...mentionedTargets.map((t) => t.label),
              ...mentionCatalog.map((t) => t.label),
            ]),
          );
          const token = findMentionBeforeCursor(value, selStart, labels);
          if (token) {
            e.preventDefault();
            const nextValue = value.slice(0, selStart - token.length) + value.slice(selStart);
            const nextPos = selStart - token.length;
            setValue(nextValue);
            const strippedLabel = token.slice(1);
            const removed = mentionedTargets.filter((t) => t.label === strippedLabel);
            if (removed.length > 0) {
              setMentionedTargets((prev) => prev.filter((t) => t.label !== strippedLabel));
              for (const item of removed) onRemoveMentionExtra?.(item);
            }
            syncPickers(nextValue, nextPos);
            scheduleCaret(nextValue, nextPos);
            return;
          }
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [
      filteredMentions,
      filteredSlashCommands,
      mentionActiveIdx,
      mentionCatalog,
      mentionMatch,
      mentionOpen,
      mentionedTargets,
      onRemoveMentionExtra,
      onSubmit,
      pickMention,
      pickSlashCommand,
      scheduleCaret,
      setMentionedTargets,
      setValue,
      slashActiveIdx,
      slashOpen,
      syncPickers,
      value,
    ],
  );

  const activeDescendantId = mentionOpen
    ? `${mentionListboxId}-opt-${Math.min(mentionActiveIdx, Math.max(0, filteredMentions.length - 1))}`
    : slashOpen
      ? `${slashListboxId}-opt-${Math.min(slashActiveIdx, Math.max(0, filteredSlashCommands.length - 1))}`
      : undefined;

  return {
    mentionListboxId,
    slashListboxId,
    mentionMatch,
    mentionActiveIdx,
    setMentionActiveIdx,
    filteredMentions,
    mentionOpen,
    slashMatch,
    slashActiveIdx,
    setSlashActiveIdx,
    filteredSlashCommands,
    slashOpen,
    activeDescendantId,
    syncPickers,
    pickMention,
    pickSlashCommand,
    triggerMention,
    triggerSlash,
    removeMentionChip,
    closePickers,
    handleBlur,
    handleKeyDown,
  };
}
