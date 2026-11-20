# Two-model live meeting state

The live-state assistant is independent of processed transcript notes and manual post-meeting
Discussion Review. Meeting API owns the durable structured state; isolated agent workers return
source-linked extraction or reasoning candidates. Markdown is a final projection, not a live database.

## Enable locally

1. Run the normal admin-api schema synchronization before upgrading Meeting API. It creates
   `meeting_state_events`; see `MIGRATION-0009-meeting-state-events.md` in the schema directory.
2. Configure the existing completion provider/endpoint/credentials and set two operator-selected IDs:

   ```dotenv
   TINA_STATE_FAST_MODEL=your-fast-model-id
   TINA_STATE_REASON_MODEL=your-reasoning-model-id
   ```

   Both IDs must be permitted by `TINA_MODEL_ALLOWLIST` when configured. They use the same effective
   completion endpoint initially. Neither silently falls back to another model. An endpoint that
   serializes requests can still cause contention even though the application jobs are independent.
3. Build the Meeting API, agent API, worker, and terminal images from this checkout. The worker and
   API images vendor the `meeting-state.v1` schema. Both services need the existing internal secret.
4. Open **Live state** in meeting planning or the meeting canvas and explicitly enable it. Planning
   reveals goal, agenda and timezone setup only after opt-in. Spontaneous meetings create state on
   opt-in. Recording or enabling processed notes alone does not activate this feature.

## Processing

- Default fast window: 30 seconds from its first finalized ASR segment. A segment is a beat.
  An independent scheduler flushes completed segments during silence; unfinished captions wait.
- Adjacent backlog windows coalesce within size limits. Large windows split between segments.
  A single oversized segment is chunked internally with overlap; publication waits for all chunks.
- Fast extraction uses compact current state and bounded lexical/recency retrieval from this meeting.
  Provisional questions, claims, topics, actions, corrections and explicit speech signals retain
  exact source quotes. A speech signal of agreement is not automatically group consensus.
- Fast jobs also carry up to 20 eligible host agenda entries within a 6,000-character budget. Each
  extracted item gets one supported agenda ID or an explicit empty `details.agenda_ids` list. The
  Meeting API checks the ID against the job context and the current host agenda. The live view keeps
  explicit empty matches under Other meeting items. Reasoning can refine the assignment later.
- Reasoning runs about every two minutes with new work, or early on a debounced boundary. It
  reconciles stable items, summaries, statuses and relationships. Only one job per stage runs per
  meeting, but fast and reason jobs may overlap. Repeated reasoning triggers coalesce.
- Host cadence presets are 15/30 seconds and 1/2/5 minutes. Eagerness is low/normal/high (5/4/3
  distinct turns), normal by default. Stall suggestions are topic-scoped and require cited repeated
  positions; the cooldown resets only on cited progress.
- Worker calls are tool-less. Transcript text is data, never a command to alter state or use tools.

### Shared-document research

The **Research documents** action searches only visible Markdown in the bound shared workspace. It
skips hidden/symlinked paths, caps traversal at 1,000 files/4 MiB, and selects at most five 2,000-character
excerpts, each bound to its path and SHA-256. It never searches private workspaces or the public web.
Workspace membership, explicit meeting viewers, and source hashes are checked before evidence enters
state, before reasoning, and on subsequent state reads. If a source changes, is removed, or is no
longer shareable, dependent quotes/summaries are hidden and re-evaluated. A manually removed source
does not silently restore its cached excerpt.

## State editing and approvals

Authorized meeting viewers can make deterministic structured text/status/detail edits while the
meeting is active. Saves check the item's expected revision. Conflicting drafts remain in the UI
for deliberate reapplication. Human values are protected from conflicting AI patches.
Current and meeting-so-far summaries have independent revisioned records and are directly editable;
their human-set values are not rewritten by later reconciliation without an approval proposal. The
live view renders the most recent 100 items, pages older source-linked items and audit activity in
groups of 100, and jumps exact transcript citations to their segment in the transcript canvas.

Host/creator approval is the default. Meeting settings also accept named, any-participant, quorum,
and unanimous modes. Proposals snapshot the known eligible TINA participants and configured named
approvers. Proposal publication and voting fetch the current bound-workspace roster from the
internal agent membership authority, outside the meeting-row transaction. Votes require current
meeting authorization; unauthorized or removed voters cannot count. A failed/corrupt roster lookup
fails closed rather than silently reducing a quorum. Membership changes are recorded visibly.

Inline human attribution and activity order are visible to viewers. Exact audit times, leases,
processing IDs and model-job source snapshots are internal. Closed proposal content moves to the
audit stream; it is not retained indefinitely in the canonical pending-proposal collection.

Optional versioned organization policy is installed on a configured meeting through the internal
operator endpoint `POST /api/admin/meeting-state/{id}/policy`. It supports `enabled`, increasing
`version`, `readers`, `editors`, `approvers`, `approval_modes`, `audit_days`, and `external_search`.
Role values are TINA account ID arrays. This is an internal-secret-protected operator operation;
hosts cannot bypass it. Installing a policy revokes in-flight job publication capabilities.

Pausing stops AI publication and freezes AI approvals, but retains active-meeting manual editing.
Re-enable catches up from durable source coverage. Transcript revisions invalidate affected evidence
and trigger targeted replay. Audit defaults to 14 days after meeting end, independently of meeting
state retention; enabled policy may change that duration.

## Finalization and Wiki

Terminal Meeting API status starts draining; a `session_end` stream frame is not required. The
scheduler checks the ingestion group's delivery/pending watermark and flushes the meeting's queued
segments durably before allowing final reasoning. The terminal source must also remain stable
across sweeps. A two-minute drain deadline exposes incomplete status rather than pretending success.
Bounded retries may finish already-recorded evidence after meeting end while human state is read-only.

Only a complete final state is automatically published. The constrained publisher writes a
create-only `wiki/meetings/{id}/state.md` in the meeting-bound shared workspace, after checking the
owner's current contributor permission, and commits that path only. An existing different page is
preserved and reported as a conflict. No bound writable shared workspace means export-only, never a
fallback into a private Wiki. The dialog also offers a Markdown export of current state, labeled with
its finalization status.

## Operator profiling

The dialog shows operator diagnostics only after the terminal's existing admin allowlist gate.
The server independently checks the internal secret. The view can load/export traces and retry
failed jobs; retry does not bypass source, authorization, epoch or lease validation.

Measured stages include dispatch, queue-to-worker and dispatch-to-worker wall-clock estimates,
client initialization, prompt construction, model attempts (including failures), parsing/schema
validation, worker execution, and Meeting API validation/commit. Token usage is recorded when the
provider supplies it. Shared-endpoint queue time and model-internal cold start/prefill/generation
cannot be separated from HTTP elapsed time without provider telemetry; they are not fabricated.

Spans are scrubbed metadata, transported through a capped temporary Redis stream into a capped
24-hour in-memory control-plane cache. Restart/eviction can lose spans, and exports explicitly mark
their best-effort nature. Prompts, source text, responses, credentials and keys are excluded.
For rejected model replies, `parse_and_schema` reports the failure category and either the JSON
line and column or the violated schema keyword and schema path. `validate_and_commit` includes
the Meeting API's rejection code when available.

## Verification and remaining rollout work

Targeted checks:

```text
python -m pytest core/meetings/services/meeting-api/tests/test_live_assist.py -q
python -m pytest core/agent/tests/test_live_assist.py -q
corepack pnpm --dir clients/terminal test --run src/surfaces/__tests__/liveMeetingState.test.tsx
corepack pnpm --dir clients/terminal exec tsc --noEmit
node core/meetings/contracts/meeting-state.v1/validate.mjs
```

The replay tests use deterministic model fixtures and exercise quiet timers, source revisions,
backlog coverage, idempotence, separate stages, citation rejection, policy fencing, edits/approvals,
pause/catch-up and finalization. They establish correctness, not real-provider latency or quality.
The p95 <= 60-second extraction freshness target still needs representative recorded-meeting replay
against the selected providers and runtime, including cold starts and retry injection.

Further integrations from the full target plan remain explicit:

- Public-web search is disabled/deferred; only user-triggered shared-document retrieval is implemented.
- Browser paint/delivery acknowledgment and provider-reported internal timings beyond available usage.
- Production PostgreSQL/runtime smoke and real-provider performance baselines before rollout.

These gaps must not be represented as implemented RAG or a measured SLO.
