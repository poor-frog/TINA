"use client";
/** MeetingsView — Upgraded Meetings Notebook with date grouping, multi-dimensional filter popover,
 *  row rename (POST /api/meetings/{id}/annotate), and `•••` action menu (Ask TINA, Rename, Share,
 *  Copy link, Bot actions, Delete). */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { WebAvatar } from "./Avatar";
import { WebIcon } from "./Icons";
import type { CaptureModalMode } from "./TopBar";
import {
  countActiveFilters,
  EMPTY_MEETING_FILTERS,
  extractFilterFacets,
  formatShortDuration,
  groupMeetingsByDate,
  matchesMeetingFilters,
  meetingDurationMins,
  type DateRangePreset,
  type DurationPreset,
  type MeetingFilterState,
} from "./meetingsFilter";
import { meetingPhase, type MeetingMock } from "../surfaces/meetingModel";
import { actionsFor, presentMeetingActionFailure } from "../surfaces/meeting";
import { refreshMeetings } from "../surfaces/liveMeetings";
import { presentError, readApiFailure } from "../surfaces/apiClient";
import {
  listSharedMemberships,
  mintInvite,
  mintTranscriptShare,
  readAttachedWorkspaces,
  type Membership,
} from "../surfaces/workspaceApi";

type ChannelFilter = "all" | "my" | "shared" | `ws:${string}`;
type PhaseFilter = "all" | "live" | "prep" | "post";
type FilterTabId = "date" | "platform" | "participants" | "duration" | "recording";

const PAGE_SIZE = 24;

const DATE_PRESETS: Array<{ id: DateRangePreset; label: string }> = [
  { id: "any", label: "Any time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "14d", label: "Last 14 days" },
  { id: "30d", label: "Last 30 days" },
];

const DURATION_PRESETS: Array<{ id: DurationPreset; label: string }> = [
  { id: "any", label: "Any duration" },
  { id: "under15", label: "< 15 mins" },
  { id: "15to30", label: "15 – 30 mins" },
  { id: "30to60", label: "30 – 60 mins" },
  { id: "over60", label: "60+ mins" },
];

function statusClass(m: MeetingMock): string {
  const phase = meetingPhase(m);
  if (phase === "live") return "live";
  if (phase === "prep") return "scheduled";
  if (m.live_status === "failed") return "failed";
  return "completed";
}

function statusLabel(m: MeetingMock): string {
  const raw = m.live_status ?? m.status;
  if (raw === "active") return "Live";
  if (raw === "awaiting_admission") return "Waiting approval";
  if (raw === "needs_help") return "Needs help";
  if (raw === "joining" || raw === "requested") return "Joining";
  if (raw === "stopping") return "Stopping";
  if (raw === "scheduled") return "Scheduled";
  if (raw === "idle") return "Draft";
  if (raw === "failed") return "Failed";
  if (raw === "stopped") return "Stopped";
  return "Completed";
}

function canDeleteRow(m: MeetingMock): boolean {
  if (m.shared) return false;
  if (meetingPhase(m) === "prep") return true;
  return (
    m.status === "past" &&
    !!m.native_id &&
    ["completed", "failed", "stopped"].includes(m.live_status ?? "")
  );
}

export function MeetingsView({
  meetings,
  userName,
  wsConnected,
  meetingsOnly = false,
  onOpenMeeting,
  onAskMeeting,
  onOpenCapture,
}: {
  meetings: MeetingMock[];
  userName: string;
  wsConnected: boolean;
  meetingsOnly?: boolean;
  onOpenMeeting: (meetingId: string) => void;
  onAskMeeting?: (meeting: MeetingMock) => void;
  onOpenCapture: (mode?: CaptureModalMode) => void;
}) {
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>("all");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<MeetingFilterState>(EMPTY_MEETING_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTabId>("date");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [workspaces, setWorkspaces] = useState<{ id: string; label: string }[]>([]);
  const [sharedMemberships, setSharedMemberships] = useState<Membership[]>([]);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { type: "rename"; meeting: MeetingMock; title: string }
    | { type: "delete"; meeting: MeetingMock }
    | { type: "share"; meeting: MeetingMock }
    | null
  >(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const filterPopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      listSharedMemberships().catch(() => [] as Membership[]),
      readAttachedWorkspaces().catch(() => null),
    ]).then(([memberships, attached]) => {
      if (!active) return;
      setSharedMemberships(memberships);
      const map = new Map<string, string>();
      for (const m of memberships) map.set(m.workspace_id, m.workspace_id);
      if (attached?.slots) {
        for (const [slug, slot] of Object.entries(attached.slots)) {
          if (!slot.archived) map.set(slug, slot.name || slug);
        }
      }
      setWorkspaces(Array.from(map.entries()).map(([id, label]) => ({ id, label })));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (filterPopRef.current && !filterPopRef.current.contains(target)) setFiltersOpen(false);
      if (openMenuId && !target?.closest("[data-meeting-menu]")) setOpenMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFiltersOpen(false);
        setOpenMenuId(null);
        setDialog(null);
      }
    };
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenuId]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => {
      setNotice((cur) => (cur === msg ? null : cur));
    }, 3500);
  };

  const facets = useMemo(() => extractFilterFacets(meetings), [meetings]);
  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return meetings.filter((m) => {
      if (channel === "my" && m.shared) return false;
      if (channel === "shared" && !m.shared) return false;
      if (channel.startsWith("ws:") && m.workspace_id !== channel.slice(3)) return false;
      if (phaseFilter !== "all" && meetingPhase(m) !== phaseFilter) return false;
      if (!matchesMeetingFilters(m, filters)) return false;
      if (!q) return true;
      return `${m.title} ${m.title_custom ?? ""} ${m.native_id ?? ""} ${m.platform} ${m.summary ?? ""} ${m.participants.map((p) => p.name).join(" ")}`
        .toLowerCase()
        .includes(q);
    });
  }, [meetings, channel, phaseFilter, filters, query]);

  const visibleMeetings = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const groups = useMemo(() => groupMeetingsByDate(visibleMeetings), [visibleMeetings]);

  const toggleArrayFilter = (key: "platforms" | "participants", value: string) => {
    setFilters((cur) => ({
      ...cur,
      [key]: cur[key].includes(value) ? cur[key].filter((v) => v !== value) : [...cur[key], value],
    }));
    setVisibleCount(PAGE_SIZE);
  };

  const resetFilters = () => {
    setFilters(EMPTY_MEETING_FILTERS);
    setVisibleCount(PAGE_SIZE);
  };

  const runRowAction = async (m: MeetingMock, act: ReturnType<typeof actionsFor>[number]) => {
    setOpenMenuId(null);
    setBusyId(`${m.id}:${act.id}`);
    setActionErrors((prev) => {
      const next = { ...prev };
      delete next[m.id];
      return next;
    });
    try {
      await act.run((failure) => {
        setActionErrors((prev) => ({ ...prev, [m.id]: `${failure.actionLabel}: ${failure.message}` }));
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleCopyMeetingLink = async (m: MeetingMock) => {
    setOpenMenuId(null);
    const link = `${window.location.origin}/meetings/${encodeURIComponent(m.id)}`;
    try {
      await navigator.clipboard.writeText(link);
      showNotice("Meeting link copied to clipboard.");
    } catch {
      showNotice(`Link ready: ${link}`);
    }
  };

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!dialog || dialog.type !== "rename" || dialogBusy) return;
    const nextTitle = dialog.title.trim();
    if (!nextTitle) {
      setDialogError("Enter a meeting title.");
      return;
    }
    setDialogBusy(true);
    setDialogError(null);
    try {
      const res = await fetch(`/api/meetings/${encodeURIComponent(dialog.meeting.id)}/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: nextTitle }),
      });
      if (!res.ok) throw await readApiFailure(res);
      refreshMeetings();
      setDialog(null);
      showNotice(`Renamed meeting to “${nextTitle}”.`);
    } catch (err) {
      setDialogError(presentMeetingActionFailure(err));
    } finally {
      setDialogBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!dialog || dialog.type !== "delete" || dialogBusy) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      const res = await fetch(`/api/meetings/${encodeURIComponent(dialog.meeting.id)}`, { method: "DELETE" });
      if (!res.ok) throw await readApiFailure(res);
      refreshMeetings();
      setDialog(null);
      showNotice("Meeting deleted.");
    } catch (err) {
      setDialogError(presentMeetingActionFailure(err));
    } finally {
      setDialogBusy(false);
    }
  };

  return (
    <div className="tina-web-meetings-layout">
      <aside className="tina-web-channels" aria-label="Meeting channels">
        <div className="tina-web-channels-title">Channels</div>
        <button
          type="button"
          className={`tina-web-channel-btn ${channel === "all" ? "active" : ""}`}
          onClick={() => {
            setChannel("all");
            setVisibleCount(PAGE_SIZE);
          }}
        >
          <WebIcon name="video" size={14} />
          <span>All Meetings</span>
        </button>
        <button
          type="button"
          className={`tina-web-channel-btn ${channel === "my" ? "active" : ""}`}
          onClick={() => {
            setChannel("my");
            setVisibleCount(PAGE_SIZE);
          }}
        >
          <WebIcon name="layers" size={14} />
          <span>My Meetings</span>
        </button>
        <button
          type="button"
          className={`tina-web-channel-btn ${channel === "shared" ? "active" : ""}`}
          onClick={() => {
            setChannel("shared");
            setVisibleCount(PAGE_SIZE);
          }}
        >
          <WebIcon name="link" size={14} />
          <span>Shared with me</span>
        </button>

        {workspaces.length > 0 && (
          <>
            <div className="tina-web-channels-title" style={{ marginTop: 16 }}>Workspaces</div>
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                className={`tina-web-channel-btn ${channel === `ws:${ws.id}` ? "active" : ""}`}
                onClick={() => {
                  setChannel(`ws:${ws.id}`);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--tw-mint)", flex: "none" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ws.label}</span>
              </button>
            ))}
          </>
        )}
      </aside>

      <section className="tina-web-meetings-pane">
        <div className="tina-web-toolbar">
          <div className="tina-web-tabs">
            {(
              [
                { id: "all", label: "All" },
                { id: "live", label: "Live" },
                { id: "prep", label: "Upcoming" },
                { id: "post", label: "Recorded" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`tina-web-tab ${phaseFilter === item.id ? "active" : ""}`}
                onClick={() => {
                  setPhaseFilter(item.id);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          <input
            type="search"
            className="tina-web-filter-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
            placeholder="Filter by title, code, or participant…"
            aria-label="Filter meetings"
          />

          <div className="tina-web-filter-wrap" ref={filterPopRef}>
            <button
              type="button"
              className={`tina-web-btn-ghost ${filtersOpen || activeFilterCount > 0 ? "active" : ""}`}
              aria-expanded={filtersOpen}
              aria-haspopup="dialog"
              onClick={() => setFiltersOpen((v) => !v)}
            >
              <WebIcon name="filter" size={14} />
              <span>Filters</span>
              {activeFilterCount > 0 && <span className="tina-web-filter-count">{activeFilterCount}</span>}
            </button>

            {filtersOpen && (
              <div className="tina-web-filter-popover" role="dialog" aria-label="Meeting filters">
                <div className="tina-web-filter-tabs" role="tablist">
                  {(
                    [
                      { id: "date", label: "Date range" },
                      { id: "platform", label: "Platform" },
                      { id: "participants", label: "Participants" },
                      { id: "duration", label: "Duration" },
                      { id: "recording", label: "Recording" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={filterTab === t.id}
                      className={`tina-web-filter-tab ${filterTab === t.id ? "active" : ""}`}
                      onClick={() => setFilterTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="tina-web-filter-body">
                  {filterTab === "date" && (
                    <div className="tina-web-filter-pane">
                      <div className="tina-web-filter-options">
                        {DATE_PRESETS.map((preset) => (
                          <label key={preset.id} className="tina-web-filter-check">
                            <input
                              type="radio"
                              name="meeting-date-range"
                              checked={filters.dateRange === preset.id}
                              onChange={() => {
                                setFilters((cur) => ({ ...cur, dateRange: preset.id }));
                                setVisibleCount(PAGE_SIZE);
                              }}
                            />
                            <span>{preset.label}</span>
                          </label>
                        ))}
                      </div>
                      <div className="tina-web-filter-dates">
                        <label>
                          <span>From</span>
                          <input
                            type="date"
                            value={filters.dateFrom}
                            onChange={(e) => {
                              setFilters((cur) => ({ ...cur, dateFrom: e.target.value }));
                              setVisibleCount(PAGE_SIZE);
                            }}
                          />
                        </label>
                        <label>
                          <span>To</span>
                          <input
                            type="date"
                            value={filters.dateTo}
                            onChange={(e) => {
                              setFilters((cur) => ({ ...cur, dateTo: e.target.value }));
                              setVisibleCount(PAGE_SIZE);
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  {filterTab === "platform" && (
                    <div className="tina-web-filter-pane">
                      {facets.platforms.length === 0 ? (
                        <p className="tina-web-muted-note">No platforms found yet.</p>
                      ) : (
                        <div className="tina-web-filter-options">
                          {facets.platforms.map((platform) => (
                            <label key={platform} className="tina-web-filter-check">
                              <input
                                type="checkbox"
                                checked={filters.platforms.includes(platform)}
                                onChange={() => toggleArrayFilter("platforms", platform)}
                              />
                              <span>{platform}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {filterTab === "participants" && (
                    <div className="tina-web-filter-pane">
                      {facets.participants.length === 0 ? (
                        <p className="tina-web-muted-note">No participant names recorded yet.</p>
                      ) : (
                        <div className="tina-web-filter-options">
                          {facets.participants.map((person) => (
                            <label key={person} className="tina-web-filter-check">
                              <input
                                type="checkbox"
                                checked={filters.participants.includes(person)}
                                onChange={() => toggleArrayFilter("participants", person)}
                              />
                              <span>{person}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {filterTab === "duration" && (
                    <div className="tina-web-filter-pane">
                      <div className="tina-web-filter-options">
                        {DURATION_PRESETS.map((preset) => (
                          <label key={preset.id} className="tina-web-filter-check">
                            <input
                              type="radio"
                              name="meeting-duration"
                              checked={filters.duration === preset.id}
                              onChange={() => {
                                setFilters((cur) => ({ ...cur, duration: preset.id }));
                                setVisibleCount(PAGE_SIZE);
                              }}
                            />
                            <span>{preset.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {filterTab === "recording" && (
                    <div className="tina-web-filter-pane">
                      <label className="tina-web-filter-check">
                        <input
                          type="checkbox"
                          checked={filters.hasRecordingOnly}
                          onChange={(e) => {
                            setFilters((cur) => ({ ...cur, hasRecordingOnly: e.target.checked }));
                            setVisibleCount(PAGE_SIZE);
                          }}
                        />
                        <span>Only meetings with audio recording</span>
                      </label>
                    </div>
                  )}

                  <div className="tina-web-filter-foot">
                    <button type="button" className="tina-web-btn-ghost" onClick={resetFilters}>
                      Reset all
                    </button>
                    <button type="button" className="tina-web-btn-primary" onClick={() => setFiltersOpen(false)}>
                      Done ({filtered.length})
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {(activeFilterCount > 0 || notice) && (
          <div className="tina-web-filter-strip">
            {activeFilterCount > 0 && (
              <div className="tina-web-filter-chips">
                {filters.dateRange !== "any" && (
                  <button
                    type="button"
                    className="tina-web-filter-chip"
                    onClick={() => setFilters((c) => ({ ...c, dateRange: "any" }))}
                  >
                    <span>Date: {DATE_PRESETS.find((d) => d.id === filters.dateRange)?.label}</span>
                    <WebIcon name="close" size={11} />
                  </button>
                )}
                {(filters.dateFrom || filters.dateTo) && (
                  <button
                    type="button"
                    className="tina-web-filter-chip"
                    onClick={() => setFilters((c) => ({ ...c, dateFrom: "", dateTo: "" }))}
                  >
                    <span>
                      Range: {filters.dateFrom || "…"} → {filters.dateTo || "…"}
                    </span>
                    <WebIcon name="close" size={11} />
                  </button>
                )}
                {filters.platforms.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="tina-web-filter-chip"
                    onClick={() => toggleArrayFilter("platforms", p)}
                  >
                    <span>Platform: {p}</span>
                    <WebIcon name="close" size={11} />
                  </button>
                ))}
                {filters.participants.map((person) => (
                  <button
                    key={person}
                    type="button"
                    className="tina-web-filter-chip"
                    onClick={() => toggleArrayFilter("participants", person)}
                  >
                    <span>Participant: {person}</span>
                    <WebIcon name="close" size={11} />
                  </button>
                ))}
                {filters.duration !== "any" && (
                  <button
                    type="button"
                    className="tina-web-filter-chip"
                    onClick={() => setFilters((c) => ({ ...c, duration: "any" }))}
                  >
                    <span>Duration: {DURATION_PRESETS.find((d) => d.id === filters.duration)?.label}</span>
                    <WebIcon name="close" size={11} />
                  </button>
                )}
                {filters.hasRecordingOnly && (
                  <button
                    type="button"
                    className="tina-web-filter-chip"
                    onClick={() => setFilters((c) => ({ ...c, hasRecordingOnly: false }))}
                  >
                    <span>Has recording</span>
                    <WebIcon name="close" size={11} />
                  </button>
                )}
                <button type="button" className="tina-web-clear-link" onClick={resetFilters}>
                  Clear all
                </button>
              </div>
            )}
            {notice && (
              <div role="status" className="tina-web-toast-inline">
                <WebIcon name="check" size={13} />
                <span>{notice}</span>
              </div>
            )}
          </div>
        )}

        <div className="tina-web-meeting-list">
          {groups.map((group) => (
            <div key={group.key}>
              <div className={`tina-web-group-label ${group.tone}`}>
                {group.tone === "live" && <span className="tina-web-live-dot" aria-hidden="true" />}
                <span>{group.label}</span>
                <span className="tina-web-group-count">{group.items.length}</span>
              </div>

              {group.items.map((m) => {
                const label = m.title_custom || m.title;
                const durMins = meetingDurationMins(m);
                const allRowActions = !m.shared ? actionsFor(m) : [];
                const primaryAction = allRowActions.find((a) => a.id === "stop" || a.id === "send");
                const menuActions = allRowActions.filter((a) => a.id !== "delete");
                const errMsg = actionErrors[m.id];
                const menuOpen = openMenuId === m.id;

                return (
                  <div key={m.id} className="tina-web-meeting-card">
                    <WebAvatar name={m.participants[0]?.name || userName} size={36} />
                    <button
                      type="button"
                      className="tina-web-meeting-main"
                      onClick={() => onOpenMeeting(m.id)}
                    >
                      <span className="tina-web-meeting-title-row">
                        <span className="tina-web-meeting-title">{label}</span>
                        <span className={`tina-web-status-pill ${statusClass(m)}`}>{statusLabel(m)}</span>
                        {m.shared && <span className="tina-web-status-pill completed">Shared</span>}
                      </span>
                      <span className="tina-web-feed-meta">
                        {m.platform} · {m.when}
                        {durMins !== null ? ` · ${formatShortDuration(durMins)}` : ""}
                        {m.participants.length > 0 ? ` · ${m.participants.length} participants` : ""}
                        {m.has_recording ? " · Recording ready" : ""}
                      </span>
                      {(m.join_failure_summary || m.auto_join_error || errMsg) && (
                        <span style={{ fontSize: 12, color: "var(--tw-danger)" }}>
                          {errMsg || m.join_failure_summary || m.auto_join_error}
                        </span>
                      )}
                    </button>

                    <div className="tina-web-row-actions">
                      {primaryAction && (
                        <button
                          type="button"
                          className={primaryAction.id === "send" ? "tina-web-btn-primary" : "tina-web-btn-ghost"}
                          disabled={
                            busyId === `${m.id}:${primaryAction.id}` ||
                            (primaryAction.id === "stop" && !wsConnected)
                          }
                          onClick={() => void runRowAction(m, primaryAction)}
                        >
                          {primaryAction.label}
                        </button>
                      )}

                      <div className="tina-web-row-menu-wrap" data-meeting-menu>
                        <button
                          type="button"
                          className="tina-web-icon-btn"
                          aria-label={`More actions for ${label}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId(menuOpen ? null : m.id);
                          }}
                        >
                          <WebIcon name="moreHorizontal" size={16} />
                        </button>

                        {menuOpen && (
                          <div className="tina-web-row-menu" role="menu" aria-label={`Actions for ${label}`}>
                            <button
                              type="button"
                              role="menuitem"
                              className="tina-web-row-menu-item"
                              onClick={() => {
                                setOpenMenuId(null);
                                onOpenMeeting(m.id);
                              }}
                            >
                              <WebIcon name="fileText" size={14} />
                              <span>Open meeting</span>
                            </button>

                            {!meetingsOnly && onAskMeeting && (
                              <button
                                type="button"
                                role="menuitem"
                                className="tina-web-row-menu-item"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  onAskMeeting(m);
                                }}
                              >
                                <WebIcon name="tinaAsk" size={14} />
                                <span>Ask TINA about this meeting</span>
                              </button>
                            )}

                            {!m.shared && (
                              <button
                                type="button"
                                role="menuitem"
                                className="tina-web-row-menu-item"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  setDialogError(null);
                                  setDialog({ type: "rename", meeting: m, title: label });
                                }}
                              >
                                <WebIcon name="edit" size={14} />
                                <span>Rename</span>
                              </button>
                            )}

                            <button
                              type="button"
                              role="menuitem"
                              className="tina-web-row-menu-item"
                              onClick={() => void handleCopyMeetingLink(m)}
                            >
                              <WebIcon name="copy" size={14} />
                              <span>Copy link</span>
                            </button>

                            {!m.shared && (
                              <button
                                type="button"
                                role="menuitem"
                                className="tina-web-row-menu-item"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  setDialogError(null);
                                  setDialog({ type: "share", meeting: m });
                                }}
                              >
                                <WebIcon name="share" size={14} />
                                <span>Share session link…</span>
                              </button>
                            )}

                            {menuActions.length > 0 && <div className="tina-web-dropdown-divider" />}
                            {menuActions.map((act) => (
                              <button
                                key={act.id}
                                type="button"
                                role="menuitem"
                                className={`tina-web-row-menu-item ${act.id === "stop" ? "danger" : ""}`}
                                disabled={
                                  busyId === `${m.id}:${act.id}` || (act.id === "stop" && !wsConnected)
                                }
                                onClick={() => void runRowAction(m, act)}
                              >
                                <WebIcon name={act.id === "stop" ? "stop" : "play"} size={14} />
                                <span>{act.label}</span>
                              </button>
                            ))}

                            {canDeleteRow(m) && (
                              <>
                                <div className="tina-web-dropdown-divider" />
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="tina-web-row-menu-item danger"
                                  onClick={() => {
                                    setOpenMenuId(null);
                                    setDialogError(null);
                                    setDialog({ type: "delete", meeting: m });
                                  }}
                                >
                                  <WebIcon name="trash" size={14} />
                                  <span>Delete meeting</span>
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {filtered.length > visibleCount && (
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 6 }}>
              <button
                type="button"
                className="tina-web-btn-ghost"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              >
                Show more ({filtered.length - visibleCount} remaining)
              </button>
            </div>
          )}

          {groups.length === 0 && (
            <div style={{ padding: "48px 16px", textAlign: "center", color: "var(--tw-text-4)" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--tw-text-2)" }}>
                {meetings.length === 0 ? "No meetings captured yet" : "No meetings match these filters"}
              </p>
              {activeFilterCount > 0 ? (
                <button type="button" className="tina-web-btn-ghost" onClick={resetFilters}>
                  Reset filters
                </button>
              ) : (
                <button type="button" className="tina-web-btn-primary" onClick={() => onOpenCapture("live")}>
                  <WebIcon name="capture" size={15} />
                  <span>Capture your first meeting</span>
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {dialog?.type === "rename" && (
        <div
          className="tina-web-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Rename meeting"
          onClick={() => setDialog(null)}
        >
          <div className="tina-web-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tina-web-modal-head">
              <h2>Rename meeting</h2>
              <button type="button" className="tina-web-icon-btn" aria-label="Close" onClick={() => setDialog(null)}>
                <WebIcon name="close" size={16} />
              </button>
            </div>
            <form onSubmit={submitRename} className="tina-web-modal-body">
              <label className="tina-web-field">
                <span>Meeting title</span>
                <input
                  autoFocus
                  type="text"
                  value={dialog.title}
                  onChange={(e) => setDialog({ ...dialog, title: e.target.value })}
                  disabled={dialogBusy}
                />
              </label>
              {dialogError && (
                <div role="alert" style={{ fontSize: 12.5, color: "var(--tw-danger)" }}>
                  {dialogError}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="tina-web-btn-ghost" onClick={() => setDialog(null)}>
                  Cancel
                </button>
                <button type="submit" className="tina-web-btn-primary" disabled={dialogBusy || !dialog.title.trim()}>
                  {dialogBusy ? "Saving…" : "Save title"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dialog?.type === "delete" && (
        <div
          className="tina-web-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Delete meeting"
          onClick={() => setDialog(null)}
        >
          <div className="tina-web-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tina-web-modal-head">
              <h2>Delete meeting</h2>
              <button type="button" className="tina-web-icon-btn" aria-label="Close" onClick={() => setDialog(null)}>
                <WebIcon name="close" size={16} />
              </button>
            </div>
            <div className="tina-web-modal-body">
              <p className="tina-web-muted-note">
                Permanently remove <strong>{dialog.meeting.title_custom || dialog.meeting.title}</strong> and its stored transcript artifacts? This cannot be undone.
              </p>
              {dialogError && (
                <div role="alert" style={{ fontSize: 12.5, color: "var(--tw-danger)" }}>
                  {dialogError}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="tina-web-btn-ghost" onClick={() => setDialog(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="tina-web-btn-danger"
                  disabled={dialogBusy}
                  onClick={() => void confirmDelete()}
                >
                  {dialogBusy ? "Deleting…" : "Delete meeting"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {dialog?.type === "share" && (
        <ShareMeetingModal
          meeting={dialog.meeting}
          memberships={sharedMemberships.filter((ms) => ms.role === "owner" || ms.role === "contributor")}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function ShareMeetingModal({
  meeting,
  memberships,
  onClose,
}: {
  meeting: MeetingMock;
  memberships: Membership[];
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"open" | "restricted">("open");
  const [ttlDays, setTtlDays] = useState(7);
  const [emails, setEmails] = useState("");
  const [wsId, setWsId] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createLink = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const allowed =
        mode === "restricted"
          ? emails
              .split(/[,\s]+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      const t = await mintTranscriptShare(meeting.id, {
        mode,
        allowed_emails: allowed,
        expires_in_sec: ttlDays * 86400,
      });
      const params = new URLSearchParams();
      params.set("tshare", t.token);
      if (wsId) {
        const inv = await mintInvite({
          workspace_id: wsId,
          role: "contributor",
          mode,
          expires_in_sec: ttlDays * 86400,
          max_uses: mode === "open" ? 50 : 1,
          allowed_emails: allowed,
        });
        params.set("invite", inv.token);
      }
      setLink(`${window.location.origin}/?${params.toString()}`);
      setCopied(false);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore clipboard denial */
    }
  };

  return (
    <div
      className="tina-web-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Share meeting session"
      onClick={onClose}
    >
      <div className="tina-web-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tina-web-modal-head">
          <h2>Share session · {meeting.title_custom || meeting.title}</h2>
          <button type="button" className="tina-web-icon-btn" aria-label="Close" onClick={onClose}>
            <WebIcon name="close" size={16} />
          </button>
        </div>
        <form onSubmit={createLink} className="tina-web-modal-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
            <label className="tina-web-field">
              <span>Access</span>
              <select value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as "open" | "restricted")}>
                <option value="open">Anyone with link</option>
                <option value="restricted">Specific emails</option>
              </select>
            </label>
            <label className="tina-web-field">
              <span>Expires</span>
              <select value={ttlDays} disabled={busy} onChange={(e) => setTtlDays(Number(e.target.value))}>
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
              </select>
            </label>
          </div>

          {mode === "restricted" && (
            <label className="tina-web-field">
              <span>Allowed emails</span>
              <input
                type="text"
                value={emails}
                disabled={busy}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="alice@company.com, bob@company.com"
              />
            </label>
          )}

          {memberships.length > 0 && (
            <label className="tina-web-field">
              <span>Bundle shared workspace (optional)</span>
              <select value={wsId} disabled={busy} onChange={(e) => setWsId(e.target.value)}>
                <option value="">Transcript feed only</option>
                {memberships.map((ms) => (
                  <option key={ms.workspace_id} value={ms.workspace_id}>
                    + Workspace: {ms.workspace_id}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && (
            <div role="alert" style={{ fontSize: 12.5, color: "var(--tw-danger)" }}>
              {error}
            </div>
          )}

          {link && (
            <div className="tina-web-minted-box">
              <input readOnly value={link} aria-label="Session share link" className="tina-web-input" />
              <button type="button" className="tina-web-btn-ghost" onClick={() => void copy()}>
                <WebIcon name={copied ? "check" : "copy"} size={14} />
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="tina-web-btn-ghost" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="tina-web-btn-primary" disabled={busy}>
              {busy ? "Creating…" : link ? "Generate new link" : "Create share link"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
