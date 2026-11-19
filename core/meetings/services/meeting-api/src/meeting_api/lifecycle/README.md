# lifecycle — receiver + meeting-state machine (O-MTG-1)

`voice_settings.py` exposes account-authenticated TTS readiness metadata and a bounded fixed-text
WAV preview for browser playback only. It never sends a room Speak command or returns TTS credentials.

The bot capability's voice config may include advisory tool progress only while its session,
policy revision and request hold the room lease. Owner runtime views reuse that validation;
the bot additionally requires a matching request and a progress age below 15 seconds before
speaking a tool-specific waiting notice. Invalid/stale progress does not change readiness.

`task_flow.py` owns ephemeral identified-caller task state and CAS-fences Pipecat's flow plan/apply
operations with the room lease. Worker requests contain no slot-state input. Only exact completed
prompt receipts resume a pending flow; a final answer uses the existing playback/draft review path.

The **receiver** side of `lifecycle.v1`. The bot emits LifecycleEvents to its control-plane
callback (emitter = `meetings/services/bot/src/orchestrator.ts`, L4-proven); this brick ingests
them, validates each AT THE SEAM (jsonschema by path against the sealed `lifecycle.v1` schema),
and drives each meeting record's FSM — rejecting illegal transitions.

Derived from the parent `services/meeting-api/meeting_api/{callbacks.py, schemas.py}`,
reimplemented clean for the bot's DOMAIN lifecycle (lifecycle.v1's `BotStatus`), dropping the
server-side `requested`/`stopping` states.

## The machine
```
<new>              → joining
joining            → awaiting_admission · active · failed
awaiting_admission → active · needs_help · failed
needs_help         → active · failed
active             → completed · failed
completed          ∅   (terminal)
failed             ∅   (terminal)
```
`completed` records the bot-reported `completion_reason`; `failed` records a `failure_stage`
**derived server-side from the state we were in** — never trusted from the bot's payload (the
parent's FM-003 discipline). `active → joining` (and any re-open of a terminal record) is rejected.

## Surface
- `machine.py` — `BotStatus`/`CompletionReason`/`FailureStage` (the lifecycle.v1 enums),
  `LEGAL_TRANSITIONS` + `can_transition`, `MeetingRecord`, `MeetingStore` (in-memory, holds no DB
  handle — but `MeetingRecord.data` is projected into the real `meetings.data` JSONB by
  `update_meeting_status`, so this brick is the sole writer of meeting attribution in production),
  `LifecycleSink` (`apply(event)` / `apply_change(event, transition_source=…)`), `IllegalTransition`,
  `TransitionSource`, `StatusChange`.
- `receiver.py` — `create_app(store, on_status_change)`: the FastAPI receiver.
  `POST /bots/internal/callback/lifecycle` validates → drives the FSM → emits the
  `meeting.status_change` webhook → `200 accepted` / `409 illegal-transition` / `422 schema-violation`.
- `webhook.py` — `build_status_change_envelope(change)`: wrap a `StatusChange` as a sealed
  `webhook.v1` `Envelope` (`event_type=meeting.status_change`), validated at the seam.
- `stop.py` (P3b) — the user-stop path: `request_stop(record, publisher, meeting_id)` sets
  `stop_requested` + publishes the `bot_commands:meeting:{id}` `{action:"leave"}` command;
  `classify_user_stop` / `stop_event_for` resolve the bot's exit to an ATTRIBUTED terminal.
- `retry.py` — transient/permanent taxonomy and bounded backoff. Production persists eligible retries
  in `meeting.data.auto_retry`; the single-flight auto-join loop re-spawns each attempt as a new session.
  (`classify_retry` / `is_transient`): on a TRANSIENT join-failure schedule a fresh re-spawn (a new
  `meeting_session`) through the runtime scheduler with bounded exponential backoff; a PERMANENT
  reason never retries.

## P3a — lifecycle diagnostics (attributable reasons)
Every FSM advance captures `completion_reason` · `failure_stage` (DERIVED SERVER-SIDE from the
record's status at write-time, never the bot's stale payload) · `error_details` · a
`status_transition[]` trail (one entry per hop: `{from, to, timestamp, source, [reason,
completion_reason, failure_stage, error_details]}`) · terminal forensics (`bot_logs` capped at 50 KiB
trimmed oldest-first + `bot_resources`). `MeetingRecord.data` is the `meeting.data` JSONB projection
the parent persists. Each advance returns a `StatusChange` carrying the `meeting.status_change`
webhook body `{old_status, new_status, reason, transition_source ∈ user_stop|bot_callback|scheduler_timeout}`.

## P3d taxonomy
TRANSIENT → retry: `awaiting_admission_timeout`, `join_failure`. PERMANENT → no retry → failed:
`awaiting_admission_rejected`, `evicted`, `validation_error`, `max_bot_time_exceeded`, user `stopped`
(+ `left_alone`/`startup_alone`, which are normal outcomes). Unknown/None → PERMANENT (fail-safe).

## Evals
`tests/test_lifecycle_machine.py` (FSM) · `test_lifecycle_http.py` (receiver) ·
`test_lifecycle_diagnostics.py` (P3a: per-terminal-cause attribution + webhook) ·
`test_lifecycle_fixtures.py` (P3b: normal / user-stop+leave-command / join-failure) ·
`test_join_retry.py` (P3d: FakeClock-driven bounded retries). Ride `gate:python`.

`voice.py` owns room-shared voice policy, active-session capability checks, turn reservations and state. Policy changes cancel thought/playback; only approved current evidence may reach TTS.

LiveKit agent operations reserve the existing room turn and budget up to two planned tools. Finalization accepts only actual heard caller context and completed queries; Stop and policy/session changes fence late work.

Managed Agents turns allow two plans/four attempted lookups in a shared 30-second phase. Opaque context handles come only from prior successful results in that turn. Timeouts skip new work and finalization uses successful queries; Stop, final dispatch, policy/session changes and request fingerprint checks fence every later tool.

Verified answers persist at most 32 evidence references with playback receipts. Public reply history exposes only source_count. GET /meetings/{meeting_id}/voice-assistant/sources/{request_id} checks owner/artifact state and resolves current authorized quotes through Agent API; old replies without refs cannot gain invented citations.
Caller history stores at most three receipt-confirmed turns plus one pending candidate. Only the
last three heard turns enter prompts; repeated failed/unplayed answers cannot evict confirmed
context. Nonempty stopped prefixes remain supported, with the same caller/session/policy fences.

Native and LiveKit turn admission share a WATCH/CAS reservation. It rechecks the latest known bot session, reclaims only a well-formed lease belonging to a provably retired session, and preserves current/unknown ownership. Retired playback is marked stopped through PlaybackStore CAS, retaining completed prefixes and preventing late receipts from reopening it or clearing a replacement command.

`voice_handoff.py` bounds owner-only transfers from paused/error voice turns. Claiming checks playback, lease, policy/source freshness and task-state identity before atomically detaching a task flow. Claims prepare private chat context, never write tasks. See meeting-voice.v1 for expiry and response shapes.

The existing `task_flow` envelope also hosts `kind: decision`; admission/planning/finish route to Decision Flow while preserving per-caller lease/receipt fences. Unidentified decision callers fail closed. Paused decisions use the existing owner-only chat handoff with separate requested status and source verdict.

Upstream request/source conflicts preserve safe typed HTTP statuses. A decision finish 409 invalidates its proof and stages a clarification; actual unknown-write failures mark both task and decision state save_uncertain. Voice cannot reconfirm an uncertain task write under a new request UUID.

Decision Flow review prompts that assert decided status resolve their proof fingerprints immediately before playback admission and retain accepted source refs in receipts/history. Stale/missing proof produces source clarification; resolver outage preserves collected fields without releasing the cached decided readback. Final room/policy/Stop checks still apply after lookup.
