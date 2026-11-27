// Lucian UX/UI Prompt #401 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#401
// Lucian UX/UI Prompt #109 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#109
"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { startGoogleCalendarLink } from "../lib/googleCalendarClient";
import styles from "./calendarWelcome.module.css";

const CALENDAR_SETTINGS = "/?nav=settings&settingsWorkspace=personal&settingsSection=calendar";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
const HOURS = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];
// Each slot is 30 minutes, starting at 09:00.
const SAMPLE_MEETINGS = [
  { day: "Mon", slot: 2, time: "09:30", title: "Team planning", featured: false },
  { day: "Wed", slot: 11, time: "14:00", title: "Project review", featured: true },
  { day: "Fri", slot: 3, time: "10:00", title: "Weekly wrap-up", featured: false },
] as const;

export function CalendarWelcome({
  googleIcon,
  initialError,
  onSkip,
}: {
  googleIcon: ReactNode;
  initialError: boolean;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ? "Google Calendar wasn’t connected. Try again or skip for now." : "");

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await startGoogleCalendarLink(new URL(CALENDAR_SETTINGS, window.location.origin).href);
    } catch {
      setError("Couldn’t open Google Calendar. Try again or skip for now.");
      setBusy(false);
    }
  };

  return (
    <main className={styles.screen}>
      <div className={styles.layout}>
        <section className={styles.intro} aria-labelledby="calendar-welcome-title">
          <div className={styles.brand}>
            <img src="/tina-logo.svg" width={28} height={28} alt="" />
            <span>TINA</span>
          </div>
          <h1 id="calendar-welcome-title">Connect your work calendar</h1>
          <p className={styles.summary}>See your upcoming meetings in TINA.</p>

          <ul className={styles.permissions}>
            <li>Calendar access is read-only.</li>
            <li>You choose which calendars to sync.</li>
          </ul>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.googleButton}
              disabled={busy}
              aria-busy={busy}
              onClick={connect}
            >
              <span className={styles.googleIcon} aria-hidden="true">
                <span className={styles.googleMark}>{googleIcon}</span>
                {busy && (
                  <svg className={styles.spinner} viewBox="0 0 20 20">
                    <circle cx="10" cy="10" r="8" stroke="var(--google-red)" />
                    <circle cx="10" cy="10" r="8" stroke="var(--google-blue)" strokeDashoffset="-12.57" />
                    <circle cx="10" cy="10" r="8" stroke="var(--google-yellow)" strokeDashoffset="-25.13" />
                    <circle cx="10" cy="10" r="8" stroke="var(--google-green)" strokeDashoffset="-37.7" />
                  </svg>
                )}
              </span>
              {busy ? "Opening Google…" : "Connect Google Calendar"}
            </button>
            <button type="button" className={styles.skip} onClick={onSkip} disabled={busy}>
              Skip for now
            </button>
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
        </section>

        <figure className={styles.preview}>
          <figcaption>Sample week</figcaption>
          <div className={styles.week}>
            <div className={styles.weekdays} aria-hidden="true">
              {WEEKDAYS.map(day => <span key={day}>{day}</span>)}
            </div>
            <div className={styles.hours} aria-hidden="true">
              {HOURS.map(hour => <span key={hour}>{hour}</span>)}
            </div>
            <ol className={styles.events} role="list">
              {SAMPLE_MEETINGS.map(({ day, slot, time, title, featured }) => (
                <li
                  key={day}
                  className={featured ? styles.featuredEvent : undefined}
                  style={{ "--event-day": WEEKDAYS.indexOf(day) + 1, "--event-slot": slot } as CSSProperties}
                >
                  <span className={styles.day}>{day}</span>
                  <time dateTime={time}>{time}</time>
                  <strong>{title}</strong>
                </li>
              ))}
            </ol>
          </div>
        </figure>
      </div>
    </main>
  );
}
