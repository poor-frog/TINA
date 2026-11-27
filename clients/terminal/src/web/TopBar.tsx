"use client";
/** WebTopBar — Global Production User UI header with Cmd+K search, live-meeting pill,
 *  and Split-Button `Capture ▾` (Join live now | Plan / Schedule | Connect Calendar). */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import { LucianCommandKButton } from "./lucian/LucianCommandKButton";
import { LucianThemeToggle } from "./lucian/LucianThemeToggle";
import { LucianDynamicIsland } from "./lucian/LucianDynamicIsland";
import { emitWebToast } from "./lucian/webToast";
import { parseMeetingInput, meetingUrlFor } from "../surfaces/meetingId";
import { getJitsiHosts } from "../surfaces/jitsiHosts";
import { defaultBotName } from "../surfaces/defaultBotName";
import { readApiFailure } from "../surfaces/apiClient";
import { presentMeetingActionFailure } from "../surfaces/meeting";
import { refreshMeetings, seedLiveMeetingFromResponse } from "../surfaces/liveMeetings";
import { createPlannedMeeting } from "../surfaces/plannedApi";
import type { MeetingMock } from "../surfaces/meetingModel";

export type CaptureModalMode = "live" | "schedule";

export function WebTopBar({
  title,
  liveMeeting,
  liveMeetings,
  wsConnected,
  meetingsOnly = false,
  hideBar = false,
  onOpenMobileNav,
  onOpenSearch,
  onOpenMeeting,
  onOpenCalendarSettings,
  captureOpen,
  captureMode = "live",
  onOpenCapture,
  onCloseCapture,
}: {
  title: string;
  liveMeeting?: MeetingMock;
  liveMeetings?: MeetingMock[];
  wsConnected: boolean;
  meetingsOnly?: boolean;
  hideBar?: boolean;
  onOpenMobileNav: () => void;
  onOpenSearch: () => void;
  onOpenMeeting: (meetingId: string, opts?: { startBrief?: boolean }) => void;
  onOpenCalendarSettings: () => void;
  captureOpen: boolean;
  captureMode?: CaptureModalMode;
  onOpenCapture: (mode?: CaptureModalMode) => void;
  onCloseCapture: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (splitRef.current && !splitRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <>
      {!hideBar && <header className="tina-web-topbar">
        <div className="tina-web-topbar-left">
          <button
            type="button"
            className="tina-web-mobile-menu"
            aria-label="Open navigation"
            onClick={onOpenMobileNav}
          >
            <WebIcon name="menu" size={18} />
          </button>
          <span>{title}</span>
          {!wsConnected && (
            <span style={{ fontSize: 11.5, color: "var(--tw-text-4)" }} title="Live meeting updates reconnecting">
              · syncing…
            </span>
          )}
        </div>

        <div className="tina-web-search-wrap">
          <LucianCommandKButton onTrigger={onOpenSearch} />
        </div>

        <div className="tina-web-topbar-right">
          <LucianDynamicIsland
            liveMeetings={liveMeetings && liveMeetings.length > 0 ? liveMeetings : liveMeeting ? [liveMeeting] : []}
            onOpenMeeting={onOpenMeeting}
          />
          <LucianThemeToggle />
          <div className="tina-web-capture-split" ref={splitRef}>
            <button
              type="button"
              className="tina-web-capture-main"
              onClick={() => {
                setMenuOpen(false);
                onOpenCapture("live");
              }}
            >
              <WebIcon name="capture" size={15} />
              <span>Capture</span>
            </button>
            <button
              type="button"
              className="tina-web-capture-caret"
              aria-label="More capture options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <WebIcon name="chevronDown" size={14} />
            </button>

            {menuOpen && (
              <div className="tina-web-dropdown" role="menu" aria-label="Capture options">
                <button
                  type="button"
                  role="menuitem"
                  className="tina-web-dropdown-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenCapture("live");
                  }}
                >
                  <WebIcon name="broadcast" size={15} />
                  <span>
                    <strong>Join live meeting</strong>
                    <small>Send TINA bot to Google Meet, Zoom, Teams, Jitsi or Discord</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="tina-web-dropdown-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenCapture("schedule");
                  }}
                >
                  <WebIcon name="calendarCheck" size={15} />
                  <span>
                    <strong>Plan / Schedule meeting</strong>
                    <small>Add an upcoming call with auto-join &amp; meeting prep</small>
                  </span>
                </button>
                <div className="tina-web-dropdown-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="tina-web-dropdown-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenCalendarSettings();
                  }}
                >
                  <WebIcon name="calendar" size={15} />
                  <span>
                    <strong>Connect Calendar</strong>
                    <small>Auto-capture meetings from Google or ICS feeds</small>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>}

      {captureOpen && (
        <CaptureMeetingModal
          initialMode={captureMode}
          meetingsOnly={meetingsOnly}
          onClose={onCloseCapture}
          onCaptured={(meetingId, opts) => {
            onCloseCapture();
            if (meetingId) onOpenMeeting(meetingId, opts);
          }}
        />
      )}
    </>
  );
}

function CaptureMeetingModal({
  initialMode = "live",
  meetingsOnly = false,
  onClose,
  onCaptured,
}: {
  initialMode?: CaptureModalMode;
  meetingsOnly?: boolean;
  onClose: () => void;
  onCaptured: (meetingId?: string, opts?: { startBrief?: boolean }) => void;
}) {
  const [mode, setMode] = useState<CaptureModalMode>(initialMode);
  const [urlInput, setUrlInput] = useState("");
  const [titleInput, setTitleInput] = useState("");
  const [scheduledAt, setScheduledAt] = useState(() => {
    const dt = new Date(Date.now() + 3600_000);
    return new Date(dt.getTime() - dt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [autoJoin, setAutoJoin] = useState(true);
  const [jitsiHosts, setJitsiHosts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    let active = true;
    void getJitsiHosts()
      .then((hosts) => {
        if (active) setJitsiHosts(hosts);
      })
      .catch(() => undefined);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      active = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const parsed = parseMeetingInput(urlInput, jitsiHosts);

  const submitLive = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed || busy) {
      setError("Paste a valid Google Meet, Zoom, Microsoft Teams, Jitsi, or Discord link/code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: parsed.platform,
          native_meeting_id: parsed.native_meeting_id,
          meeting_url: meetingUrlFor(parsed, urlInput),
          bot_name: defaultBotName(),
        }),
      });
      if (!response.ok) throw await readApiFailure(response);
      const data = (await response.json().catch(() => ({}))) as { id?: number | string; meeting_id?: number | string };
      const seededId = seedLiveMeetingFromResponse(data);
      refreshMeetings();
      const targetId = seededId ?? (data.meeting_id != null ? String(data.meeting_id) : data.id != null ? String(data.id) : undefined);
      emitWebToast("TINA bot is joining the meeting");
      onCaptured(targetId);
    } catch (err) {
      setError(presentMeetingActionFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const scheduleMeeting = async (startBrief: boolean) => {
    if ((!titleInput.trim() && !urlInput.trim()) || busy) {
      setError("Provide a meeting title or a meeting link.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const iso = scheduledAt ? new Date(scheduledAt).toISOString() : null;
      const created = await createPlannedMeeting({
        title: titleInput.trim() || null,
        meeting_url: urlInput.trim() || null,
        scheduled_at: iso,
        auto_join: autoJoin,
      });
      refreshMeetings();
      emitWebToast(startBrief ? "Meeting scheduled — starting brief" : "Meeting scheduled");
      onCaptured(created?.id != null ? String(created.id) : undefined, { startBrief });
    } catch (err) {
      setError(presentMeetingActionFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const submitSchedule = async (e: FormEvent) => {
    e.preventDefault();
    await scheduleMeeting(false);
  };

  return (
    <div className="tina-web-backdrop" role="dialog" aria-modal="true" aria-label="Capture meeting" onClick={onClose}>
      <div className="tina-web-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tina-web-modal-head">
          <h2>Capture a meeting</h2>
          <button type="button" className="tina-web-icon-btn" aria-label="Close" onClick={onClose}>
            <WebIcon name="close" size={16} />
          </button>
        </div>

        <div className="tina-web-modal-body">
          <div className="tina-web-tabs" style={{ alignSelf: "flex-start" }}>
            <button
              type="button"
              className={`tina-web-tab ${mode === "live" ? "active" : ""}`}
              onClick={() => {
                setMode("live");
                setError(null);
              }}
            >
              Join live now
            </button>
            <button
              type="button"
              className={`tina-web-tab ${mode === "schedule" ? "active" : ""}`}
              onClick={() => {
                setMode("schedule");
                setError(null);
              }}
            >
              Plan / Schedule
            </button>
          </div>

          {mode === "live" ? (
            <form onSubmit={submitLive} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <label className="tina-web-field">
                <span>Meeting link or code</span>
                <input
                  autoFocus
                  type="text"
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    setError(null);
                  }}
                  placeholder="https://meet.google.com/abc-defg-hij or Zoom / Teams / Jitsi link"
                />
              </label>

              {urlInput.trim() && (
                <div style={{ fontSize: 12.5, color: parsed ? "var(--tw-mint)" : "var(--tw-text-4)" }}>
                  {parsed
                    ? `Detected ${parsed.platform.replace("_", " ")} · ${parsed.native_meeting_id}`
                    : "Waiting for a valid Google Meet, Zoom, Teams, Jitsi, or Discord link…"}
                </div>
              )}

              {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--tw-danger)" }}>{error}</div>}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button type="button" className="tina-web-btn-ghost" onClick={onClose}>Cancel</button>
                <button type="submit" className="tina-web-btn-primary" disabled={busy || !parsed}>
                  {busy ? "Sending bot…" : "Send TINA bot"}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={submitSchedule} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <label className="tina-web-field">
                <span>Meeting title</span>
                <input
                  autoFocus
                  type="text"
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  placeholder="Weekly Product Review"
                />
              </label>

              <label className="tina-web-field">
                <span>Meeting link (optional)</span>
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://meet.google.com/abc-defg-hij"
                />
              </label>

              <label className="tina-web-field">
                <span>Scheduled time</span>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tw-text-2)", cursor: "pointer" }}>
                <input type="checkbox" checked={autoJoin} onChange={(e) => setAutoJoin(e.target.checked)} />
                <span>Auto-join with TINA bot at start time</span>
              </label>

              {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--tw-danger)" }}>{error}</div>}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <button type="button" className="tina-web-btn-ghost" onClick={onClose}>Cancel</button>
                {!meetingsOnly && (
                  <button
                    type="button"
                    className="tina-web-btn-ghost"
                    disabled={busy}
                    onClick={() => void scheduleMeeting(true)}
                  >
                    <WebIcon name="sparkleSmall" size={14} />
                    <span>Save &amp; draft brief</span>
                  </button>
                )}
                <button type="submit" className="tina-web-btn-primary" disabled={busy}>
                  {busy ? "Scheduling…" : "Save meeting plan"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
