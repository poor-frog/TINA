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
