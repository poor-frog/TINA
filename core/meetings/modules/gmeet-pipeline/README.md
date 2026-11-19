# @tina/gmeet-pipeline — the gmeet lane (channel-routed)

_meetings/ · module · `gmeet-capture.v1` (named per-channel audio) → `transcript.v1`._

Google Meet delivers each active speaker on a **separate channel**, so audio is
routed by channel: two people talking at once land on separate per-channel streams
and are transcribed **independently** — no muddling, onsets intact. The glow names
each channel-**turn**, bound at the turn's onset and held through overlap. Identity
is **carried** (bound at capture), never derived — no diarizer, no post-hoc namer.
Contrast [`mixed-pipeline`](../) (one mixed stream, names from hints).

Each `(channel, turn)` is its own stream over the pipeline-local `SpeakerStreamManager`
([`buffer`](../buffer/) contains its parity-locked shared successor; [`whisper`](../whisper/)
supplies stt.v1),
emitting **sealed `transcript.v1`** segments to a `TranscriptSink`. The host wraps
those into the bus envelopes.

Google Meet retains its pipeline-local manager. The shared `GmeetCompatibleBuffer`
keeps matching defaults and behavior under parity tests, including the quiet-speech
energy floor; replacing the duplicate implementation is a separate change.

## Surface
`createGmeetPipeline` · `SpeakerStreamManager` · `isHallucination` · `setLogger` ·
types `GmeetPipeline(Options)`, `TranscriptSegment`, `TranscriptSink`, `Source`.
Front door: [`src/index.ts`](src/index.ts).

## Verify
```bash
pnpm --filter @tina/gmeet-pipeline build
pnpm --filter @tina/gmeet-pipeline test
```
Three goldens:
- `hallucination-filter.test.ts` — phrase-list + structural junk drop (offline).
- `pipeline-conformance.test.ts` — the **conformance** gate: drive the pipeline with a
  **stub** Whisper and validate every emitted segment against the **sealed**
  `transcript.v1` schema (offline, deterministic).
- `pipeline-realstt.live.test.ts` — the **real-STT** gate: feed known TTS clips through
  the spine + the live transcription service, assert glow-attributed, schema-valid
  `transcript.v1`. Skips without `TINA_TX_KEY` + `EVAL_CACHE` (same skip-where-no-backend
  pattern as the runtime docker/k8s tests; turbo passes those env through).

The remaining live path (real Meet *page* audio → capture → this spine) is the bot's job (3.3+).
Covered by `gate:node`, `gate:isolation`, `gate:exports`, `gate:readme`.

## Capture timestamps

Timestamped frames anchor a channel window to capture time. Confirming text advances
that window by the duration of audio removed, independent of STT response latency.
The timestamped-input discontinuity guard starts a fresh window after a gap over
two seconds; missing capture audio is not reconstructed by timestamp correction.
A feeder whose frames carry capture-callback stamps (Zoom per-track capture) sets
`callbackStampedFrames`: the guard then measures the gap between consecutive frames, because
late or lost callbacks space those stamps wider than the audio they carry. Its turn close also
finalizes only a transcript that covers every buffered sample, and otherwise submits the whole
window as the final one. Its segment and window times come from each frame's own stamp,
so a turn whose frames cover only part of its wall time keeps its timeline; at the 30 s cap the
window up to its quietest late frame is finalized from its own request and the rest stays buffered.

The optional third `transcribe` argument carries capture-to-submit lag using the submitted window's
last sample on this same capture clock. It is a producer estimate; hardware capture latency is not
measured, and no speaker identity is included in the diagnostic metadata.

## Quiet speech

The default pre-ASR RMS floor is `0.0001` (-80 dBFS). The former `0.0025` default
dropped human-recorded FLEURS speech at RMS `0.000814` before either ASR backend could
hear it. This floor rejects digital silence and near-zero quantization residue; it
does not classify speech. Backend VAD and the existing hallucination filter remain
responsible for non-speech above the floor. Explicit `silenceRmsThreshold` settings
(including `0`, disabling the gate) retain their previous meaning. The shared
`GmeetCompatibleBuffer` uses the same default and is checked for parity.

The host may supply `config.hallucinationFilter(text)` to the speaker-stream manager; every
confirmation/flush branch uses that policy. The default remains `isHallucination`. Desktop's
archive recovery selects its existing mixed speech filter so a valid short reply is not lost
solely due to word length. The module does not import the mixed pipeline or change live callers.

The speech filter preserves short replies and numbers; text length alone never rejects speech.
Punctuation-only output, known phrase-list artifacts and repetition loops remain filtered.

## Audio tail and long-session regression

Live ASR windows and voice endpoints use each frame's `sourceCaptureMs` so device-clock
corrections remain aligned with VAD. The audio archive retains its fixed indexed sample
clock. `src/voice-endpoint.test.ts` exercises drift between these clocks and verifies that
the final ASR result reaches the speech endpoint while all captured samples are retained.

`npm test` includes `src/stream-integrity.test.ts`. It exercises the shipped pipeline at 16 kHz
with 64 ms frames and unchanged window defaults: short/partial final frames, a delayed request
missing its tail, repeated endpoints, the exact 30-second boundary, speaker rotations, and explicit
overflow/stale-result rejection. A 120-second, three-channel deterministic soak checks every PCM
marker reaches confirmed text once and ring allocations release on disposal.

For a longer accelerated run with forced GC and sampled heap/ArrayBuffer/RSS measurements:

```sh
cd core/meetings/modules/gmeet-pipeline
TINA_ASR_SOAK_SECONDS=7200 npm run test:soak
```

The report is one content-free `synthetic_asr_soak` JSON line. Retained heap and ArrayBuffer growth
after warm-up must stay under 16 MiB; ring allocations must stay within three 30-second rings and
return to zero after disposal. RSS includes allocator/JIT reservations and is reported separately.
This is accelerated PCM replay with a marker recognizer, not two hours of wall-clock operation or
real-model WER/latency qualification. Actual backend stalls past retention remain explicit overflow,
not lossless recovery. No ASR/VAD model, silence, cadence or window setting is changed.

A backend returning one growing segment can prevent LocalAgreement from confirming any complete
segment before the live retention fills. At the regular cadence, the buffer now reserves one cadence
plus the latest capture-frame duration before the smaller of retention/max-window limits. It submits
an owned cut at the quietest frame in the last four seconds and uses the existing capped-final path
to confirm that exact response and retain all audio after the cut. Both manager implementations use
the same policy; no model, window maximum, frame size or submission interval changes.

`TINA_ASR_SOAK_COARSE=1 TINA_ASR_SOAK_SECONDS=7200 npm run test:soak` runs the coarse-segment
regression for three channels. Coverage tests also exercise timer/frame phase drift, delayed cut
responses, repeated markers and stale result rejection. A backend stall exceeding bounded retention
can still cause explicit overflow; this is not an unbounded lossless queue. The existing repetition
filter remains authoritative and can reject highly repetitive synthetic speech independently of
buffer rollover. Successful HTTP responses alone do not establish complete transcript coverage.
