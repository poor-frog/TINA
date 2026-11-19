# tests — meeting-api (L1 of the validation pyramid)

`uv run pytest -q` (driven by `gate:python`). Autonomous — no docker, no meeting, no network.
`conftest.py` provides the lifecycle.v1 goldens (loaded by path), a fake in-memory webhook
receiver, and a `fakeredis.aioredis` client.

| File | Level | Proves |
|---|---|---|
| `test_recording_golden.py` | L1 conformance | the Python `build_recording_master` reproduces every recording.v1 golden (loaded **by path** from `meetings/modules/recording/src/contracts/golden/`) byte-for-byte — same length + same sha256 as the Node twin. |
| `test_lifecycle_machine.py` | O-MTG-1 | the lifecycle.v1 goldens drive the FSM in legal order → correct transitions + terminal attribution (`failure_stage` server-derived); illegal transitions (`active→joining`, terminal re-open, active-first) are rejected. |
| `test_lifecycle_http.py` | O-MTG-1 | over FastAPI `TestClient`: POST each golden → `200 accepted`, FSM advances; posted events re-conform to the sealed schema (`_conforms`); illegal → `409`; malformed → `422`; `/health` live. |
| `test_webhook_signing.py` | O-MTG-2 | a verifier recomputing HMAC over `ts.payload` accepts a valid sig, rejects tampered (body/ts/secret/missing); built envelope + headers + `webhook.v1` goldens conform. |
| `test_webhook_delivery.py` | O-MTG-2 | 200→`delivered`; 500→`queued`→worker-sweep drains→`delivered`; unsubscribed per-client event `suppressed` (no HTTP); system scope ignores the filter; backoff respected; exhausted schedule drops. |
| `test_webhook_ssrf.py` | O-MTG-2 | localhost / loopback / link-local / private CIDRs / internal hostnames / non-http schemes / DNS-rebinding-to-private are blocked; public targets pass; the sink short-circuits a blocked URL without touching the transport. |

Audio-review coverage in `test_bot_refinement.py` checks check-only operation without
credentials/inference, selective ASR, immutable originals, non-applicable checked items,
quiet/clipped PCM, invalid audio and Vietnamese accent-preserving repetition flags.

Text/audio evidence regressions also cover punctuation/decomposed Vietnamese loops,
short replies/numbers, low volume without quiet-frame corroboration, and a mostly
quiet clip containing an audible burst. These are advisory checks, not a speech
classifier or accuracy benchmark. Second-pass tests assert separate source/proposal
evidence, unchanged original playback/document, owner isolation, persisted reads
after worker recreation, selective ASR for text-only flags, and explicit Apply/Restore.

Local Docker/browser smoke, 2026-11-05: a disposable owner fixture paired repeated
text with digital silence and with a normal-energy tone. Check audio returned
`text_and_quiet_audio` versus `text_flag`, with no ASR requests or text revisions.
Terminal and Dashboard displayed the saved checks; the source player loaded the
3-second clip. The fixture and its storage object were removed. This validates
the diagnostic flow, not recognition accuracy or speech detection.
The recording integration tests require FFmpeg on PATH.

Local Docker smoke, 2026-11-05: Terminal -> gateway -> Meeting API -> object storage
was exercised with an isolated copy of a 6.07-second saved Vietnamese speech clip.
Controls used the original, 0.01x amplitude, deliberately clipped amplitude and an
added repeated-text marker; these controls do not establish recognition accuracy.
Check-only completed four items without increasing either ASR worker's request count.
The flagged pass made exactly three VieGem CUDA requests and skipped the unflagged
original. The browser filter showed three of four items, source audio played, and
explicit Apply then Restore produced revisions 1/2 with immutable raw text.
The source meeting's JSONB/transcription snapshot hash was unchanged; the temporary
meeting and its independently stored recording were removed after verification.

Manual retry tests inject authentication, busy, timeout, connection, server/rejection
and invalid-response failures; verify sanitized reasons, credential refresh, owner
checks, preserved ready/applied/checked items, and refusal on source/config/job drift.

Failed-only retry Docker smoke, 2026-11-05: with no active meeting or ASR request,
the local VieGem worker was briefly stopped for an isolated four-clip verification
meeting. Flagged refinement retained one checked item and returned three sanitized
`asr_unavailable` failures. After restarting VieGem and waiting for readiness, the
browser's Retry failed segments action produced exactly three successful ASR requests,
retained the checked item unchanged, and exposed ready proposals with two attempts each.
The original source meeting snapshot was unchanged; the test meeting/audio were removed.

`test_refinement_audio.py` verifies bounded opt-in gain, PCM headroom, quiet/clipped
negative controls, byte-identical skips, and exact sample retention when adjacent
saved-recording spans are decoded through FFmpeg (including first/last samples).
Its accent-preserving CER/token/edge metrics and A/B-report privacy checks use mocked
ASR replies, not claims about model accuracy. `test_bot_refinement.py` additionally
checks original playback/hash/Apply/Restore with prepared ASR input, strict opt-in,
check-only rejection and identical prepared-input replay during manual retry.

Local A/B probe, 2026-11-05: six distinct `google/fleurs` vi_vn/test recordings plus
six copies scaled to RMS 0.002 (12 correlated cases), using the published reference
transcripts and the existing `5CD-AI/VieGem-ASR` CUDA worker. Same PCM16 conversion
was used for baseline/prepared inputs; no model, language or vocabulary was changed.
Seven cases received bounded gain, five reused identical input: 19 actual ASR requests.
Across 1006 reference characters, observed errors were 38 -> 30 (CER 3.78% -> 2.98%):
three cases improved, nine tied, none worsened. This small read-speech/control sample
is not a meeting benchmark or evidence for enabling gain by default. Opt-in stays off.
References/audio/reports are outside Git; recordings/application data were not modified.
Dataset attribution: Google FLEURS, CC BY 4.0,
https://huggingface.co/datasets/google/fleurs (vi_vn/test). Source WAV filenames:
10057024225045006889.wav, 10072308967409148015.wav,
10078277432407694754.wav, 10093159547857080890.wav, 1015279164912843543.wav, 1015563747297542961.wav.

WebM/Opus regression: compare first/tail probe alignment of subsecond and later
coarse-seek cuts against the full decode, within the 1 ms container source clock.
The former direct seek produced a 208-sample (13 ms) short full decode on the
9-second fixture; the new timestamp-preserving cut retains coverage. A missing
10 ms WAV tail is rejected rather than returned as successful audio. These are
signal/timing checks, not a claim that every recognized word is now correct.

Prepared-audio Apply tests validate transcript-document.v1 and retain the prepared-input provenance through Restore and a new check-only job.

test_voice_navigation.py covers source-open intent/ambiguity, heard caller scope, owner claims and late/revoked/stopped navigation fences.

`test_audio_bridge.py` checks the selected ASR model's session-bound bridge route, signed capability,
Stop/new-session revocation, and refusal of invalid bridge configuration before any meeting is inserted.
The permit also distinguishes enabled room voice from transcript-only access for the VAD observer.

`test_task_flow.py` checks Pipecat flow reservation order, core-owned state, exact completed-prompt receipts, caller/policy/expiry isolation and Stop fencing late extraction.

Recovery cases distinguish service failure from unmatched input, retain task state without charging retries, and use failed-TTS recovery only to re-ask before consuming another slot.

`test_voice_handoff.py` exercises owner-only claim/read, preserved task fields, idempotent claim without draft creation, expiry, Stop, replacement turns/sessions, task-state changes, active leases, revoked sources and deleted artifacts.

`test_decision_flow.py` checks caller isolation, correct decision endpoint dispatch, finalization, unknown-speaker refusal, late-plan Stop fencing and decision-to-chat state transfer.

`test_decision_flow.py` distinguishes stale-source 409 recovery from unknown-write 503 recovery and checks that uncertain task writes receive the same retry-blocking marker as decisions.

Decision readback regression cases cover current proof receipts, source edits after plan/apply, source-service outage preserving fields, and Stop during source revalidation.

`test_google_calendar_sync.py` drives Google snapshots through the production parser/reconciler
with an in-memory store: removed/restored links, multi-calendar room/time authority, manual/live
ownership, detached-link reuse, collisions, all-day timezone/date retention and finished occurrences.
It makes no Google API calls and starts no meeting bot.
