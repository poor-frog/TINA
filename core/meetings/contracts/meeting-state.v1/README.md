# meeting-state.v1

Meeting API owns canonical structured live state. Agent workers only return extraction/reasoning
candidates. This contract is independent of `processed-notes.v1` and never changes canonical ASR.

## Jobs and publication

`meeting_state_requests` carries an owner/meeting/role/generation/epoch-bound immutable job.
Meeting API signs sorted compact UTF-8 JSON (all fields except `proof`) using HMAC-SHA256 and the
existing internal secret. Agent API verifies the proof and checks the current lease before dispatch.
Workers receive neither the signing secret nor canonical write access. Fast and reason jobs have
independent 180-second leases. At most one of each runs per meeting. Retries are bounded to three
attempts per unchanged fingerprint with capped backoff/jitter; operator retry explicitly resets failure.

After admission, Agent API stores the immutable payload at
`meeting_state_job:{meeting_id}:{generation}` with a lease-bounded TTL. Worker environment contains
only its owner-bound key reference, avoiding operating-system environment-size limits for long ASR
segments. The worker deletes the payload after use; artifact deletion purges outstanding payloads.
Successful oversized-segment chunks may heartbeat the existing capability within a source-size-bound
hard deadline. Heartbeats never advance coverage or publish a partial segment.

`meeting_state_results` carries a candidate result. Source fingerprints, exact quote/revision checks,
expected item revisions and epoch/lease checks precede row-locked publication. Duplicate delivery
cannot reapply a patch. ACK follows commit. OFF revokes outstanding publication rights. Queued
source text is purged with meeting artifacts.

Fast output is provisional. IDs are assigned by Meeting API, not the model. Local `key` aliases in
fast output are resolved only within that result. Reasoning output must cover its input candidates;
related read-set items may also receive cited patches. Summaries cannot publish on a stale read set.
Human edits/confirmed values require human approval before conflicting AI patches can apply.

## HTTP

- `GET /transcripts/by-id/{id}/state`: authorized participant projection, separate stage freshness.
- `POST .../state/configure`: owner enablement and cadence/timezone/approval presets.
- `POST .../state/edit`: revision-checked structured patch.
- `POST .../state/vote`: approval/rejection against a snapshotted electorate.
- `POST .../state/{claim,validate,result,retry}`: internal capability required in addition to owner scope.

Participant responses omit internal clocks, job capabilities, source fingerprints and raw source
snapshots. List, webhook and ordinary meeting responses omit the entire internal state blob.

`meeting_state_spans` is a bounded metadata-only temporary diagnostic transport. Spans do not include
source/prompt/response text or secrets. Operator diagnostics aggregate into a volatile, capped 24-hour
cache and are explicitly best-effort. They never participate in state correctness.

See `docs/live-assist.md` for deployment, supported rollout scope, and checks.
