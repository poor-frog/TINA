# calendar_sync — calendar sources → planned meetings

One concern: turn a user's secret ICS feed or selected Google Calendar into PLANNED meeting rows (intent status
`scheduled`, complete `data.calendar_sources[].event` provenance) so the Meetings surface shows what's coming and the
auto-join sweep sends the bot when each meeting starts. ICS URLs and Google OAuth grants are managed
by the identity domain. Google refresh tokens are encrypted at rest and cross only the internal
calendar-config edge; new Google connections keep auto-join off until enabled per calendar.
The linked Google account also authorizes read-only Meet attendance and People lookups. After a
Google Meet, Meeting API requires one conference covering the bot's admission time for the room
code. It accepts emails verified on a Google account or profile with the matching participant
account ID. Unavailable or private addresses remain unresolved. A temporary provider error can
leave a partial list of verified addresses that Flows can use while scheduling a retry.
Google lists conference records only to
organizer accounts; if no linked Google grant can access the record, the attendee lookup is
unavailable and follow-up falls back to the owner only.

## Public surface
- `parse_ics(text, now, horizon_days=14)` → `{"events": [PlannedEvent], "cancelled_uids": […]}`
  (pure). **One event per UID — the next upcoming occurrence only** (a recurring meeting reuses one
  link; two active rows on one native id would violate `uq_meeting_active_user_platform_native`).
  Every event carries a JSON-safe snapshot of all VEVENT properties, parameters, nested components,
  top-level VCALENDAR properties, and the series master for an override. Link-less events still
  import honestly; only recognized Meet/Zoom/Teams links arm auto-join.
- `sync_user(store, user_id, parsed, auto_join_default, …)` → upserts through the SAME planned-meeting
  store primitives `POST /meetings` uses (advisory-locked). Intent rows follow the feed; FSM rows
  are never touched; a manual plan on the same link is ADOPTED (uid stamped), not duplicated;
  vanished/cancelled UIDs retire their still-planned rows. Two rules the whole-row semantics rest on:
  `auto_join` is DERIVED from the connected calendars' policy **unless** the user pinned it on that
  row (`data.auto_join_user_set`, written by `PATCH /meetings/{id}`), and rows imported before plural
  calendars — bare `data.calendar_uid`, no sources — are claimed only by the `legacy=True` connection,
  which is also the one that may retire them.
- `fetch_ics(url, client=None)` — **SSRF-pinned** (`webhooks/ssrf.build_pinned_transport`), 2 MB cap,
  no redirects; pass a `build_ics_client()` to share one connection pool across a sweep.
- `fetch_google_events(config, now, client=None)` — refreshes the stored offline grant, reads a bounded
  14-day event snapshot, and normalizes it to the same planned-event shape. Provider failures do not
  become empty snapshots; one cancelled recurring instance does not cancel its series.
  `fetch_configs(admin_api_url, secret)` — the internal discovery hop.

## Wiring (entrypoint)
`meeting_api.__main__._attach_background_loops` runs one sweep per `CALENDAR_SYNC_INTERVAL_S`
(default 300 s): configs → grouped by user → up to `CALENDAR_SYNC_CONCURRENCY` users at a time,
each reading its meeting rows ONCE and threading them through that user's calendars over one shared
pinned client (per-user try/except — one bad feed never stalls the sweep) → WS frames per changed
row → `cal:sync:{user_id}` redis stamp (`last_sync`/`last_error`/counts, read back by the terminal's
calendar popover). A config arrives in one of three shapes: live (feed URL), `deleted` (tombstone),
or `paused` (`enabled: false`) — the latter two parse as an empty feed, so a disconnected or paused
calendar leaves no meeting armed. Unset `ADMIN_API_URL`/`INTERNAL_API_SECRET` → the loop no-ops
(capability degrade, not boot-fail).

## Dependencies
`icalendar` + `python-dateutil` (both FINOS Category A), imported lazily. Depends on
`collector` (meeting_link + the planned-meeting store port) and `webhooks.ssrf` only.

Google snapshots retain each source's current link and timed start in source metadata. A removed
Google link disarms only a calendar-managed planned row when no other source still authorizes a
link; manual plans and FSM-owned rows keep their ownership. An alternative timed source keeps its
own room/time pair. Link-index updates prevent a new event from adopting a just-detached identity.

Google all-day dates remain dates in provenance (`all_day`, `start_date`, exclusive `end_date`).
They do not become midnight UTC join times: new entries are idle with no scheduled instant and
no auto-join. A selected calendar's timezone is forwarded on the internal config edge for date
windowing; date anchors are used only for occurrence comparison, so finished all-day instances
are not repeatedly imported. Other timed sources and manually entered schedules stay authoritative.
