"use client";
/** Meetings user onboarding. the per-user half of the first-run flow (design-spec
 *  first-run-onboarding, frames 4–5). EVERY new user lands here; the admin wizard hands into it
 *  via "Go to Meetings". Two skins over one state:
 *
 *    - `full`. the empty-Meetings center stage: three cards ordered by leverage (connect
 *      calendar / plan a meeting / drop a bot on a running Meet).
 *    - `slim`. the STANDING calendar affordance: a single connect card that stays on the
 *      Meetings page for as long as THIS user has no calendar connected (state-driven, not
 *      visit-count-driven). Renders nothing once connected.
 *
 *  The first calendar action starts Google's read-only OAuth flow, then opens Settings so the
 *  user can choose which calendars to sync. */
import { useEffect, useState } from "react";
import { presentError, readApiFailure } from "./apiClient";
import { defaultBotName } from "./defaultBotName";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { meetingUrlFor, parseMeetingInput } from "./meetingId";
import { resolveJoinError, type ServiceDenialPresentation } from "./serviceDenial";
import { ServiceDenialPanel } from "./ServiceDenialPanel";
import { getJitsiHosts } from "./jitsiHosts";
import { refreshMeetings } from "./liveMeetings";
import { CALENDAR_CONNECTIONS_CHANGED, listCalendars, type CalendarSyncStamp } from "./plannedApi";
import { calendarSettingsCallbackUrl, startGoogleCalendarLink } from "../lib/googleCalendarClient";
import { prepDraftTabDescriptor } from "./meetingPrep";
import styles from "./today.module.css";

/** The success line after a connect: lead with what the sync actually FOUND. */
export function connectOutcome(stamp: CalendarSyncStamp): { ok: boolean; text: string } {
  if (stamp.last_error) return { ok: false, text: `Feed connected but the first sync failed: ${stamp.last_error}` };
  const found = (stamp.counts?.created ?? 0) + (stamp.counts?.updated ?? 0);
  return {
    ok: true,
    text: found > 0
      ? `Feed connected. ${found} upcoming meeting${found === 1 ? "" : "s"} imported.`
      : "Feed connected. No upcoming meetings with joinable links found yet.",
  };
}

/** Loading tri-state so neither skin flashes: null = unknown yet. "Connected" is now "this user
 *  has at least one calendar CONNECTION". the first-run card is about having none at all; the
 *  second, third… calendar is added from Settings → Calendar. */
function useCalendarConnected(): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      listCalendars().then((calendars) => {
        if (active) setConnected(calendars.length > 0);
      }).catch(() => { if (active) setConnected(null); });
    };
    refresh();
    window.addEventListener(CALENDAR_CONNECTIONS_CHANGED, refresh);
    return () => { active = false; window.removeEventListener(CALENDAR_CONNECTIONS_CHANGED, refresh); };
  }, []);
  return connected;
}

/** The drop-a-bot card's inline sender. same POST /api/bots edge and error taxonomy as the sidebar. */
function DropBotInline() {
  const [url, setUrl] = useState("");
  const [sent, setSent] = useState<null | "sending" | "ok" | "err">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [denial, setDenial] = useState<ServiceDenialPresentation | null>(null);
  const send = async () => {
    const u = url.trim();
    if (!u || sent === "sending") return;
    const parsed = parseMeetingInput(u, await getJitsiHosts());
    if (!parsed) { setSent("err"); setMsg("That doesn't look like a Meet / Zoom / Teams / Jitsi / Discord link."); setDenial(null); return; }
    setSent("sending"); setMsg(null); setDenial(null);
    try {
      const r = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: parsed.platform, native_meeting_id: parsed.native_meeting_id, meeting_url: meetingUrlFor(parsed, u), bot_name: defaultBotName() }),
      });
      if (r.ok) {
        setSent("ok"); setUrl("");
        refreshMeetings(); setTimeout(refreshMeetings, 2000); setTimeout(refreshMeetings, 6000);
      } else {
        setSent("err");
        if (r.status === 429) setMsg("You're at your meeting limit. Stop one first.");
        else if (r.status === 409) setMsg("That meeting already has a bot.");
        else if (r.status === 401) setMsg("Not signed in. Sign in and retry.");
        else {
          // Everything else used to land as `Couldn't send (403): {"code":"service_not_allowed",…}`
          //. the raw denial payload, in the user's face. A refusal from the deciding service now
          // gets its own panel; the rest still goes through the presenter seam.
          const state = resolveJoinError(await readApiFailure(r, "/api/bots"));
          if (state.kind === "denial") { setDenial(state.presentation); setMsg(null); }
          else setMsg(state.headline);
        }
      }
    } catch { setSent("err"); setMsg("Couldn't reach the server."); }
  };
  return (
    <div className={styles.botForm}>
      <div className={styles.botInputRow}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          aria-label="Meeting link" placeholder="Paste a meeting link (Meet / Zoom / Teams / Jitsi / Discord)…" className={styles.meetingInput} />
        <button onClick={() => void send()} disabled={!url.trim() || sent === "sending"}
          className={styles.sendButton} aria-busy={sent === "sending"}>
          <Icon name="send" size={16} />{sent === "sending" ? "…" : "Send bot"}
        </button>
      </div>
      {sent === "ok" && <div style={{ fontSize: 11, color: "var(--green)", lineHeight: 1.4 }}>Bot sent. Admit it in the meeting.</div>}
      {denial
        ? <ServiceDenialPanel presentation={denial} onRetry={() => void send()} />
        : sent === "err" && msg && <div role="alert" style={{ fontSize: 11, color: "var(--danger)", lineHeight: 1.4 }}>{msg}</div>}
    </div>
  );
}

export function MeetingsOnboarding({ variant }: { variant: "full" | "slim" }) {
  const connected = useCalendarConnected();
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const layout = useService(LayoutServiceId);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tina-calendar-settings") !== "google-linked") return;
    url.searchParams.delete("tina-calendar-settings");
    window.history.replaceState(window.history.state, "", url);
    layout.openSettings();
  }, [layout]);
  // "+ Plan a meeting" opens a DRAFT prep tab. no backend row until the user fills something in, so
  // an abandoned draft leaves no empty meeting behind (the prep tab creates the row lazily).
  const plan = () => layout.openTab(prepDraftTabDescriptor());
  const connectCalendar = async () => {
    setCalendarBusy(true);
    setCalendarError(null);
    try {
      await startGoogleCalendarLink(calendarSettingsCallbackUrl(window.location.href));
    } catch (error) {
      setCalendarError(presentError(error).headline);
      setCalendarBusy(false);
    }
  };

  // slim = the STANDING affordances on a populated Meetings page: plan + drop-bot are ALWAYS
  // available (owner ruling 2026-07-09); the calendar card additionally shows while this user
  // has no calendar connected.
  if (variant === "slim") {
    return (
      <div className={styles.onboarding}>
        {connected === false && <div className={styles.calendarNotice}>
          <div className={styles.calendarCopy}><strong><Icon name="cal" size={18} /> No calendar connected</strong>
            <p>Connect Google Calendar with read-only access, then choose which calendars TINA should sync. Auto-join stays off until you enable it for a calendar.</p>
          </div>
          <button className={styles.connectButton} disabled={calendarBusy} onClick={() => void connectCalendar()}>{calendarBusy ? "Connecting…" : "Connect Google Calendar"}</button>
          {calendarError && <div role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{calendarError}</div>}
        </div>}
        <div className={styles.meetingActions}>
          <button className={styles.planButton} onClick={() => plan()}><Icon name="plus" size={18} /><span>Plan a meeting</span></button>
          <div className={styles.dropBot}><DropBotInline /></div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.onboarding}>
      <p className={styles.intro}>Nothing here yet. Choose how meetings should arrive.</p>
      {connected !== true && <div className={styles.calendarNotice}>
        <div className={styles.calendarCopy}><strong><Icon name="cal" size={18} /> Connect your calendar</strong>
          <p>Connect Google Calendar with read-only access, then choose which calendars TINA should sync. Auto-join stays off until you enable it for a calendar.</p>
        </div>
        <button className={styles.connectButton} disabled={calendarBusy} onClick={() => void connectCalendar()}>{calendarBusy ? "Connecting…" : "Connect Google Calendar"}</button>
        {calendarError && <div role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{calendarError}</div>}
      </div>}
      <div className={styles.emptyActions}>
        <div className={styles.planSection}>
          <p>Create a meeting with a title, time, and meeting link.</p>
          <button className={styles.planButton} onClick={() => plan()}><Icon name="plus" size={18} />Plan a meeting</button>
        </div>
        <div className={styles.sendSection}>
          <h2 className={styles.sectionTitle}>Drop a bot in now</h2>
          <p>Send the notetaker into a meeting that is already running.</p>
          <DropBotInline />
        </div>
      </div>
      {connected === true && <p className={styles.calendarConnected}>Calendar connected. Scheduled meetings appear as they sync. Add more calendars in Settings, Calendar.</p>}
    </div>
  );
}
