"use client";
/** Meetings (mocked backend) — the differentiator flow.
 *  • "meetings" LIST: the live one auto-opens; the section link leads to Today in the center.
 *  • "meeting" TAB (center): fixed meeting chrome around the Meeting Canvas body.
 *    The generated canvas view consumes this meeting's live MeetingState. */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FileText, List } from "lucide-react";
import { useService } from "../platform";
import { LayoutServiceId, type TabDescriptor } from "../workbench/layout";
import { registerList, registerTab, registerCommand, type TabProps } from "../contributions";
import { meetingIdFromPath } from "../app/meetingRoute";
import { Icon } from "../ui-kit";
import pageStyles from "./meetingPage.module.css";
import { MeetingKnowledge } from './MeetingKnowledge';
import { meetingsOnly } from '../app/mode';
import { ContextMenu, copyText } from "../ui-kit/ContextMenu";
import { MEETING_CANVAS_CONTENT_INSET, MeetingCanvasView } from "../canvas/MeetingCanvasView";
import { meetingPhase, type MeetingMock } from "./meetingModel";
import { ApiError, presentError, readApiFailure } from "./apiClient";
import { serviceDenialFromError, type ServiceDenialPresentation } from "./serviceDenial";
import { ServiceDenialPanel } from "./ServiceDenialPanel";
import { useLiveMeetings, useLiveMeetingsConnection, useLiveMeetingsLoaded, getLiveMeeting, liveMeetingsNow, refreshMeetings, seedLiveMeetingFromResponse } from "./liveMeetings";
import { usePreviewPinTab } from "./previewPinTab";
import { defaultBotName } from "./defaultBotName";
import { discordChannelUrl, meetingUrlFor } from "./meetingId";
import { getJitsiHosts } from "./jitsiHosts";
import { mintTranscriptShare, mintInvite, listSharedMemberships, type Membership } from "./workspaceApi";
import { deletePlannedMeeting, MAX_CALENDARS, listCalendars, createCalendar, updateCalendar, syncCalendar, getCalendarSyncStatus, type CalendarConnection, type CalendarSyncStamp } from "./plannedApi";
import { prepTabDescriptor, prepDraftTabDescriptor } from "./meetingPrep";
import { LiveAssistRunningView } from "./LiveAssistRunningView";
import {
  EMPTY_LIVE_ASSIST_DRAFT,
  mergeLiveMeetingState,
  readAllLiveMeetingState,
  readLiveMeetingState,
  readPlannedLiveAssistDraft,
  writePlannedLiveAssistDraft,
  postLiveMeetingStateAction,
  type LiveMeetingStateSnapshot,
  type PlannedLiveAssistDraft,
} from "./liveMeetingStateApi";

// ── "Share session" — mint a link to this meeting's LIVE FEED (independent transcript share) and,
//    optionally, BUNDLE a shared-workspace invite into the SAME link (?tshare=…&invite=…). The two are
//    decoupled capabilities; this is the one-click way to hand someone both at once. ─────────────────
export function ShareSessionButton({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("open");
  const [emails, setEmails] = useState("");
  const [ttlDays, setTtlDays] = useState(7);
  const [wsId, setWsId] = useState("");            // "" = transcript only; else also bundle this workspace invite
  const [shares, setShares] = useState<Membership[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    void listSharedMemberships().then((ms) => setShares(ms.filter((m) => m.role === "owner" || m.role === "contributor"))).catch(() => {});
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const allowed = mode === "restricted" ? emails.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : undefined;
      const t = await mintTranscriptShare(meetingId, { mode, allowed_emails: allowed, expires_in_sec: ttlDays * 86400 });
      const params = new URLSearchParams();
      params.set("tshare", t.token);
      if (wsId) {  // bundle a workspace membership invite into the same link
        const inv = await mintInvite({ workspace_id: wsId, role: "contributor", mode, expires_in_sec: ttlDays * 86400, max_uses: mode === "open" ? 50 : 1, allowed_emails: allowed });
        params.set("invite", inv.token);
      }
      setLink(`${window.location.origin}/?${params.toString()}`);
    } catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };
  const fieldStyle = { fontSize: 12, padding: "4px 6px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--t1)" } as const;
  return (
    <div ref={ref} style={{ position: "relative", flex: "none" }}>
      <button onClick={() => { setOpen((v) => !v); setLink(null); }} title="Share this meeting's live feed (and optionally a workspace)"
        style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", border: "1px solid var(--line2)", color: "var(--t2)", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" }}>
        <Icon name="upload" size={12} /> Share session
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 6, width: 280, background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,.32)", padding: 12, zIndex: 50, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em" }}>Share session</div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value); setLink(null); }} style={{ ...fieldStyle, flex: 1 }}>
              <option value="open">anyone with link</option>
              <option value="restricted">restricted (emails)</option>
            </select>
            <select value={ttlDays} disabled={busy} onChange={(e) => { setTtlDays(Number(e.target.value)); setLink(null); }} style={fieldStyle}>
              <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option>
            </select>
          </div>
          {mode === "restricted" && (
            <input value={emails} placeholder="allowed emails (comma-separated)" disabled={busy}
              onChange={(e) => { setEmails(e.target.value); setLink(null); }} style={fieldStyle} />
          )}
          <select value={wsId} disabled={busy} onChange={(e) => { setWsId(e.target.value); setLink(null); }} style={fieldStyle} title="Optionally bundle a shared workspace into the link">
            <option value="">live feed only (no workspace)</option>
            {shares.map((s) => <option key={s.workspace_id} value={s.workspace_id}>+ workspace: {s.workspace_id}</option>)}
          </select>
          {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>{err}</div>}
          {link ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} style={{ ...fieldStyle, flex: 1, fontSize: 11 }} />
              <button onClick={() => void copyText(link)} style={{ fontSize: 12, padding: "4px 10px", background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 6, cursor: "pointer" }}>Copy</button>
            </div>
          ) : (
            <button disabled={busy} onClick={() => void create()} style={{ fontSize: 12, padding: "5px 10px", background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 6, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>{busy ? "Creating…" : "Create link"}</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Connected docs — the meeting's knowledge-graph entity + the [[entities]] it links ─────────────
//  The meeting doc lives at a deterministic path: kg/entities/meeting/<native>.md. When present we show
//  its title + the [[wikilinks]] parsed from the body as chips that open that entity's doc. A wikilink
//  [[Title]] is resolved to a real doc by matching its slug against the workspace tree (so we open the
//  entity under its true type folder, whatever that is). 404 → a quiet "no notes yet" state.
// No client subject: workspace docs are read through the gateway, which injects X-User-Id → agent-api scopes (P20).
const docSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const baseName = (p: string) => p.split("/").pop() ?? p;
const docTabFor = (path: string, title: string): TabDescriptor =>
  ({ id: `doc:${path}`, title, kind: "doc", params: { path } });

type ConnectedDoc = { workspace: string; path: string; title?: string; kind?: string };

function ConnectedDocChip({ doc }: { doc: ConnectedDoc }) {
  const label = doc.title || baseName(doc.path).replace(/\.md$/, "");
  const nav = usePreviewPinTab<HTMLButtonElement>(docTabFor(doc.path, label));
  return (
    <button onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} title={`Open ${doc.path}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--t1)", fontSize: 12.5, cursor: "pointer", maxWidth: 280 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.borderColor = "var(--line2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; e.currentTarget.style.borderColor = "var(--line)"; }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--blue)", flex: "none" }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {doc.kind && <span style={{ fontSize: 9.5, color: "var(--t3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".04em" }}>{doc.kind}</span>}
    </button>
  );
}

function MeetingDocChip({ native, title, hasLinks }: { native: string; title: string; hasLinks: boolean }) {
  const nav = usePreviewPinTab<HTMLButtonElement>(docTabFor(`kg/entities/meeting/${native}.md`, title));
  return (
    <button onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} title="Open this meeting's notes"
      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px 5px 6px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--t1)", fontSize: 12.5, cursor: "pointer", maxWidth: 360, marginBottom: hasLinks ? 8 : 0 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.borderColor = "var(--line2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; e.currentTarget.style.borderColor = "var(--line)"; }}>
      <span style={{ width: 18, height: 18, flex: "none", borderRadius: 5, background: "var(--accentbg)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="panel" size={11} /></span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
    </button>
  );
}

function WikiLinkChip({ title, path }: { title: string; path: string }) {
  const nav = usePreviewPinTab<HTMLButtonElement>(docTabFor(path, title));
  return (
    <button onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} title={`Open ${title}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--t1)", fontSize: 12.5, cursor: "pointer", maxWidth: 280 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.borderColor = "var(--line2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; e.currentTarget.style.borderColor = "var(--line)"; }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--blue)", flex: "none" }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
    </button>
  );
}

// ── Connected (data.docs) — the meeting-api now ships data.docs = the workspace docs this meeting
//  produced. When present we render them as chips grouped by kind, each opening that doc.path in a doc
//  tab. When EMPTY we fall back to the deterministic meeting-doc path below.
function ConnectedDocsPanel({ docs }: { docs: ConnectedDoc[] }) {
  // group by kind, preserving first-seen order
  const groups: { kind: string; docs: ConnectedDoc[] }[] = [];
  const byKind = new Map<string, ConnectedDoc[]>();
  for (const d of docs) {
    const k = d.kind || "doc";
    if (!byKind.has(k)) { byKind.set(k, []); groups.push({ kind: k, docs: byKind.get(k)! }); }
    byKind.get(k)!.push(d);
  }
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px" }}>
        <span style={{ fontSize: 10.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600 }}>Connected</span>
        <span style={{ fontSize: 10.5, color: "var(--t3)", fontFamily: "var(--mono)" }}>{docs.length}</span>
        <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
      </div>
      {groups.map((g) => (
        <div key={g.kind} style={{ marginBottom: 10 }}>
          {groups.length > 1 && <div style={{ fontSize: 10, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".05em", margin: "0 2px 6px" }}>{g.kind}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{g.docs.map((d, i) => <ConnectedDocChip key={`${d.path}-${i}`} doc={d} />)}</div>
        </div>
      ))}
    </div>
  );
}

function ConnectedPanel({ native, docs }: { native: string; docs?: ConnectedDoc[] }) {
  // data.docs first — when the meeting carries connected docs, render them and skip the path fallback
  const hasDocs = !!docs?.length;
  const [state, setState] = useState<{ status: "loading" | "absent" | "present"; title: string; links: string[] }>({ status: "loading", title: "", links: [] });
  // slug → real entity doc path, built from the workspace tree (so a [[Title]] resolves to its true type)
  const [slugMap, setSlugMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const path = `kg/entities/meeting/${native}.md`;
    void (async () => {
      try {
        const r = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
        if (!alive) return;
        if (!r.ok) { setState({ status: "absent", title: "", links: [] }); return; }
        const content: string = (await r.json()).content ?? "";
        const fmTitle = content.match(/^---\n([\s\S]*?)\n---/)?.[1]?.split("\n").find((l) => l.startsWith("title:"))?.slice(6).trim();
        const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const title = (fmTitle || h1 || native).replace(/^["']|["']$/g, "");
        const links = [...new Set([...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()).filter(Boolean))];
        setState({ status: "present", title, links });
      } catch { if (alive) setState({ status: "absent", title: "", links: [] }); }
    })();
    return () => { alive = false; };
  }, [native]);

  // load the tree once so wikilink slugs resolve to their real entity doc paths
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const files: string[] = (await (await fetch(`/api/workspace/tree`)).json()).files ?? [];
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const f of files) if (f.startsWith("kg/entities/") && f.endsWith(".md")) map[baseName(f).replace(/\.md$/, "")] = f;
        setSlugMap(map);
      } catch { /* offline — keep wikilinks on the meeting doc */ }
    })();
    return () => { alive = false; };
  }, []);

  if (hasDocs) return <ConnectedDocsPanel docs={docs!} />;
  if (state.status === "loading") return null;
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px" }}>
        <span style={{ fontSize: 10.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600 }}>Connected</span>
        {state.status === "present" && state.links.length > 0 && <span style={{ fontSize: 10.5, color: "var(--t3)", fontFamily: "var(--mono)" }}>{state.links.length}</span>}
        <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
      </div>
      {state.status === "absent" && (
        <div style={{ fontSize: 12.5, color: "var(--t3)", padding: "2px 2px", lineHeight: 1.5 }}>No notes yet — they&apos;re written when the meeting ends (or a prep routine runs).</div>
      )}
      {state.status === "present" && (
        <>
          <MeetingDocChip native={native} title={state.title} hasLinks={state.links.length > 0} />
          {state.links.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {state.links.map((l) => {
                const slug = docSlug(l);
                const path = slugMap[slug] ?? `kg/entities/meeting/${native}.md`;
                return <WikiLinkChip key={l} title={l} path={path} />;
              })}
            </div>
          )}
          {state.links.length === 0 && <div style={{ fontSize: 12.5, color: "var(--t3)", padding: "2px 2px" }}>Notes recorded: no linked entities yet.</div>}
        </>
      )}
    </div>
  );
}

// ── Per-meeting status badge + action dropdown ─────────────────────────────────────
//  The badge shows the REAL meeting-api status; the dropdown is an ACTION→TRANSITION map (not free
//  status editing) — each item calls ONE endpoint that performs the one legal write (design doc §B).
type BadgeKind = "intent" | "live" | "awaiting" | "needshelp" | "stopping" | "terminal";
const STATUS_BADGE: Record<string, { label: string; color: string; bg: string; kind: BadgeKind }> = {
  idle: { label: "Idle", color: "var(--t3)", bg: "var(--panel2)", kind: "intent" },
  scheduled: { label: "Scheduled", color: "var(--blue)", bg: "var(--bluebg)", kind: "intent" },
  requested: { label: "Requested", color: "var(--accent)", bg: "var(--accentbg)", kind: "live" },
  joining: { label: "Joining", color: "var(--accent)", bg: "var(--accentbg)", kind: "live" },
  awaiting_admission: { label: "Waiting for host approval", color: "var(--violet)", bg: "var(--violetbg)", kind: "awaiting" },
  needs_help: { label: "Needs help", color: "var(--warn)", bg: "var(--warnbg)", kind: "needshelp" },
  active: { label: "Live", color: "var(--green)", bg: "var(--greenbg)", kind: "live" },
  stopping: { label: "Stopping", color: "var(--t3)", bg: "var(--panel2)", kind: "stopping" },
  completed: { label: "Completed", color: "var(--green)", bg: "var(--greenbg)", kind: "terminal" },
  failed: { label: "Failed", color: "var(--danger)", bg: "var(--dangerbg)", kind: "terminal" },
  stopped: { label: "Stopped", color: "var(--t3)", bg: "var(--panel2)", kind: "terminal" },
};
const badgeFor = (raw?: string) => STATUS_BADGE[raw ?? ""] ?? { label: raw ?? "—", color: "var(--t3)", bg: "var(--panel2)", kind: "terminal" as BadgeKind };

type MeetingActionFailure = {
  actionId: string; actionLabel: string; native: string; message: string;
  /** Set when the deciding service REFUSED (403 service_not_allowed / 503 authority-unavailable).
   *  The row renders the panel instead of the one-line message, and does not auto-clear it. */
  denial?: ServiceDenialPresentation | null;
};
type MeetingActionFailureHandler = (failure: MeetingActionFailure) => void;
export type MeetingActionSuccess = { meetingId?: string };
type MeetingActionSuccessHandler = (result: MeetingActionSuccess) => void;
type RowAction = {
  id: string;
  label: string;
  tone: "accent" | "live" | "muted";
  run: (onFailure?: MeetingActionFailureHandler, onSuccess?: MeetingActionSuccessHandler) => Promise<void> | void;
};

/** A non-ok action response as a STRUCTURED failure (status + backend detail + the intact body),
 *  never a raw string. Shared with `getJson`'s error path so both edges produce the same object. */
const readFailure = (r: Response): Promise<ApiError> => readApiFailure(r);

/** User-truth message for a failed bot/row action (issue #674): a `404` means the backend no
 *  longer has this meeting — the list re-snapshot (runMeetingAction's `finally`) reconciles the
 *  control, so say that; a `409` is the duplicate/already case. Everything else goes through the
 *  presenter seam. Exported (additive) so the action test pins the vocabulary. */
export function presentMeetingActionFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "This meeting is no longer active — refreshing the list.";
    if (error.status === 409) return "That meeting already has a bot.";
  }
  // A refusal from the deciding service says WHY in its own words — "Your key doesn't have access
  // to this." is a lie about a bot that was refused for some other reason entirely.
  const denial = serviceDenialFromError(error);
  if (denial) return denial.headline;
  return presentError(error).headline;
}

async function runMeetingAction(
  action: Omit<MeetingActionFailure, "message">,
  request: Promise<Response>,
  onFailure?: MeetingActionFailureHandler,
  onSuccess?: MeetingActionSuccessHandler,
  extractMeetingId = false,
): Promise<void> {
  try {
    const r = await request;
    if (!r.ok) throw await readFailure(r);
    let meetingId: string | undefined;
    if (extractMeetingId && typeof r.json === "function") {
      const body = await r.json().catch(() => null);
      meetingId = seedLiveMeetingFromResponse(body);
    }
    onSuccess?.({ meetingId });
  } catch (error) {
    // Operator channel keeps the full plumbing (P18); the UI channel gets the presented truth.
    console.warn("meeting action failed", { ...action, message: String(error instanceof Error ? error.message : error) });
    onFailure?.({ ...action, message: presentMeetingActionFailure(error), denial: serviceDenialFromError(error) });
  } finally {
    refreshMeetings();
  }
}

/** The action→transition map for a row, keyed on its REAL status. Each action hits exactly one endpoint.
 *  Exported (additive — no runtime behavior change) so the behavioral test can assert each status offers
 *  the correct actions and each fires the correct endpoint+body. */
export function actionsFor(m: MeetingMock): RowAction[] {
  const native = m.native_id ?? m.id;
  // The model stores platform DISPLAY-cased ("Google Meet", else the raw API slug like "teams"/"zoom").
  // Stop targets DELETE /bots/{platform}/{native}, so normalise back to the slug — hardcoding google_meet
  // 404s ("No active meeting for this bot") for a live Teams/Zoom bot.
  const platformSlug = m.platform === "Google Meet" ? "google_meet" : m.platform.toLowerCase().replace(/\s+/g, "_");
  // A link-less row still has a constructible address for the platforms whose id names the whole
  // destination (Meet dash-code, Discord guild+channel). Zoom/Teams/jitsi carry deployment or
  // passcode context in the link itself, so they must supply it.
  const constructedUrl = platformSlug === "google_meet" ? `https://meet.google.com/${native}`
    : platformSlug === "discord" ? discordChannelUrl(native) : null;
  const intent = (state: "idle" | "scheduled", at?: string, onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: state === "idle" ? "cancel" : "schedule", actionLabel: state === "idle" ? "Cancel" : "Schedule", native }, fetch(`/api/meetings/${platformSlug}/${encodeURIComponent(native)}/intent`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: state, ...(at ? { at } : {}) }),
    }), onFailure);
  const send = (onFailure?: MeetingActionFailureHandler, onSuccess?: MeetingActionSuccessHandler) =>
    runMeetingAction({ actionId: "send", actionLabel: "Send now", native }, fetch("/api/bots", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: platformSlug, native_meeting_id: native,
        // the row's real link when it has one (zoom/teams NEED it); gmeet/discord can be constructed
        ...(m.meeting_url || constructedUrl ? { meeting_url: meetingUrlFor({ platform: platformSlug, native_meeting_id: native }, m.meeting_url || constructedUrl!) } : {}),
        bot_name: defaultBotName(),
      }),
    }), onFailure, onSuccess, true);
  // Delete a PLANNED row — ROW-id addressed (a link-less plan has no platform/native path).
  const del = (onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: "delete", actionLabel: "Delete", native }, fetch(`/api/meetings/${encodeURIComponent(m.id)}`, { method: "DELETE" }), onFailure);
  // Cancel (clear the time) on a LINK-LESS planned row — PATCH by row id (no native path exists).
  const cancelById = (onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: "cancel", actionLabel: "Cancel", native }, fetch(`/api/meetings/${encodeURIComponent(m.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheduled_at: null }),
    }), onFailure);
  // Stop = the gateway-backed user-stop route DELETE /bots/{platform}/{native} (meeting-api lifecycle/stop_router).
  const stop = (onFailure?: MeetingActionFailureHandler) =>
    runMeetingAction({ actionId: "stop", actionLabel: "Stop", native }, fetch(`/api/bots/${platformSlug}/${encodeURIComponent(native)}`, { method: "DELETE" }), onFailure);
  const schedule = (onFailure?: MeetingActionFailureHandler) => {
    // minimal time picker: prompt for a local datetime, send as ISO. (A richer picker can replace this.)
    const def = new Date(Date.now() + 3600_000).toISOString().slice(0, 16);
    const input = typeof window !== "undefined" ? window.prompt("Schedule for (YYYY-MM-DD HH:MM, local):", def) : null;
    if (!input) return;
    const at = new Date(input).toISOString();
    return intent("scheduled", at, onFailure);
  };

  const raw = m.live_status ?? (m.status === "live" ? "active" : "completed");
  if (raw === "failed" && m.auto_retry?.state === "scheduled") {
    return [{ id: "stop", label: "Cancel retry", tone: "live", run: stop }];
  }
  const hasLink = !!m.native_id;
  if (raw === "awaiting_admission") {
    return [{ id: "stop", label: "Stop waiting", tone: "live", run: stop }];
  }
  switch (raw) {
    case "idle":
      return [
        ...(hasLink ? [
          { id: "schedule", label: "Schedule", tone: "accent", run: schedule } as RowAction,
          { id: "send", label: "Send now", tone: "accent", run: send } as RowAction,
        ] : []),
        { id: "delete", label: "Delete", tone: "muted", run: del },
      ];
    case "scheduled":
      return [
        ...(hasLink ? [{ id: "send", label: "Send now", tone: "accent", run: send } as RowAction] : []),
        { id: "cancel", label: "Cancel", tone: "muted", run: (onFailure?: MeetingActionFailureHandler) => hasLink ? intent("idle", undefined, onFailure) : cancelById(onFailure) },
        { id: "delete", label: "Delete", tone: "muted", run: del },
      ];
    case "requested": case "joining": case "needs_help": case "active": case "stopping":
      return [{ id: "stop", label: "Stop", tone: "live", run: stop }];
    case "completed": case "failed": case "stopped": default:
      return [{ id: "resend", label: "Re-send", tone: "accent", run: send }];
  }
}

function StatusBadge({ raw }: { raw?: string }) {
  const b = badgeFor(raw);
  const dot = b.kind === "live" || b.kind === "needshelp";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 7px", borderRadius: 5, background: b.bg, color: b.color, fontSize: 10, fontWeight: 600, letterSpacing: ".02em", whiteSpace: "nowrap", flex: "none" }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: b.color }} />}{b.label}
    </span>
  );
}

function autoRetryMessage(m: MeetingMock): string | null {
  const retry = m.auto_retry;
  if (!retry) return null;
  if (retry.state === "manual_only" && m.live_status === "failed") return "This meeting needs a passcode, so send it again manually.";
  if (retry.state === "exhausted") return "Automatic retries are exhausted. Use Send bot again to retry.";
  if (retry.state === "failed") return "Automatic retry failed. Use Send bot again to retry.";
  if (retry.state === "not_retryable") return "This failure will not be retried automatically.";
  if (retry.state !== "scheduled" && !(retry.state === "in_progress" && retry.attempt > 1)) return null;
  const attempt = retry.attempt + (retry.state === "scheduled" ? 1 : 0);
  return `TINA is retrying automatically · attempt ${attempt} of ${retry.max_attempts}`;
}

/** Status badge (only when meaningful) + a small ▾ menu of action→transition items for one meeting row.
 *  The ▾ is revealed on row hover (or while its menu is open) to keep the list quiet at rest. */
function RowActions({
  m,
  showBadge,
  reveal,
  onActionStart,
  onActionFailure,
  onActionSuccess,
}: {
  m: MeetingMock;
  showBadge: boolean;
  reveal: boolean;
  onActionStart?: () => void;
  onActionFailure?: MeetingActionFailureHandler;
  onActionSuccess?: (actionId: string, result: MeetingActionSuccess) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const acts = actionsFor(m);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", flex: "none", display: "inline-flex", alignItems: "center", gap: 5 }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {showBadge && <StatusBadge raw={m.live_status} />}
      {acts.length > 0 && (reveal || open) && (
        <button title="Actions" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, background: open ? "var(--panel2)" : "transparent", border: "1px solid var(--line2)", color: open ? "var(--t1)" : "var(--t2)", borderRadius: 6, padding: 0, cursor: "pointer", transition: "all 0.12s ease" }}>
          <Icon name="chevD" size={11} />
        </button>
      )}
      {open && (
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, minWidth: 132, background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,.28)", padding: 4, zIndex: 40 }}>
          {acts.map((a) => (
            <button key={a.id} onClick={(e) => { e.stopPropagation(); setOpen(false); onActionStart?.(); void a.run(onActionFailure, (res) => onActionSuccess?.(a.id, res)); }}
              style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: a.tone === "live" ? "var(--danger)" : a.tone === "muted" ? "var(--t2)" : "var(--accent)", borderRadius: 6, padding: "6px 9px", fontSize: 12, fontWeight: 550, cursor: "pointer" }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--panel2)")} onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const INTENT_STATUSES = new Set(["idle", "scheduled"]);

export function meetingTab(m: MeetingMock): TabDescriptor {
  // A PLANNED (intent-status) row opens its PREP tab — title/time/link editing, workspace bind,
  // share. Once the bot claims the row (requested→…), the same row opens the live meeting view.
  if (INTENT_STATUSES.has(m.live_status ?? "")) return prepTabDescriptor({ id: m.id, title: m.title_custom || m.title });
  return { id: `meeting:${m.id}`, title: m.title.split(" — ")[0], kind: "meeting", params: { meetingId: m.id } };
}

// Statuses worth a badge — `active` (in-room) is shown by the green dot alone, not a badge; the rest
// (stopped/completed/failed) live under the "Recorded" header already.
const BADGE_STATUSES = new Set(["idle", "scheduled", "requested", "joining", "awaiting_admission", "needs_help", "stopping"]);

function MeetingRow({ m }: { m: MeetingMock }) {
  const layout = useService(LayoutServiceId);
  const nav = usePreviewPinTab<HTMLDivElement>(meetingTab(m));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState(false);
  const [actionFailure, setActionFailure] = useState<MeetingActionFailure | null>(null);
  const native = m.native_id ?? m.id;
  const live = m.status === "live";
  const inRoom = m.live_status === "active";   // actually live = green dot + a quiet "live", no badge
  // A planned meeting's user-given title wins; else just the meeting code — the platform is implicit.
  const label = m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "");
  const showBadge = BADGE_STATUSES.has(m.live_status ?? "");
  const isIntent = INTENT_STATUSES.has(m.live_status ?? "");
  const retryMessage = autoRetryMessage(m);
  useEffect(() => {
    if (!actionFailure) return;
    // A service denial is a thing the user must ACT on (add funds, finish setup, raise the cap) —
    // it must not evaporate on a 6s timer the way a transient "already has a bot" should.
    if (actionFailure.denial) return;
    const t = window.setTimeout(() => setActionFailure(null), 6000);
    return () => window.clearTimeout(t);
  }, [actionFailure]);
  return (
    <div onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }} style={{ padding: "7px 9px", borderRadius: 7, cursor: "pointer", marginBottom: 1 }}
      onMouseEnter={(e) => { setHover(true); e.currentTarget.style.background = "var(--panel2)"; }} onMouseLeave={(e) => { setHover(false); e.currentTarget.style.background = "transparent"; }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {inRoom && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flex: "none" }} />}
        <span style={{ fontSize: 13, color: live ? "var(--t1)" : "var(--t2)", fontWeight: live ? 600 : 400, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {m.shared && <span title="Shared with you (you don't own this meeting)" style={{ flex: "none", fontSize: 9.5, color: "var(--t3)", border: "1px solid var(--line)", borderRadius: 5, padding: "0 5px" }}>shared</span>}
        {(m.native_id || isIntent) && !m.shared && (
          <RowActions
            m={m}
            showBadge={showBadge}
            reveal={hover}
            onActionStart={() => setActionFailure(null)}
            onActionFailure={setActionFailure}
            onActionSuccess={(actionId, res) => {
              if ((actionId === "resend" || actionId === "send") && res.meetingId) {
                const next = getLiveMeeting(res.meetingId);
                layout.openTab(
                  next
                    ? meetingTab(next)
                    : { id: `meeting:${res.meetingId}`, title: label, kind: "meeting", params: { meetingId: res.meetingId } },
                );
              }
            }}
          />
        )}
      </div>
      <div style={{ fontSize: 11, color: inRoom ? "var(--green)" : "var(--t3)", marginTop: 1, paddingLeft: inRoom ? 13 : 0 }}>{inRoom ? "live" : m.when}</div>
      {retryMessage && (
        <div role="status" style={{ fontSize: 11, color: "var(--accent)", marginTop: 3, lineHeight: 1.35 }}>
          {retryMessage}
        </div>
      )}
      {isIntent && m.auto_join_error && (
        <div role="alert" style={{ fontSize: 11, color: "var(--danger)", marginTop: 3, lineHeight: 1.35 }}>
          Auto-join failed: {m.auto_join_error}
        </div>
      )}
      {m.live_status === "failed" && m.join_failure_summary && (
        <div role="status" style={{ fontSize: 11, color: "var(--danger)", marginTop: 3, lineHeight: 1.35 }}>
          {m.join_failure_summary}
        </div>
      )}
      {actionFailure?.denial ? (
        <div onClick={(e) => e.stopPropagation()}>
          <ServiceDenialPanel presentation={actionFailure.denial} />
        </div>
      ) : actionFailure && (
        <div role="status" aria-live="polite" style={{ fontSize: 11, color: "var(--danger)", marginTop: 4, lineHeight: 1.35 }}>
          {actionFailure.actionLabel} failed: {actionFailure.message}
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { id: "copy-reference", label: "Copy reference", detail: `@meeting:${native}`, onSelect: () => copyText(`@meeting:${native}`) },
        ]} />
      )}
    </div>
  );
}

// ── "+ Plan a meeting" — opens a DRAFT prep tab. No backend row is created here; the prep tab
//    creates the row lazily on the first real input (title/link/date, brief chat, …), so abandoning
//    the tab never leaves an empty "Untitled meeting" behind. ───────────────────────────────────────
function PlanMeetingButton() {
  const layout = useService(LayoutServiceId);
  return (
    <button title="Plan a meeting" onClick={() => layout.openTab(prepDraftTabDescriptor())}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        height: 31,
        textAlign: "left",
        background: "transparent",
        border: "none",
        color: "var(--t2)",
        borderRadius: 5,
        padding: "0 8px",
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
        transition: "background .12s, color .12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--panel2)";
        e.currentTarget.style.color = "var(--t1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--t2)";
      }}>
      <Icon name="cal" size={15} style={{ color: "var(--quiet)" }} />
      <span>Plan a meeting</span>
    </button>
  );
}

/** The last sync attempt, humanized: "Imported 3 · updated 1 (2 min ago)" or the actual error. */
function CalendarSyncStatusLine({ stamp }: { stamp: CalendarSyncStamp | null }) {
  if (!stamp?.last_sync) return null;
  const ago = (() => {
    const s = Math.max(0, (Date.now() - new Date(stamp.last_sync).getTime()) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  })();
  if (stamp.last_error) {
    return <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", lineHeight: 1.5 }}>Last sync failed ({ago}): {stamp.last_error}</div>;
  }
  const c = stamp.counts ?? {};
  const bits = [c.created ? `imported ${c.created}` : "", c.updated ? `updated ${c.updated}` : "", c.cancelled ? `removed ${c.cancelled}` : ""].filter(Boolean);
  return (
    <div style={{ fontSize: 11.5, color: "var(--green)", lineHeight: 1.5 }}>
      ✓ Synced {ago}{bits.length ? ` — ${bits.join(", ")}` : " — no meetings with joinable links found"}
    </div>
  );
}

// ── Calendar sync — the QUICK view over the user's calendar CONNECTIONS (#1150 plural API).
//    Per-calendar auto-join + Sync now live here because they are the two things you reach for
//    mid-day; adding, renaming, replacing a feed and disconnecting live in Settings → Calendar
//    (one manager, not two — the design-spec's "same list twice" anti-pattern). The feed address
//    is write-only: it is typed once here for the FIRST calendar and never rendered back.
//    The capture section keeps one discoverable row: it says "Connect your calendar" until a feed
//    exists, then becomes "Manage calendars" so the access point remains visible. ──
function CalendarSyncButton({ variant = "icon" }: { variant?: "icon" | "row" }) {
  const layout = useService(LayoutServiceId);
  const [open, setOpen] = useState(false);
  const [cals, setCals] = useState<CalendarConnection[] | null>(null);
  const [stamps, setStamps] = useState<Record<string, CalendarSyncStamp>>({});
  const [url, setUrl] = useState("");
  const [name, setName] = useState("My calendar");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async (withStamps: boolean) => {
    try {
      const list = await listCalendars();
      setCals(list);
      if (!withStamps) return;
      const pairs = await Promise.all(list.map(async (c) => {
        try { return [c.id, await getCalendarSyncStatus(c.id)] as const; }
        catch { return [c.id, {} as CalendarSyncStamp] as const; }
      }));
      setStamps(Object.fromEntries(pairs));
    } catch { setCals(null); }
  }, []);

  const syncOne = async (id: string) => {
    setSyncing(id); setErr(null);
    try { const st = await syncCalendar(id); setStamps((s) => ({ ...s, [id]: st })); refreshMeetings(); }
    catch (e) { setErr(presentError(e).headline); }
    finally { setSyncing(null); }
  };

  // The row label switches between connect and manage after the initial connection check.
  useEffect(() => {
    if (variant !== "row") return;
    void load(false);
  }, [variant, load]);
  useEffect(() => {
    if (!open) return;
    void load(true);
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, load]);

  const setAutoJoin = async (cal: CalendarConnection, autoJoin: boolean) => {
    setBusy(true); setErr(null);
    try {
      await updateCalendar(cal.id, { auto_join: autoJoin });
      await load(false);
      await syncOne(cal.id);   // PATCH does not reconcile already-imported meetings; the sync does
    }
    catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const connectFirst = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true); setErr(null);
    try {
      const created = await createCalendar({ name: name.trim() || "My calendar", ics_url: u, auto_join: true });
      setUrl(""); refreshMeetings();
      await load(false);
      await syncOne(created.id);            // paste → an ANSWER, not a silent wait
    }
    catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const connected = (cals?.length ?? 0) > 0;
  const openSettings = () => { setOpen(false); layout.openSettings(); };

  return (
    <div ref={ref} style={{ position: "relative", flex: variant === "row" ? "initial" : "none" }}>
      {variant === "row" ? (
        <button onClick={() => setOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            height: 31,
            textAlign: "left",
            background: "transparent",
            border: "none",
            color: "var(--t2)",
            borderRadius: 5,
            padding: "0 8px",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            transition: "background .12s, color .12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--panel2)";
            e.currentTarget.style.color = "var(--t1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--t2)";
          }}>
          <Icon name="cal" size={15} style={{ color: "var(--quiet)" }} />
          <span>{connected ? "Manage calendars" : "Connect your calendar"}</span>
        </button>
      ) : (
        <button onClick={() => setOpen((v) => !v)} title="Calendars — import upcoming meetings from your calendars"
          style={{ display: "inline-flex", alignItems: "center", background: "transparent", border: "none", color: connected ? "var(--accent)" : "var(--t3)", cursor: "pointer", padding: 2 }}>
          <Icon name="cal" size={13} />
        </button>
      )}
      {open && (
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 6, width: 300, background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,.32)", padding: 12, zIndex: 50, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em" }}>
            {connected ? `calendars · ${cals?.length ?? 0} of ${MAX_CALENDARS}` : "calendar sync"}
          </div>
          {connected ? (
            <>
              {cals?.map((c) => (
                <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 5, borderBottom: "1px solid var(--line)", paddingBottom: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ flex: 1, fontSize: 12, color: c.enabled ? "var(--t1)" : "var(--t3)", fontWeight: 600 }}>{c.name}</span>
                    {!c.enabled && <span style={{ fontSize: 10.5, color: "var(--t3)" }}>paused</span>}
                    <button disabled={busy || syncing !== null} onClick={() => void syncOne(c.id)}
                      style={{ fontSize: 11.5, padding: "3px 8px", background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--t1)", borderRadius: 6, cursor: "pointer" }}>
                      {syncing === c.id ? "Syncing…" : "Sync"}
                    </button>
                  </div>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "var(--t2)", cursor: "pointer", userSelect: "none" }}>
                    <input type="checkbox" checked={c.auto_join} disabled={busy || syncing !== null}
                      onChange={(e) => void setAutoJoin(c, e.target.checked)} />
                    Auto-join meetings from this calendar
                  </label>
                  <CalendarSyncStatusLine stamp={stamps[c.id] ?? null} />
                </div>
              ))}
              <button onClick={openSettings} aria-label="Add, rename or disconnect calendars" title="Add, rename or disconnect calendars"
                style={{ fontSize: 11.5, padding: "4px 10px", background: "transparent", border: "1px solid var(--line2)", color: "var(--t2)", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }}>
                Calendar settings
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5 }}>
                Paste your calendar&apos;s <b>secret ICS address</b> (Google Calendar → Settings → &quot;Secret address in iCal format&quot;).
                Upcoming meetings with a Meet/Zoom/Teams link appear under Upcoming and auto-join at start.
              </div>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={100}
                aria-label="Calendar name" placeholder="Calendar name"
                style={{ fontSize: 11.5, padding: "5px 7px", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--t1)", outline: "none" }} />
              <input value={url} placeholder="https://calendar.google.com/…/basic.ics" disabled={busy}
                type="password" autoComplete="off" aria-label="Secret ICS address"
                onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void connectFirst(); }}
                style={{ fontSize: 11.5, padding: "5px 7px", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--t1)", outline: "none" }} />
              <button disabled={busy || !url.trim()} onClick={() => void connectFirst()}
                style={{ fontSize: 12, padding: "5px 10px", background: url.trim() ? "var(--accent)" : "var(--panel2)", color: url.trim() ? "var(--bg)" : "var(--t3)", border: "none", borderRadius: 6, cursor: url.trim() ? "pointer" : "default" }}>
                {busy || syncing !== null ? "Connecting…" : "Connect"}
              </button>
              <div style={{ fontSize: 10.5, color: "var(--t3)", lineHeight: 1.45 }}>
                Tip: the <i>public</i> address only carries events you made public; use the <b>secret</b> one for your full calendar.
              </div>
            </>
          )}
          {err && <div role="alert" style={{ fontSize: 11, color: "var(--danger)" }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

// ── Meetings section's destination link and live auto-open behavior. ──────────────
function MeetingsList() {
  const layout = useService(LayoutServiceId);
  const all = useLiveMeetings();
  const autoOpened = useRef(false);
  useEffect(() => {
    const firstLive = all.find((m) => m.status === "live");
    if (!autoOpened.current && firstLive) {
      autoOpened.current = true;
      layout.openTab(meetingTab(firstLive));
    }
  }, [all, layout]);
  return (
      <button onClick={() => layout.openTab({ id: "today", title: "Today", kind: "today", params: {} })}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "calc(100% - 38px)", margin: "15px 19px 0", textAlign: "left", background: "transparent", border: "none", borderTop: "1px solid var(--line)", padding: "10px 0", fontSize: 12, color: "var(--t2)", lineHeight: 1.5, cursor: "pointer" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent)")} onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t2)")}>
        <span>{all.length === 0 ? "No meetings yet — open Today" : "Your meetings are in Today"}</span>
        <span aria-hidden="true" style={{ color: "var(--t3)", font: "10px var(--mono)" }}>↗</span>
      </button>
  );
}

// ── Meeting COPILOT tab (center) — meeting shell + canvas ──────────────────────────
type ModelInfo = { chat_model?: string; streaming_model?: string; agent_model?: string; meeting_model?: string; chatgpt_connected?: boolean | null; asr_label?: string };

function useModelInfo(): ModelInfo | null {
  const [models, setModels] = useState<ModelInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [r, asr] = await Promise.all([fetch(`/api/models`, { cache: "no-store" }), fetch('/api/user/transcription', { cache: 'no-store' }).catch(() => null)]);
        if (!alive || !r.ok) return;
        const value = await r.json() as ModelInfo;
        const selected = asr?.ok ? await asr.json().catch(() => null) : null;
        value.asr_label = selected?.effective?.label || 'Unavailable';
        setModels(value);
      } catch {
        /* model labels are informational */
      }
    };
    void refresh();
    window.addEventListener('tina-models-changed', refresh);
    return () => { alive = false; window.removeEventListener('tina-models-changed', refresh); };
  }, []);
  return models;
}

export function ModelChips() {
  const models = useModelInfo();
  const streaming = models?.streaming_model || models?.meeting_model || "streaming";
  const chat = models?.chat_model || models?.agent_model || "chat";
  const chip = (label: string, value: string) => (
    <span title={`${label} configured model: ${value}. Configuration is not proof of successful inference.${label === 'ASR' ? ' Applies to the next capture session.' : ''}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 7, color: "var(--t2)", background: "var(--panel)", fontSize: 11.5, whiteSpace: "nowrap", minWidth: 0 }}>
      <span style={{ color: "var(--t3)", fontFamily: "var(--mono)", flex: "none" }}>{label}</span>
      <span style={{ color: "var(--t1)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{value}</span>
    </span>
  );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", justifyContent: "flex-end", minWidth: 0 }}>
      {chip("Meeting AI", streaming)}
      {chip("chat", chat)}
      {chip("ASR", models?.asr_label || 'Loading…')}
      {models?.chatgpt_connected === false && <span role="status" style={{ color: 'var(--danger)', fontSize: 11.5 }}>Connect ChatGPT in Settings</span>}
    </div>
  );
}

/** Bot lifecycle controls on the meeting page header (owner ask 2026-07-09): Stop while the bot
 *  is in the call, Re-send once it stopped/completed/failed. Reuses the row-action map verbatim
 *  (same endpoints, same status vocabulary) — only bot actions surface here; row management
 *  (schedule/cancel/delete) stays in the sidebar menu. */
export function BotControls({
  m,
  connected = true,
  onOpenMeeting,
}: {
  m: MeetingMock;
  connected?: boolean;
  onOpenMeeting?: (meetingId: string) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acts = actionsFor(m).filter((a) => a.id === "stop" || a.id === "resend" || a.id === "send");
  const retryMessage = autoRetryMessage(m);
  if (acts.length === 0 && !retryMessage) return null;
  // The control's enabled-ness is a pure function of (row status, WS-connected): while the live
  // `meeting.status` stream is down the row may be a stale snapshot, so a state-bearing control
  // degrades to indeterminate/disabled — never an actionable "Stop bot" for a meeting the backend
  // may no longer have (issue #674).
  const disabled = busy || !connected;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
      {m.live_status === "failed" && m.join_failure_summary && <span role="status" style={{ fontSize: 11, color: "var(--danger)", maxWidth: 280, lineHeight: 1.4 }}>{m.join_failure_summary}</span>}
      {retryMessage && <span role="status" style={{ fontSize: 11, color: "var(--accent)" }}>{retryMessage}</span>}
      {acts.map((a) => {
        const danger = a.tone === "live";
        return (
          <button key={a.id} disabled={disabled}
            title={!connected ? "Live connection lost — reconnecting…" : undefined}
            onClick={() => {
              if (disabled) return;
              setErr(null); setBusy(true);
              void Promise.resolve(
                a.run(
                  (f) => setErr(f.message),
                  (res) => {
                    if ((a.id === "resend" || a.id === "send") && res.meetingId && res.meetingId !== m.id) {
                      onOpenMeeting?.(res.meetingId);
                    }
                  },
                ),
              ).finally(() => setBusy(false));
            }}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent",
              border: `1px solid ${danger ? "var(--danger)" : "var(--line2)"}`,
              color: danger ? "var(--danger)" : "var(--accent)",
              borderRadius: 7, padding: "4px 11px", fontSize: 12, fontWeight: 600,
              cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}>
            {a.id === "stop" ? (m.auto_retry?.state === "scheduled" ? "Cancel retry" : "Stop bot") : "Send bot again"}
          </button>
        );
      })}
      {err && <span role="alert" style={{ fontSize: 11, color: "var(--danger)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={err}>{err}</span>}
    </span>
  );
}

/** Header state as a pure function of (row, WS-connected) — the badge and the bot controls both
 *  derive from it, so a stale-live snapshot can never present as Live while the authoritative
 *  `meeting.status` stream is down (issue #674). Exported for the behavioral test. */
export function meetingHeaderState(m: MeetingMock | undefined, connected: boolean): "live" | "pending" | "reconnecting" | "recap" | "connecting" {
  if (!m) return "connecting";
  if (m.status !== "live") return "recap";
  if (!connected) return "reconnecting";
  return !m.live_status || m.live_status === "active" ? "live" : "pending";
}

function meetingDurationLabel(m?: MeetingMock): string | undefined {
  if (!m?.start_time || !m.end_time) return undefined;
  const start = Date.parse(m.start_time), end = Date.parse(m.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? (rest ? `${hours}h ${rest}m` : `${hours}h`) : `${minutes}m`;
}

/** The recap must not repeat a cached live-only placeholder after the run ends. */
export function meetingWhenLabel(m: MeetingMock): string {
  if (meetingPhase(m) !== "post" || !/^(?:Bot session in progress|Now\s*·\s*live|now)$/i.test(m.when.trim())) return m.when;
  const started = Date.parse(m.start_time ?? "");
  return Number.isFinite(started)
    ? new Date(started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
}

/** Whether a requested meeting id has RESOLVED, is still resolving, or does not exist for this user.
 *  `listLoaded` is the meetings list having answered at least once — without it an id that simply hasn't
 *  been fetched yet is indistinguishable from one that doesn't exist, and an addressable URL
 *  (`/meetings/<id>`) would show a permanent "Connecting…" for a deleted or foreign meeting.
 *  Exported for the routing test. */
export type MeetingResolution = "resolving" | "resolved" | "not-found";
export function meetingResolution(m: MeetingMock | undefined, listLoaded: boolean): MeetingResolution {
  if (m) return "resolved";
  return listLoaded ? "not-found" : "resolving";
}

/** The clean terminal state for an id that isn't ours (deleted, mistyped, someone else's un-shared
 *  meeting). A dead reference is a normal outcome of a shareable URL, so it reads as an answer — not an
 *  error, not a spinner that never ends. Pure (no services) so it renders in a test as-is. */
export function MeetingNotFound({ meetingId, onOpenToday }: { meetingId: string; onOpenToday?: () => void }) {
  return (
    <div role="status" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 380, textAlign: "center" }}>
        <div style={{ fontSize: 15, color: "var(--t1)", fontWeight: 550, marginBottom: 6 }}>Meeting not found</div>
        <div style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.55 }}>
          {meetingId
            ? <>Nothing here matches <span style={{ fontFamily: "var(--mono)", color: "var(--t2)" }}>{meetingId}</span>. It may have been deleted, or it belongs to someone who hasn&apos;t shared it with you.</>
            : <>This link doesn&apos;t carry a meeting. Open one from your day.</>}
        </div>
        {onOpenToday && (
          <button onClick={onOpenToday}
            style={{ marginTop: 16, fontSize: 12.5, padding: "5px 12px", background: "transparent", border: "1px solid var(--line2)", color: "var(--t2)", borderRadius: 7, cursor: "pointer" }}>
            Open today
          </button>
        )}
      </div>
    </div>
  );
}

function MeetingTab({ id, params }: TabProps) {
  const layout = useService(LayoutServiceId);
  const liveList = useLiveMeetings();
  const listLoaded = useLiveMeetingsLoaded();
  const connected = useLiveMeetingsConnection();
  const requestedMeetingId = params.meetingId as string;
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [deletingMeeting, setDeletingMeeting] = useState(false);
  const knowledgeRouteMeeting = useRef(requestedMeetingId);
  const consumedAskTinaLink = useRef(false);
  useEffect(() => {
    if (knowledgeRouteMeeting.current !== requestedMeetingId) {
      knowledgeRouteMeeting.current = requestedMeetingId;
      setKnowledgeOpen(false);
    }
    if (consumedAskTinaLink.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("askTina") !== "1" || meetingIdFromPath(url.pathname) !== requestedMeetingId) return;
    consumedAskTinaLink.current = true;
    setKnowledgeOpen(true);
    url.searchParams.delete("askTina");
    try { window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash); }
    catch { /* the Ask TINA pane is already open; a sandboxed URL may retain its one-shot flag */ }
  }, [requestedMeetingId]);
  // ONE resolver, shared with the canvas body (useMeeting.resolveMeeting): the real meetings list is the
  // only source of truth — a mock never shadows a real id, and a real id never falls back to a mock. While
  // the async list is still loading the row is simply not-yet-resolved; we render the canvas bound to the
  // id with a neutral header (never a wrong/mock meeting), so the header can't disagree with the body.
  const m = liveList.find((x) => x.id === requestedMeetingId || x.native_id === requestedMeetingId);
  const header = meetingHeaderState(m, connected);
  const ended = !!m && meetingPhase(m) === "post";
  const durationLabel = meetingDurationLabel(m);
  const whenLabel = m ? meetingWhenLabel(m) : "";
  const liveAssistMeetingId = m && meetingPhase(m) === "live" ? String(m.id) : "";
  const [liveAssistState, setLiveAssistState] = useState<LiveMeetingStateSnapshot | null>(null);
  const [transcriptViewMeetingId, setTranscriptViewMeetingId] = useState("");
  const liveAssistEnabled = !!(liveAssistMeetingId && liveAssistState?.enabled);
  const showingLiveAssist = liveAssistEnabled && transcriptViewMeetingId !== liveAssistMeetingId;
  const liveAssistStateRef = useRef<LiveMeetingStateSnapshot | null>(null);
  const [liveAssistError, setLiveAssistError] = useState("");
  const [liveAssistBusy, setLiveAssistBusyState] = useState(false);
  const liveAssistBusyRef = useRef(false);
  const liveAssistRequestSerial = useRef(0);
  const [liveAssistSyncedAt, setLiveAssistSyncedAt] = useState<number | null>(null);
  const [liveAssistDraft, setLiveAssistDraft] = useState<PlannedLiveAssistDraft>({ ...EMPTY_LIVE_ASSIST_DRAFT, agendaItems: [], agendaEdits: [] });
  const publishLiveAssistState = useCallback((next: LiveMeetingStateSnapshot, mergeHistory = true, refreshed = true) => {
    const published = mergeHistory ? mergeLiveMeetingState(liveAssistStateRef.current, next) : next;
    liveAssistStateRef.current = published;
    setLiveAssistState(published);
    if (refreshed) setLiveAssistSyncedAt(Date.now());
  }, []);

  useEffect(() => {
    liveAssistStateRef.current = null;
    setLiveAssistState(null);
    setLiveAssistError("");
    setLiveAssistSyncedAt(null);
    if (!liveAssistMeetingId) {
      setLiveAssistDraft({ ...EMPTY_LIVE_ASSIST_DRAFT, agendaItems: [], agendaEdits: [] });
      return;
    }
    setLiveAssistDraft(readPlannedLiveAssistDraft(liveAssistMeetingId));
    const controller = new AbortController();
    const refresh = async () => {
      if (liveAssistBusyRef.current) return;
      const ticket = ++liveAssistRequestSerial.current;
      try {
        const previous = liveAssistStateRef.current;
        let next = previous
          ? await readLiveMeetingState(liveAssistMeetingId, controller.signal)
          : await readAllLiveMeetingState(liveAssistMeetingId, controller.signal);
        let reloadHistory = !previous;
        if (previous && next.configured
            && (!previous.configured || previous.archive_count !== next.archive_count || (!previous.source_notice && !!next.source_notice))) {
          next = await readAllLiveMeetingState(liveAssistMeetingId, controller.signal);
          reloadHistory = true;
        }
        if (!controller.signal.aborted && ticket === liveAssistRequestSerial.current) {
          publishLiveAssistState(next, !reloadHistory);
          setLiveAssistError("");
        }
      } catch (reason) {
        if (!controller.signal.aborted && ticket === liveAssistRequestSerial.current) setLiveAssistError(reason instanceof Error ? reason.message : "Could not load Live Assist state");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); window.clearInterval(timer); liveAssistRequestSerial.current++; };
  }, [liveAssistMeetingId, publishLiveAssistState]);

  const setLiveAssistBusy = (value: boolean) => {
    liveAssistBusyRef.current = value;
    setLiveAssistBusyState(value);
  };
  const canDeleteMeeting = !!m && m.status === "past" && !!m.native_id && !m.shared
    && ["completed", "failed", "stopped"].includes(m.live_status ?? "");
  const deleteMeeting = async (): Promise<string | null> => {
    if (!m || !canDeleteMeeting || deletingMeeting) return "This meeting is not available to delete.";
    setDeletingMeeting(true);
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      if (!response.ok) throw await readFailure(response);
      refreshMeetings();
      layout.closeTab(id);
      layout.openTab({ id: "today", title: "Today", kind: "today", params: {} });
      return null;
    } catch (error) {
      return presentMeetingActionFailure(error);
    } finally {
      setDeletingMeeting(false);
    }
  };

  const syncLiveAssistDraft = async (meetingId: string, initial: LiveMeetingStateSnapshot) => {
    let current = initial;
    let pending = readPlannedLiveAssistDraft(meetingId);
    setLiveAssistDraft(pending);
    const commit = async (action: string, payload: unknown) => {
      liveAssistRequestSerial.current++;
      current = await postLiveMeetingStateAction(meetingId, action, payload);
      publishLiveAssistState(current, true, false);
    };
    if (pending.goal !== null) {
      const goal = pending.goal;
      await commit("edit", { id: "goal", expected_revision: current.goal?.revision || 0, patch: { text: goal } });
      pending = { ...pending, goal: null };
      writePlannedLiveAssistDraft(meetingId, pending);
      setLiveAssistDraft(pending);
    }
    for (const item of [...pending.agendaItems]) {
      await commit("add", { type: "agenda", text: item.text, details: {} });
      pending = { ...pending, agendaItems: pending.agendaItems.filter((candidate) => candidate.id !== item.id) };
      writePlannedLiveAssistDraft(meetingId, pending);
      setLiveAssistDraft(pending);
    }
    for (const item of [...pending.agendaEdits]) {
      const revision = current.items?.find((candidate) => candidate.id === item.id)?.revision ?? item.revision;
      await commit("edit", { id: item.id, expected_revision: revision, patch: { text: item.text } });
      pending = { ...pending, agendaEdits: pending.agendaEdits.filter((candidate) => candidate.id !== item.id) };
      writePlannedLiveAssistDraft(meetingId, pending);
      setLiveAssistDraft(pending);
    }
  };

  const enableLiveAssist = async () => {
    const meetingId = liveAssistMeetingId;
    const current = liveAssistStateRef.current;
    if (!meetingId || !current?.can_configure || current.enabled || liveAssistBusyRef.current) return;
    setLiveAssistBusy(true);
    setLiveAssistError("");
    try {
      liveAssistRequestSerial.current++;
      const enabled = await postLiveMeetingStateAction(meetingId, "configure", {
        enabled: true,
        ...(!current.configured ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
      });
      setTranscriptViewMeetingId("");
      publishLiveAssistState(enabled, true, false);
      await syncLiveAssistDraft(meetingId, enabled);
    } catch (reason) {
      setLiveAssistError(reason instanceof Error ? reason.message : "Could not enable Live Assist");
    } finally {
      setLiveAssistBusy(false);
    }
  };

  const retryLiveAssistDraft = async () => {
    const meetingId = liveAssistMeetingId;
    const current = liveAssistStateRef.current;
    if (!meetingId || !current?.configured || liveAssistBusyRef.current) return;
    setLiveAssistBusy(true);
    setLiveAssistError("");
    try { await syncLiveAssistDraft(meetingId, current); }
    catch (reason) { setLiveAssistError(reason instanceof Error ? reason.message : "Could not sync planned Live Assist edits"); }
    finally { setLiveAssistBusy(false); }
  };

  const liveAssistAction = async (action: string, payload: unknown) => {
    const meetingId = liveAssistMeetingId;
    if (!meetingId || liveAssistBusyRef.current) return false;
    setLiveAssistBusy(true);
    setLiveAssistError("");
    try {
      liveAssistRequestSerial.current++;
      publishLiveAssistState(await postLiveMeetingStateAction(meetingId, action, payload), true, false);
      const request = payload && typeof payload === "object" ? payload as { id?: string; type?: string; text?: string; patch?: { text?: string } } : {};
      if (action === "edit" && request.id && (payload as { patch?: { status?: string } }).patch?.status === "withdrawn" && liveAssistStateRef.current) {
        const next = { ...liveAssistStateRef.current, items: (liveAssistStateRef.current.items || []).filter((item) => item.id !== request.id) };
        liveAssistStateRef.current = next;
        setLiveAssistState(next);
      }
      let pending = readPlannedLiveAssistDraft(meetingId);
      if (action === "edit" && request.id === "goal" && typeof request.patch?.text === "string") {
        pending = { ...pending, goal: null };
      } else if (action === "edit" && request.id && typeof request.patch?.text === "string") {
        pending = { ...pending, agendaEdits: pending.agendaEdits.filter((item) => item.id !== request.id) };
      } else if (action === "add" && request.type === "agenda" && typeof request.text === "string") {
        const index = pending.agendaItems.findIndex((item) => item.text === request.text);
        if (index >= 0) pending = { ...pending, agendaItems: pending.agendaItems.filter((_, itemIndex) => itemIndex !== index) };
      }
      writePlannedLiveAssistDraft(meetingId, pending);
      setLiveAssistDraft(pending);
      return true;
    } catch (reason) {
      setLiveAssistError(reason instanceof Error ? reason.message : "Could not save Live Assist state");
      const request = payload && typeof payload === "object" ? payload as { id?: string; type?: string; text?: string; patch?: { text?: string } } : {};
      let pending = readPlannedLiveAssistDraft(meetingId);
      let retained = false;
      if (action === "edit" && request.id === "goal" && typeof request.patch?.text === "string") {
        pending = { ...pending, goal: request.patch.text };
        retained = true;
      } else if (action === "edit" && request.id && typeof request.patch?.text === "string") {
        const revision = liveAssistStateRef.current?.items?.find((item) => item.id === request.id)?.revision ?? 0;
        pending = { ...pending, agendaEdits: [...pending.agendaEdits.filter((item) => item.id !== request.id), { id: request.id, text: request.patch.text, revision }] };
        retained = true;
      } else if (action === "add" && request.type === "agenda" && typeof request.text === "string") {
        const draftId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `draft-${Date.now()}`;
        pending = { ...pending, agendaItems: [...pending.agendaItems, { id: draftId, text: request.text }] };
        retained = true;
      }
      if (retained) {
        writePlannedLiveAssistDraft(meetingId, pending);
        setLiveAssistDraft(pending);
      }
      return retained;
    }
    finally { setLiveAssistBusy(false); }
  };

  // An unknown id — a stale/foreign/mistyped meeting URL — is a clean dead end, never a crash and never
  // an endless "Connecting…". Only once the list has actually answered (P0: an offline list keeps
  // resolving, so a network blip can't make a live meeting look deleted).
  if (meetingResolution(m, listLoaded) === "not-found") {
    return (
      <MeetingNotFound
        meetingId={requestedMeetingId}
        onOpenToday={() => layout.openTab({ id: "today", title: "Today", kind: "today", params: {} })}
      />
    );
  }

  return (
    <div className={pageStyles.page} data-phase={ended ? "recap" : undefined}>
      <header className={pageStyles.header}>
        <div className={pageStyles.identity}>
          <button type="button" aria-label="Back to previous view" title="Back" onClick={() => { if (!layout.goBack()) layout.openTab({ id: "today", title: "Today", kind: "today", params: {} }); }}
            style={{ width: 30, height: 30, flex: "none", border: "1px solid var(--line)", borderRadius: 7, background: "transparent", color: "var(--t2)", fontSize: 19, lineHeight: 1, cursor: "pointer" }}>‹</button>
          {header === "live" || header === "pending"
            ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: badgeFor(m?.live_status || "active").color, fontWeight: 600, fontSize: "var(--ui-type-meta)", flex: "none" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: badgeFor(m?.live_status || "active").color }} />{badgeFor(m?.live_status || "active").label}</span>
            : header === "reconnecting"
              ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent)", fontWeight: 600, fontSize: "var(--ui-type-meta)", flex: "none" }} title="Live connection lost — the last known state may be stale"><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 3px var(--accentbg)" }} />Reconnecting…</span>
              : header === "recap"
                ? <span className={pageStyles.phase}>Recap</span>
                : <span style={{ fontSize: "var(--ui-type-meta)", color: "var(--t3)", fontWeight: 600, flex: "none" }}>Connecting…</span>}
          <h1 className={pageStyles.title}>
            {m ? (m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "")) : "Meeting"}
          </h1>
        </div>
          <div className={pageStyles.actions}>
            {liveAssistMeetingId && liveAssistState?.can_configure && !liveAssistState.enabled && <button type="button" disabled={liveAssistBusy} onClick={() => void enableLiveAssist()}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 30, padding: "0 12px", border: "1px solid var(--accent)", borderRadius: 7, background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, fontWeight: 700, cursor: liveAssistBusy ? "wait" : "pointer", opacity: liveAssistBusy ? 0.7 : 1 }}>
              {liveAssistBusy ? "Enabling…" : "Enable live assist"}
            </button>}
            {liveAssistEnabled && <button type="button" className={pageStyles.viewSwitch}
              onClick={() => setTranscriptViewMeetingId(showingLiveAssist ? liveAssistMeetingId : "")}>
              {showingLiveAssist ? <><List size={16} aria-hidden="true" />Transcript</> : <><FileText size={16} aria-hidden="true" />Live Assist</>}
            </button>}
            {m && !meetingsOnly() && <button type="button" aria-expanded={knowledgeOpen} aria-controls={`meeting-knowledge-${m.id}`} onClick={() => setKnowledgeOpen((open) => !open)}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 var(--space-3)", border: "1px solid var(--line2)", borderRadius: 7, background: "transparent", color: "var(--accent)", fontSize: "var(--ui-type-meta)", fontWeight: 600, cursor: "pointer" }}>
              {knowledgeOpen ? "Close TINA" : "Ask TINA"}
            </button>}
            {m && (
              <BotControls
                m={m}
                connected={connected}
                onOpenMeeting={(newId) => {
                  const next = getLiveMeeting(newId);
                  layout.openTab(
                    next
                      ? meetingTab(next)
                      : {
                          id: `meeting:${newId}`,
                          title: (m.title_custom ?? (m.native_id ?? m.title)).replace(/^Google Meet · /, ""),
                          kind: "meeting",
                          params: { meetingId: newId },
                        },
                  );
                }}
              />
            )}
            {m?.id && !m.shared && <ShareSessionButton key={m.id} meetingId={m.id} />}
          </div>
        {liveAssistError && !liveAssistState?.enabled && <div role="alert" style={{ margin: "0 0 8px", color: "var(--danger)", fontSize: 11.5 }}>{liveAssistError}</div>}
        {m && <div className={pageStyles.metadata}>
          <span>{m.platform}</span>
          {ended && <span className={pageStyles.ended} data-failed={m.live_status === "failed"} role="status">{m.live_status === "failed" ? "Bot session failed" : "Meeting ended"}</span>}
          {whenLabel && <span>{whenLabel}</span>}
          {durationLabel && <span>{durationLabel}</span>}
          {!!m.participants.length && <span>{m.participants.length} participants</span>}
          {!ended && m.has_recording && <span style={{ color: "var(--green)" }}>Recording available</span>}
        </div>}
      </header>
      {m && !meetingsOnly() && <div id={`meeting-knowledge-${m.id}`} style={{ display: knowledgeOpen ? "block" : "none", flex: "none", padding: `0 ${MEETING_CANVAS_CONTENT_INSET}px 8px` }}>
          <MeetingKnowledge key={`knowledge-${m.id}`} meetingId={String(m.id)} />
      </div>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <div className={pageStyles.view} hidden={showingLiveAssist}>
          <MeetingCanvasView key={requestedMeetingId} meetingId={requestedMeetingId} meetingRecord={m} onDeleteMeeting={canDeleteMeeting ? deleteMeeting : undefined} deletingMeeting={deletingMeeting} />
        </div>
        {liveAssistMeetingId && liveAssistState?.enabled && <div className={pageStyles.view} hidden={!showingLiveAssist}>
          <LiveAssistRunningView
              key={liveAssistMeetingId}
              meetingId={liveAssistMeetingId}
              meetingTitle={m?.title_custom ?? (m?.native_id ?? m?.title ?? "Meeting").replace(/^Google Meet · /, "")}
              state={liveAssistState}
              busy={liveAssistBusy}
              error={liveAssistError}
              syncedAt={liveAssistSyncedAt}
              pendingDraft={liveAssistDraft}
              onAction={liveAssistAction}
              onRetryDraft={() => void retryLiveAssistDraft()}
          />
        </div>}
      </div>
    </div>
  );
}

registerList({ id: "meetings", label: "Meetings", icon: "cal", order: 20, component: MeetingsList,
  // clicking Meetings opens the user's DAY in the center (design-spec meeting-lifecycle-v2, W2)
  centerTab: { id: "today", title: "Today", kind: "today", params: {} } });
registerTab("meeting", MeetingTab);
registerCommand({ id: "meeting.openLive", title: "Open live meeting", run: ({ container }) => { const m = liveMeetingsNow()[0]; if (m) container.get(LayoutServiceId).openTab(meetingTab(m)); } });
