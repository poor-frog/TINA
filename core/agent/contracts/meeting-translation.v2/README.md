# meeting-translation.v2

Owner-authorized English phrase overlay. Replaces the per-ASR-fragment v1 response
at GET/POST `/api/meeting-translations/{meeting_id}` (gateway `/agent/meeting-translations/{meeting_id}`).
Terminal and extension must be upgraded together; older viewers retain Vietnamese when the
response version is unsupported. The frozen v1 schema remains for historical reference.

`groups` contains core-owned phrase boundaries, exact `members` (source segment IDs/text/revision),
combined `source_text`, English text or null, speaker identity and source start/end times.
`total` and `completed` count groups. Clients never infer phrase boundaries or distribute an
English sentence among source fragments. They reject a group's English if any visible member
has changed (including a known canonical revision), and retain new/draft Vietnamese while waiting
for the next snapshot. The optional fields below extend v2 without changing required fields or
the existing top-level status values.

Each group may include `status` (`waiting`, `pending`, `running`, `retrying`, `failed`, `complete`),
`attempts`, `retry_after` seconds, and a fixed `error_code`. `waiting` is an unfinished live phrase;
`retrying` is a phrase-local cooldown; `failed` means automatic phrase retries are exhausted.
Top-level `can_advance` tells clients whether an automatic POST can claim work now. They keep
polling GET when it is false, and may POST on explicit retry. Top-level `service_error` identifies
an owner-wide auth/configuration/rate-limit/unavailable cooldown; it never includes provider text.

Consecutive finalized segments of the same speaker join until a sentence ending (at least
six words), speaker change, a three-second source pause, or a size/time bound (40 words,
360 characters or 12 seconds). Oversized individual ASR segments remain intact. A live tail
waits five seconds without a newly observed finalized tail; stable capture timestamps alone
do not bypass this wait because ASR delivery may be delayed. Completed/stopped/failed
meetings flush their tail immediately. Empty/draft segments never enter translation.

GET authorizes the canonical transcript and meeting status, observes tail stability, and reads
cached results without inference. POST `{"retry": false, "segment_ids": []}` advances
at most one ready group. Optional source IDs (max 128) prioritize the currently rendered
live turns before historical backfill; callers cannot supply transcript bytes. `retry: true`
bypasses phrase/service backoff and exhausted automatic attempts, never an active lease or the
live grouping wait. It prioritizes errored phrases while preserving visible-ID priority within
that set, and does not invalidate successful cached results.

The existing tool-less CompletionPort uses the owner's saved Meeting model and credentials.
Results persist in `phrase_translations` within the existing private SQLite cache on the agent
workspace volume, outside workspace Git trees. Cache keys include every member ID and exact
source text and canonical revision. Existing pre-revision cache entries are accepted only for
unedited (revision zero) members. Old v1 fragment results are retained on disk but never reused.
Atomic 120-second leases recheck cached results and deduplicate web/extension calls across
processes. After inference, ownership, source text/revision and phrase grouping are reloaded;
obsolete responses and expired/replaced lease results are discarded.

Timeout, rejected-request and unusable-output failures back off independently for each phrase:
15 then 60 seconds, at most three automatic attempts per source revision, then explicit retry.
Other ready phrases continue. Auth, missing model/configuration, quota and unavailable service
errors pause all meetings for that owner with 15/60/300-second backoff. An older in-flight success
cannot clear a newer service failure. Automatic retries resume only while a translated view is
open. Retry state survives API restarts. The private SQLite upgrade preserves results, leases
and legacy cooldowns; no new service, environment setting or canonical database migration is needed.

`$defs.worker_completion` describes the private tool-less worker terminal marker: optional
`translation_error` uses fixed codes (`auth`, `configuration`, `rate_limit`, `unavailable`, `timeout`,
`request_rejected`, `invalid_translation`, `interrupted`). The control plane ignores partial deltas
on failure and rejects streams without a completion marker. No provider details cross this seam.
Reasoning blocks never enter the visible English output. Capture and raw/
canonical transcripts stay independent. Inference advances only while a translated view is open.
