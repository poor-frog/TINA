// Lucian UX/UI Prompt #431 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#431
"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import styles from "./dateTimePicker.module.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DATE_FORMAT = { weekday: "short", month: "short", day: "numeric", year: "numeric" } as const;

function dayAt(date: Date, offset = 0): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 12);
}

function sameDay(a: Date, b: Date): boolean {
  return dayAt(a).getTime() === dayAt(b).getTime();
}

function timeText(date: Date): string {
  return [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":");
}

function shiftMonth(date: Date, amount: number): Date {
  const end = new Date(date.getFullYear(), date.getMonth() + amount + 1, 0).getDate();
  return new Date(date.getFullYear(), date.getMonth() + amount, Math.min(date.getDate(), end), 12);
}

function timeZoneText(date: Date): string {
  const browserZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = browserZone === "Asia/Saigon" ? "Asia/Ho_Chi_Minh" : browserZone;
  const offset = new Intl.DateTimeFormat(undefined, { timeZoneName: "shortOffset" })
    .formatToParts(date).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "UTC");
  return offset && zone !== offset ? zone + " (" + offset + ")" : zone;
}

export function DateTimePicker({
  value,
  onChange,
  onClear,
  onOpenChange,
  disabled,
  id,
  placeholder = "Pick a time",
}: {
  value?: string | null;
  onChange: (iso: string) => void;
  onClear?: () => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}) {
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dayButton = useRef<HTMLButtonElement>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  const focusDayOnRender = useRef(false);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => dayAt(new Date()));
  const [focusDate, setFocusDate] = useState(date);
  const [time, setTime] = useState("");
  const [error, setError] = useState("");
  const parsed = value ? new Date(value) : null;
  const selected = parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
  const now = new Date();
  const today = dayAt(now);
  const first = new Date(focusDate.getFullYear(), focusDate.getMonth(), 1, 12);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const prevMonth = new Date(first.getFullYear(), first.getMonth(), 0, 12);
  const match = /^([01]\d|2[0-3]):?([0-5]\d)$/.exec(time);
  const candidate = match
    ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), Number(match[1]), Number(match[2]))
    : null;

  useEffect(() => {
    if (open && focusDayOnRender.current) {
      focusDayOnRender.current = false;
      dayButton.current?.focus({ preventScroll: true });
    }
  }, [focusDate, open]);

  const close = () => {
    setOpen(false);
    onOpenChange?.(false);
    trigger.current?.focus();
  };

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const base = selected && selected >= now ? selected : new Date(now.getTime() + 60 * 60 * 1000);
    const day = dayAt(base);
    setDate(day);
    setFocusDate(day);
    setTime(timeText(base));
    setError("");
    focusDayOnRender.current = true;
    setOpen(true);
    onOpenChange?.(true);
  };

  const apply = () => {
    if (!match || !candidate) {
      setError("Enter a time from 00:00 to 23:59.");
    } else if (timeText(candidate) !== match[1] + ":" + match[2]) {
      setError("This local time does not exist. Choose a different time.");
    } else if (candidate <= new Date()) {
      setError("Choose a time in the future.");
    } else {
      onChange(candidate.toISOString());
      close();
      return;
    }
    timeInput.current?.focus();
  };

  const moveDayFocus = (event: KeyboardEvent<HTMLButtonElement>, day: Date) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as const;
    const step = steps[event.key as keyof typeof steps];
    const next = step
      ? dayAt(day, step)
      : event.key === "PageUp" || event.key === "PageDown"
        ? shiftMonth(day, event.key === "PageUp" ? -1 : 1)
        : null;
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    const target = next < today ? today : next;
    if (sameDay(target, focusDate)) return;
    focusDayOnRender.current = true;
    setFocusDate(target);
  };

  return (
    <div className={styles.root} onKeyDown={(event) => {
      if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={panelId + "-zone"}
        onClick={toggle}
      >
        <span>{selected ? selected.toLocaleDateString(undefined, DATE_FORMAT) + ", " + timeText(selected) : placeholder}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4m8-4v4" />
        </svg>
      </button>
      <p id={panelId + "-zone"} className={styles.zone}>{timeZoneText(selected ?? now)}</p>

      {open && (
        <div id={panelId} className={styles.panel} role="group" aria-label="Pick date and time">
          <div className={styles.layout}>
            <div className={styles.calendar}>
              <div className={styles.month}>
                <strong aria-live="polite">{first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
                <button type="button" aria-label="Previous month" disabled={prevMonth < today} onClick={() => {
                  const previous = shiftMonth(focusDate, -1);
                  setFocusDate(previous < today ? today : previous);
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
                </button>
                <button type="button" aria-label="Next month" onClick={() => setFocusDate(shiftMonth(focusDate, 1))}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
                </button>
              </div>
              <div className={styles.days} aria-hidden="true">
                {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
              </div>
              <div className={styles.days} role="group" aria-label="Dates">
                {Array.from({ length: lead }, (_, i) => <span key={"blank-" + i} aria-hidden="true" />)}
                {Array.from({ length: days }, (_, i) => {
                  const day = dayAt(first, i);
                  const focused = sameDay(day, focusDate);
                  return (
                    <button
                      key={i}
                      ref={focused ? dayButton : undefined}
                      type="button"
                      disabled={day < today}
                      tabIndex={focused ? 0 : -1}
                      aria-label={day.toLocaleDateString(undefined, DATE_FORMAT)}
                      aria-current={sameDay(day, today) ? "date" : undefined}
                      aria-pressed={sameDay(day, date)}
                      onKeyDown={(event) => moveDayFocus(event, day)}
                      onClick={() => {
                        setDate(day);
                        setFocusDate(day);
                        setError("");
                      }}
                    >
                      {day.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className={styles.time}>
              <label htmlFor={panelId + "-time"}>Time</label>
              <input
                ref={timeInput}
                id={panelId + "-time"}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="HH:mm"
                maxLength={5}
                value={time}
                aria-invalid={Boolean(error)}
                aria-describedby={panelId + "-hint" + (error ? " " + panelId + "-error" : "")}
                onChange={(event) => {
                  setTime(event.currentTarget.value);
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    apply();
                  }
                }}
              />
              <p id={panelId + "-hint"} className={styles.zone}>24-hour time, for example 09:07.</p>
              {candidate && timeZoneText(candidate) !== timeZoneText(selected ?? now) && (
                <p className={styles.zone}>{timeZoneText(candidate)}</p>
              )}
              {error && <p id={panelId + "-error"} role="alert" className={styles.error}>{error}</p>}
            </div>
          </div>
          <div className={styles.actions}>
            {onClear && selected && (
              <button type="button" className={styles.clear} onClick={() => {
                onClear();
                close();
              }}>Clear time</button>
            )}
            <button type="button" onClick={close}>Cancel time selection</button>
            <button type="button" className={styles.apply} onClick={apply}>Use date and time</button>
          </div>
        </div>
      )}
    </div>
  );
}
