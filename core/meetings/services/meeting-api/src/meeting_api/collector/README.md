# collector — the folded-in transcript backend

The transcript read-side + segment-ingestion the gateway proxies `/transcripts` + `/meetings` +
`/ws/authorize-subscribe` to. **Relocated VERBATIM** from the standalone `transcription_collector`
service into `meeting_api.collector` (P2 unification) — the same shipped code, now a front-doored
sub-package of the one meeting-api modular monolith. Mounted by `meeting_api.app.create_app`
alongside lifecycle / bot_spawn / recordings. Import direction is one-way: the gateway conformance
harness imports this sub-package to drive the shipped collector; this package imports nothing from
conformance.

- **`create_app(store, redis, ...)`** / **`build_router(store, redis, ...)`** — `app.py`. GET
  `/transcripts/{platform}/{native_meeting_id}` (api.v1 `TranscriptionResponse`), GET `/meetings`
  (api.v1 `MeetingListResponse`), POST `/ws/authorize-subscribe` (the gateway `/ws` authorizer hop).
  `build_router` is the mountable `APIRouter` the unified app composes in (one app, one `/health`);
  `create_app` is the standalone app the conformance harness + this module's tests still drive.
  Identity arrives as the gateway-injected `x-user-id` header (missing → 401).
- **`ingest` / `consume_segments`** — `ingest.py`. `transcription_segments` stream → `store` →
  publish `tc:meeting:{id}:mutable`. No background loop — the caller drives it (eval `tick`). The
  always-on consumer loop is a P3 seam.
- **`ports.py`** — `TranscriptStore`, `RedisBus`, `PubSub` (Protocols; real adapters + fakes both
  satisfy them structurally).
- **`adapters.py`** — the real SQLAlchemy-async + redis wiring (lazy imports).
- **`models.py`** — re-exports the shared SQLAlchemy mirror from `meeting_api.sessions.models` (ONE
  `Base` per monolith).
- **`fakes.py`** — `InMemoryTranscriptStore` + `FakeRedisBus` (offline).
- **`obs.py`** — `logevent.v1` trace emitter, bound to `service="transcription-collector"` (the
  collector hop identity is preserved); reads the gateway-forwarded `X-Trace-Id` so this hop's logs
  join the same trace.

Tests (relocated into meeting-api's suite): `../../../../tests/test_collector_api.py`,
`test_ingest.py`, `test_collector_health.py` (+ the `collector_contracts.py` api.v1 oracle).


## Transcript review

Owner-only `GET /transcripts/by-id/{meeting_id}/document` returns transcript-document.v1. `PATCH /transcripts/by-id/{meeting_id}/segments/{segment_id}` requires `{expected_revision,text}` (null restores original) after the meeting is terminal. The real adapter locks the owned meeting row, appends a manual/restore revision in `meeting.data.transcript_edits` and commits before replying. It does not write `transcriptions`; the collector remains the sole raw-ASR writer. Ordinary transcript REST reads project the correction overlay. Raw text/history are omitted from general meeting data and shared views; the dedicated document is owner-only. Search and live ASR events still use raw ASR; reindexing downstream knowledge is a later phase.

No schema migration is required: the revision ledger uses the existing JSONB carrier. Recordings remain conditional on the existing recording setting. The review document lists actual recordings separately and does not claim exact channel/word audio alignment for a mixed recording. New local Desktop source-frame archives are separate from bot diagnostic tapes, whose retention remains unchanged.

Owner review also serves durable post-meeting bot refinement under `/transcripts/by-id/{id}/refinement`.
The recording MediaRecorder origin plus producer session UID maps each segment to an exact bounded
recording span. A sequential second pass uses the owner's configured ASR endpoint, optionally with
vocabulary hints. Progress/proposals live in private meeting JSONB. Apply verifies source hash and
revision under the same row lock as its revision/provenance write; Restore retains the raw ASR text.
Unclocked legacy recordings and ambiguous/missing/overlong audio are skipped. See
`core/meetings/contracts/transcript-refinement.v1/README.md` for limits and routes.

Optional Vietnamese word alignment is served under `/transcripts/by-id/{id}/alignment`. It runs
through the self-hosted MFA worker in batches, stores source/model hashes in private meeting JSONB,
and publishes metadata-only invalidations through the same transcript outbox. The separate view
keeps transcript-document.v1, raw ASR and source audio unchanged; OOV words have no time and
overlapping/uncertain speaker attribution stays unknown.

Durability compatibility: provider language labels longer than the legacy `varchar(10)` are stored
as NULL instead of aborting the whole segment batch (for example `EnglishChinese`). Text and audio
are unchanged; widening language metadata is a separate migration. Upserts preserve an existing
producer session UID when a later legacy payload omits it, and accept a newly supplied UID.

Canonical revisions: manual/Apply/Restore update private history, the canonical text/revision
columns and pending JSONB outbox in one transaction. Owner-only indexed search reads current text.
The publisher retries pending metadata-only transcript.revised notifications and acknowledges exact
event IDs; clients refetch on changes/reconnect and keep higher revisions against stale raw frames.
See transcript-revision.v1 and MIGRATION-0008 for schema/deployment order and delivery boundaries.

## Canonical transcript and conversation memory

Owner-only endpoints (gateway requires `tx`):

- `GET /transcripts/by-id/{meeting_id}/canonical` → `canonical-transcript.v1`.
- `GET /transcripts/by-id/{meeting_id}/memory` → `meeting-memory.v1`.

Both read finalized PostgreSQL transcript rows, correction history, the session speaker registry,
and the saved alignment/diarization jobs. The projection is persisted under the meeting row lock
in the existing JSONB carrier; raw ASR and audio are unchanged. Word and phrase times use the
source clock in milliseconds. Alignment is included only while its source hash/recording span
matches and the current text equals raw ASR. Corrected text uses segment timing until restored
or re-aligned; OOV words keep null times. Speaker overlap remains unknown.

A guarded sweep refreshes three meetings every five seconds, using a rotating cursor; opening
either endpoint refreshes that meeting immediately. A changed fingerprint increments the canonical
revision and writes metadata-only `meeting.memory.updated` to the transactional outbox. Repeated
reads do not create events. Terminal and Dashboard expose **Meeting memory**, refreshing while open.
Projections are omitted from generic meeting lists/details/shared responses and webhooks; artifact
deletion removes them. They are limited to 2000 finalized segments / 500000 source characters per
meeting; larger sources return 422 and the background sweep skips them.

Conversation windows group adjacent finalized segments, targeting 60 seconds / 6000 characters;
a single longer segment stays whole to preserve its evidence. Unchanged window fingerprints reuse
previous extraction. `rules.vi-en.v1` finds explicit Vietnamese/English commitments, decisions and
status phrases; questions and explicit negation before the cue are skipped. These are **candidates**,
not confirmed facts or semantic LLM extraction. Assignees and normalized deadlines remain unknown;
only an explicit deadline phrase is copied. Implicit commitments, paraphrases and topic-boundary
reasoning require a later evaluated extractor.

Every candidate has exact quote evidence with segment ID, current text revision, source times and
speaker identity. Editing/restoring text, renaming speakers, applying diarization or receiving late
finalized rows rebuilds the affected windows and removes obsolete candidates. The owner review
surface retains the audio playback and word-level attribution controls.

Gateway also forwards owner-scoped alignment status, start/cancel and aligned-segment audio routes
under `/transcripts/by-id/{meeting_id}/alignment`. Both clients use this same authenticated edge.

Verification (2026-10-23): targeted unit/contract/privacy checks, client type checks and production
builds passed. The disposable real-PostgreSQL probe is `tests/meeting_memory_postgres_smoke.py`
(requires a fresh `tina_memory_verify_*` DB and the identity schema source mounted under `/task/core`).
Live owner reads through Gateway, Terminal and Dashboard match the persisted projections;
another owner gets 404. Qwen/FSMN and Sherpa-ONNX processed a 12-second cached speech sample.
No fresh multi-speaker Google Meet capture was run. The architecture registry includes the three
new contract nodes and `clients/terminal/src/lib`, with the latter composed into Terminal.

## STT source authority

`foundation.py` validates and exports the meetings-owned
[stt-foundation.v1](../../../../../contracts/stt-foundation.v1/README.md) contract.
Owner `GET /transcripts/by-id/{id}/foundation` returns the durable native Bot source snapshot.
Owner `GET|PUT /transcripts/by-id/{id}/replicas/{meeting_uid}` reads/synchronizes a read-only source
replica in the meeting JSONB under the row lock. PUT requires receiver `expected_revision`; exact
retries are idempotent and old/revised raw history is refused. The source remains authoritative;
replicas do not overwrite native transcriptions, trigger AI extraction or copy audio. Replicas and
source snapshots are omitted from generic/share responses and removed on artifact deletion.

`job_revision.py` protects worker admission against an unexpected prior job ID. Completed alignment
results check per-segment expected_revision under the row lock and mark stale results explicitly.
The raw DB writer cannot relink an edited segment's source text, timestamps or session. Existing
owner edits/Restore and approved refinement continue through the shared revision implementation.
`transcript_storage` logevent records persistence time and Redis age/immutability delay separately.
# Canonical readable notes

`processed_notes.py` owns canonical-window fingerprints, bounded leases, source comparisons and
stale invalidation under the meeting row lock. The existing memory sweep claims durable work;
the isolated agent worker uses CompletionPort and returns candidates. Only approved candidates
enter `data.processed.views` and the public proc stream. Edit/restore/speaker rename revokes the
affected leases in the same mutation transaction. The revision outbox publishes current approved
or stale state, and readers compare publication revisions when merging REST and SSE.

## Audio quality review

`audio_quality.py` measures bounded saved PCM16 clips on an owner-triggered refinement job.
Low RMS, clipping, mostly quiet 20 ms frames and exact repeated phrases are advisory flags,
not calibrated confidence or a speech/noise classifier. Vietnamese diacritics are retained.
`RefinementOptions.mode` accepts `all` (existing default), `check` (no ASR/backend lookup)
and `flagged` (measure every eligible clip and decode only flagged ones). All modes use
the existing source clock, ownership, pause/cancel, revision and audio-hash protections.
No raw text/audio is changed; only ready ASR proposals can be explicitly applied.
