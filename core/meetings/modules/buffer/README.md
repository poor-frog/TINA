# @tina/transcribe-buffer — shared confirmation core and GMeet-compatible window

_meetings/ · module · deterministic agreement plus the reusable continuous Whisper window._

As a turn's unconfirmed window is re-submitted to Whisper, only the **words stable
across N consecutive passes** (default 3) are safe to confirm; the still-forming
tail stays pending. This brick is that decision — **pure, deterministic, no audio,
no I/O**. The driver owns the buffer, the cut, the turn lifecycle, naming, and
publishing; it calls `localAgreement(...)` to decide how many leading **whole**
segments confirm and carries the returned history.

- Never confirms a **partial** segment, and never past the **read audio window**.
- N=3 because live-mixed audio (Teams/Zoom AGC + jitter) makes a 2-pass agreement
  commit not-yet-settled text; the driver pairs it with a TTL idle-finalize so the
  stricter threshold never strands pending words.

`GmeetCompatibleBuffer` is the separate stateful surface reconstructed from Google Meet's
`SpeakerStreamManager`: per-speaker unconfirmed PCM, a two-second minimum call interval,
confirmed-text prompt feedback, segment-prefix LocalAgreement, identical-full-text fallback,
pending/final lifecycle, silence gate, hard cap, idle/terminal flush, and stale-response handling.

The default RMS floor is `0.0001` (-80 dBFS), matching `SpeakerStreamManager`.
It retains quiet speech while rejecting digital silence/near-zero residue. Explicit
thresholds keep their previous meaning; this energy floor does not replace backend VAD.

Its defaults are behaviorally parity-locked against the Google Meet source by
[`src/gmeet-compatible-buffer.parity.test.ts`](src/gmeet-compatible-buffer.parity.test.ts). Teams
imports the shared class now. Google Meet deliberately keeps its pipeline-local class for this
release; after Teams wins on diverse fixtures, a later release can switch Google Meet to this
package and delete the duplicate source.

Teams may adapt only caller-owned seams:

- timer scheduling is disabled in deterministic replay, while calls still pass through the same
  two-second manual interval seam;
- the post-prefix tail remains visible as pending;
- the timestamped batch-input gap guard is disabled because the CSRC adapter already owns and
  closes discontinuous virtual turns. This prevents `feedAudio` becoming an off-timer Whisper
  trigger. The default remains enabled for exact Google Meet parity.

## Surface

`GmeetCompatibleBuffer` · `gmeetCompatibleRms` · `localAgreement` · `words` ·
`longestCommonWordPrefix` · `commonWordPrefix` · types `GmeetCompatibleBufferConfig`,
`AgreementSegment`, `AgreementResult`. Front door: [`src/index.ts`](src/index.ts).

## Verify
```bash
pnpm --filter @tina/transcribe-buffer build
pnpm --filter @tina/transcribe-buffer test   # LocalAgreement + live-window parity locks
```
Covered by `gate:node` (build + test), `gate:isolation`, `gate:exports`, `gate:readme`.

## Source audio ring and timeline

`AudioRing` provides fixed Float32 PCM storage with a validity bitmap and independent sample-range
reads. `AudioTimelinePool` owns one ring per session/source and a host-wide source limit. Production
Desktop uses 30 seconds at 16 kHz and 16 simultaneous sources: 1,980,000 bytes per allocated ring
(1,920,000 PCM + 60,000-byte validity bitmap), at most 31,680,000 bytes of ring allocations. This excludes
ASR request snapshots and model working memory.

Frames with `startSample` use one source-local sample domain; capture epoch is calibrated once and
network receipt time is irrelevant. Duplicate prefixes are trimmed, missing samples remain holes,
and clock discontinuities retain their original capture timestamp for diagnostics. Legacy frames
without a counter are explicitly classified as legacy; their index is inferred and timing accuracy
is limited by the sender's clock. Reads return missing ranges instead of manufactured silence.

Desktop and Google Meet bot input use this core. The live ASR working window is also bounded to
30 seconds; older batch/replay APIs may retain up to 90 seconds explicitly. Pending turns are capped
at 32 per manager. Overload is reported and old responses cannot rewrite a newer buffer generation.
The mixed transcription algorithm retains its separate bounded 120-second working context; it has
not been replaced by the ingress ring. No ASR backend is converted to native streaming by this change.

Run the package tests for wrap, missing intervals, duplicates, overlap reads, bounds and source isolation.

At the ordinary cadence, coarse-segment streams reserve a cadence plus the latest frame duration
before the smaller of retained/window limits, then finalize an owned quiet-frame cut using the
existing capped-window path. Remaining PCM stays on its original timeline for the next request.
This mirrors Google Meet and prevents the live 30-second retention reset from erasing a continually
growing single ASR segment. A backend stalled beyond bounded retention still reports overflow;
there is no model, VAD, cadence or retention-limit change.
