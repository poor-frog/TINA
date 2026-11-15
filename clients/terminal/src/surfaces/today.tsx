"use client";
/** Today — the Meetings surface's CENTER tab, v5 AGENDA TIMELINE (design-spec
 *  today-v5-agenda-timeline, owner-approved mockup). ONE time axis:
 *
 *    "Coming up"  — a day-grouped agenda card for the visible week (‹ › pages weeks). A live
 *                   meeting shows IN PLACE on its day row (green bar) — no separate NOW zone.
 *    past feed    — reverse-chron day-grouped rows below: faces · title · one state phrase.
 *
 *  RENDERING LAW (binding): a meeting row is ONE line — title + time (+ faces on past rows).
 *  The ONLY extra ink is ONE inline deviation phrase (`in meeting →` · `couldn't import` ·
 *  `no brief yet` · `recap ready`), each deep-linking to the right page. A prepared meeting is
 *  the quiet default and carries NO phrase. Depth lives on the per-state pages, not here.
 *  Supersedes the v4 zones (NOW/NEXT/THIS WEEK/LATER/TO REVIEW) — same intent, less vocabulary. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { registerTab } from "../contributions";
import { Icon } from "../ui-kit";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { usePreviewPinTab } from "./previewPinTab";
import type { MeetingMock } from "./meetingModel";
import { useLiveMeetings, fetchDurableTranscript } from "./liveMeetings";
import { groupMeetings, type MeetingGroup } from "./meetingGroups";
import { meetingTab } from "./meeting";
import { MeetingsOnboarding } from "./meetingsOnboarding";
import { findBriefNote } from "./briefNote";
import { listWorkspaceTree, readActiveSet } from "./workspaceApi";
import { meetingFocusFor } from "./chatContext";
import { ASK_CHAT_EVENT } from "../canvas/actions";
import styles from "./today.module.css";

// ── reviewed-recaps store (localStorage) — opening a recap retires its phrase ──────────────────
const REVIEWED_KEY = "tina.reviewedMeetings";
let reviewed: Set<string> = new Set();
try { reviewed = new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "[]") as string[]); } catch { /* fresh */ }
const reviewedSubs = new Set<() => void>();
let reviewedSnapshot: string[] = [...reviewed];
export function markReviewed(runId: string): void {
  if (reviewed.has(runId)) return;
  reviewed.add(runId);
  reviewedSnapshot = [...reviewed];
  try { localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewedSnapshot.slice(-500))); } catch { /* quota */ }
  reviewedSubs.forEach((f) => f());
}
function useReviewed(): Set<string> {
  useSyncExternalStore(
    (cb) => { reviewedSubs.add(cb); return () => reviewedSubs.delete(cb); },
    () => reviewedSnapshot,
    () => reviewedSnapshot,
  );
  return reviewed;
}

// ── pure timeline splitters (unit-tested offline) ─────────────────────────────────────────────
export interface AgendaDay { key: string; date: Date; groups: MeetingGroup[] }

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** The agenda window: day-grouped upcoming (+live) meetings for the week starting at
 *  today + 7·weekOffset days. Unscheduled plans attach to TODAY (offset 0 only) — they need
 *  attention but have no place on a time axis. Days without events are omitted, except today. */
export function agendaWindow(groups: MeetingGroup[], now: Date = new Date(), weekOffset = 0): AgendaDay[] {
  const start = startOfDay(now);
  start.setDate(start.getDate() + weekOffset * 7);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const days = new Map<string, AgendaDay>();
  const put = (d: Date, g: MeetingGroup) => {
    const k = dayKey(d);
    let day = days.get(k);
    if (!day) { day = { key: k, date: startOfDay(d), groups: [] }; days.set(k, day); }
    day.groups.push(g);
  };
  for (const g of groups) {
    if (g.phase !== "prep" && g.phase !== "live") continue;
    const at = g.current.scheduled_at ? new Date(g.current.scheduled_at) : null;
    if (at && Number.isFinite(at.getTime())) {
      // a live meeting always shows — clamp a stale/past schedule onto today so it can't vanish
      const slot = g.phase === "live" && at < start ? new Date(now) : at;
      if (slot >= start && slot < end) put(slot, g);
    } else if (weekOffset === 0) {
      put(new Date(now), g);   // unscheduled (or undated live) → today's row, "no time set"
    }
  }
  // today's row always renders on the current week so "No events today" is stated honestly
  if (weekOffset === 0 && !days.has(dayKey(now))) days.set(dayKey(now), { key: dayKey(now), date: startOfDay(now), groups: [] });
  const out = [...days.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const day of out) {
    day.groups.sort((a, b) => (a.current.scheduled_at ?? "9999").localeCompare(b.current.scheduled_at ?? "9999"));
  }
  return out;
}

export interface PastEntry { run: MeetingMock; group: MeetingGroup }
export interface PastDay { key: string; date: Date; entries: PastEntry[] }

const PAST_CAP = 8;

/** The past feed: each meeting's newest finished run, newest first, day-grouped. */
export function pastFeed(groups: MeetingGroup[], cap: number = PAST_CAP): PastDay[] {
  const entries: PastEntry[] = groups
    .filter((g) => g.pastRuns[0] && (g.pastRuns[0].has_recording || g.pastRuns[0].start_time))
    .map((g) => ({ run: g.pastRuns[0], group: g }))
    .sort((a, b) => (b.run.start_time ?? "").localeCompare(a.run.start_time ?? ""))
    .slice(0, cap);
  const days = new Map<string, PastDay>();
  for (const e of entries) {
    const d = e.run.start_time ? new Date(e.run.start_time) : new Date();
    const k = dayKey(d);
    let day = days.get(k);
    if (!day) { day = { key: k, date: startOfDay(d), entries: [] }; days.set(k, day); }
    day.entries.push(e);
  }
  return [...days.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** ONE deviation phrase per row (the rendering law) — or null for the quiet default.
 *  `hasOwnBrief`: an unbound meeting whose brief lives as this meeting's note in the user's OWN
 *  workspace (frame-6 flow) is PREPARED — quiet, same as a bound workspace. */
export function deviationPhrase(g: MeetingGroup, hasOwnBrief = false): { text: string; tone: "live" | "danger" | "accent" } | null {
  const m = g.current;
  if (g.phase === "live") return { text: "in meeting →", tone: "live" };
  if (m.auto_join_error) return { text: "couldn’t import — no meeting link", tone: "danger" };
  if (!m.native_id && !m.meeting_url) return { text: "no meeting link", tone: "danger" };
  if (!m.workspace_id && !hasOwnBrief) return { text: "no brief yet", tone: "accent" };
  return null;
}

// ── own-workspace brief notes (frame 6): ONE tree fetch feeds every row's phrase ───────────────
const OWN_TREE_POLL_MS = 60_000;
function useOwnWorkspaceTree(): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    const look = () => void readActiveSet()
      .then(async set => Promise.all(set.active.filter(mount => mount.role === 'private' && mount.write)
        .map(mount => listWorkspaceTree({ slug: mount.slug }))))
      .then((trees) => { if (alive) setFiles(trees.flat()); })
      .catch(() => { /* keep last good — a blip must not flip rows back to "no brief yet" */ });
    look();
    const t = setInterval(() => { if (document.visibilityState === "visible") look(); }, OWN_TREE_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return files;
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────
const label = (m: MeetingMock) => m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "");

const toneColor = { live: "var(--green)", danger: "var(--danger)", accent: "var(--accent)" } as const;

function timeShort(at?: string): string {
  if (!at) return "no time set";
  try { return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  catch { return "scheduled"; }
}

function Faces({ m }: { m: MeetingMock }) {
  const att = (m.attendees ?? []).slice(0, 3);
  if (!att.length) return null;
  const extra = (m.attendees?.length ?? 0) - att.length;
  const initials = (a: { email: string; name?: string }) =>
    (a.name ? a.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("") : a.email.slice(0, 2)).toUpperCase();
  return (
    <span style={{ display: "inline-flex", flex: "none" }}>
      {att.map((a, i) => (
        <span key={a.email} title={a.name || a.email}
          style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--panel2)", color: "var(--t2)",
            display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700,
            border: "2px solid var(--bg)", marginLeft: i ? -6 : 0 }}>
          {initials(a)}
        </span>
      ))}
      {extra > 0 && (
        <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--panel2)", color: "var(--t3)",
          display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700,
          border: "2px solid var(--bg)", marginLeft: -6 }}>+{extra}</span>
      )}
    </span>
  );
}

function EventRow({ g, ownTree }: { g: MeetingGroup; ownTree: string[] | null }) {
  const m = g.current;
  const nav = usePreviewPinTab<HTMLDivElement>(meetingTab(m));
  const hasOwnBrief = !m.workspace_id && !!ownTree
    && !!findBriefNote(ownTree, { title: label(m), nativeId: m.native_id, meetingId: m.id });
  const dev = deviationPhrase(g, hasOwnBrief);
  return (
    <div className={styles.eventRow} onClick={nav.onClick} onDoubleClick={nav.onDoubleClick}
      role="button" tabIndex={0} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.currentTarget.click(); } }}>
      <span className={styles.eventTitle}>{label(m)}</span>
      <time className={styles.eventTime}>{timeShort(m.scheduled_at)}</time>
      {dev && <span className={styles.deviation} style={{ color: toneColor[dev.tone] }}>{dev.text.replace(/ →$/, "")}</span>}
    </div>
  );
}

function DayRow({ day, isToday, ownTree }: { day: AgendaDay; isToday: boolean; ownTree: string[] | null }) {
  return (
    <div className={styles.dayRow} data-today={isToday}>
      <div className={styles.dayDate}>
        <span className={styles.dayNumber}>{day.date.getDate()}</span>
        <div className={styles.dayCopy}>
          <span>{day.date.toLocaleString(undefined, { month: "long" })}</span>
          <span>{isToday ? "Today" : day.date.toLocaleString(undefined, { weekday: "short" })}</span>
        </div>
      </div>
      <div className={styles.dayEvents}>
        {day.groups.length === 0
          ? <span className={styles.emptyDay}>No events today</span>
          : day.groups.map((g) => <EventRow key={g.key} g={g} ownTree={ownTree} />)}
      </div>
    </div>
  );
}

function PastLine({ m }: { m: MeetingMock }) {
  const [line, setLine] = useState<string>("");
  useEffect(() => {
    let on = true;
    if (!m.has_recording) { setLine(""); return; }
    fetchDurableTranscript(m.id)
      .then((t) => {
        if (!on) return;
        if (t.notes.length) setLine(`${t.notes.length} notes`);
        else if (t.lines?.length) setLine(`${t.lines.length} lines`);
      })
      .catch(() => {});
    return () => { on = false; };
  }, [m.id, m.has_recording]);
  const dur = (() => {
    if (!m.start_time || !m.end_time) return "";
    const min = Math.round((new Date(m.end_time).getTime() - new Date(m.start_time).getTime()) / 60000);
    return min > 0 ? `${min}m` : "";
  })();
  const when = m.start_time
    ? new Date(m.start_time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  return <>{[when, dur, line].filter(Boolean).join(", ")}</>;
}

function PlatformBadge({ platform }: { platform?: string }) {
  const p = (platform || "").toLowerCase();
  let label = "M";
  let bg = "var(--panel2)";
  let color = "var(--t2)";
  let title = "Meeting";
  let logoSrc = "";
  let logoBackground: string | undefined;

  if (p.includes("google") || p.includes("meet")) {
    logoSrc = "/platform-logos/google-meet.svg";
    title = "Google Meet";
  } else if (p.includes("zoom")) {
    logoSrc = "/platform-logos/zoom.png";
    title = "Zoom";
  } else if (p.includes("team")) {
    logoSrc = "/platform-logos/microsoft-teams.png";
    title = "Microsoft Teams";
  } else if (p.includes("discord")) {
    logoSrc = "/platform-logos/discord.svg";
    logoBackground = "var(--panel2)";
    color = "var(--t1)";
    title = "Discord";
  }

  return (
    <span
      title={title}
      role="img"
      aria-label={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: 4,
        background: logoBackground ?? (logoSrc ? "transparent" : bg),
        color,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "var(--mono)",
        flex: "none",
        lineHeight: 1,
      }}
    >
      {logoSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoSrc} alt="" aria-hidden="true" width={18} height={18} style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} />
      ) : label}
    </span>
  );
}

function PastRow({ e, reviewedIds }: { e: PastEntry; reviewedIds: Set<string> }) {
  const run = e.run;
  const layout = useService(LayoutServiceId);
  const open = () => { markReviewed(run.id); layout.openTab(meetingTab(run)); };
  const unreviewed = !reviewedIds.has(run.id);
  const meetingTitle = label(run);

  const askAgent = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    markReviewed(run.id);
    window.dispatchEvent(
      new CustomEvent(ASK_CHAT_EVENT, {
        detail: {
          prompt: `What were the key takeaways, decisions, and action items from "${meetingTitle}"?`,
          focus: meetingFocusFor(run),
        },
      })
    );
  };

  return (
    <div className={styles.pastRow} onClick={open} role="button" tabIndex={0}
      onKeyDown={ev => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(); } }}>
      <div className={styles.pastIdentity}><PlatformBadge platform={run.platform} /><Faces m={run.attendees?.length ? run : e.group.current} /></div>
      <div className={styles.pastTitle}>
        <span>{meetingTitle}</span>
        {run.has_recording
          ? <span className={styles.recap} data-unreviewed={unreviewed}>{unreviewed ? "recap ready" : "recap"}</span>
          : <span className={styles.pastNote}>nothing captured</span>}
      </div>
      <div className={styles.pastActions}>
        {run.has_recording && <button type="button" className={styles.askAgent} title="Ask agent about this meeting" onClick={askAgent}>
          <Icon name="spark" size={14} /><span>Ask agent</span>
        </button>}
        <span className={styles.pastTime}><PastLine m={run} /></span>
      </div>
    </div>
  );
}

// ── the tab ───────────────────────────────────────────────────────────────────────────────────
function TodayView() {
  const meetings = useLiveMeetings();
  const reviewedIds = useReviewed();
  const ownTree = useOwnWorkspaceTree();
  const [weekOffset, setWeekOffset] = useState(0);
  const now = new Date();
  const groups = groupMeetings(meetings);
  const days = agendaWindow(groups, now, weekOffset);
  const past = pastFeed(groups);
  const todayKey = dayKey(now);
  const empty = meetings.length === 0;
  return (
    <div className={styles.screen}>
      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.title}>Coming up</h1>
          <div className={styles.weekNavigation}>
            {weekOffset > 0 && <span className={styles.weekLabel}>
              {days[0]?.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) ?? ""}
            </span>}
            <button aria-label="previous week" className={styles.pager} disabled={weekOffset === 0}
              onClick={() => setWeekOffset((v) => Math.max(0, v - 1))}><Icon name="chevL" size={18} /></button>
            <button aria-label="next week" className={styles.pager}
              onClick={() => setWeekOffset((v) => Math.min(8, v + 1))}><Icon name="chevR" size={18} /></button>
          </div>
        </header>
        <MeetingsOnboarding variant={empty ? "full" : "slim"} />
        {!empty && <div className={styles.timelineLayout} data-has-past={past.length > 0}>
          <section className={styles.agenda} aria-label="Upcoming meetings">
            {days.length === 0 ? <p className={styles.emptyDay}>Nothing this week.</p>
              : days.map((d) => <DayRow key={d.key} day={d} isToday={d.key === todayKey} ownTree={ownTree} />)}
          </section>
          {past.length > 0 && <section className={styles.pastFeed} aria-label="Recent meetings">
            <h2 className={styles.sectionTitle}>Recent meetings</h2>
            {past.map((day) => <div key={day.key} className={styles.pastGroup}>
              <h3 className={styles.pastDate}>{day.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</h3>
              {day.entries.map((e) => <PastRow key={e.run.id} e={e} reviewedIds={reviewedIds} />)}
            </div>)}
          </section>}
        </div>}
        {!empty && <p className={styles.historyHint}>Older meetings live in Knowledge. Ask the agent about anything that was said or decided.</p>}
      </div>
    </div>
  );
}

registerTab("today", TodayView);
