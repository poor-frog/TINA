# ASR system benchmark / Đánh giá ASR

`noise_ab.py` is the opt-in WebRTC NS Low experiment. `prepare` selects the first ten VI/five EN
test entries by the existing frozen FLEURS selection index, adds seeded synthetic colored noise at
10 dB SNR, appends an existing private meeting manifest and adds silence/noise-only controls. No
new dataset download occurs. `filter` runs inside the Linux bot runtime with the pinned C shim;
it verifies the 96-sample impulse latency, compensates it and asserts exact per-clip sample counts.
`evaluate --model viegem|gipformer` reuses the unchanged local engines in both conditions and
alternates off/low order. `score` uses this folder's existing accent-preserving WER/CER scorer.
Audio, references and hypotheses stay in the private external directory; the output report contains
only counts/hashes/timing. No service, account preference or meeting policy is changed by evaluation.

```sh
.venv/viegem/bin/python deploy/transcription/benchmark/noise_ab.py prepare /private/ns-eval \
  --fleurs /private/fleurs/manifest.json --meeting /private/meeting-clips/manifest.json
# In the built bot image, mount the repository read-only at /repo and private ns-eval at /eval:
# /opt/tina-voice/bin/python /repo/deploy/transcription/benchmark/noise_ab.py filter /eval
TINA_VIEGEM_DEVICE=mps HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/viegem/bin/python deploy/transcription/benchmark/noise_ab.py evaluate /private/ns-eval \
  --model viegem --output output/meeting-voice/ns-ab-viegem.json
```

These are small whole-window ASR comparisons, not proof of live-meeting quality, wake recall,
keyboard/fan removal or CUDA performance. NS was off during the original trial. The owner later requested it on for new capable Google Meet
rooms; this default change is not new accuracy evidence.

`capture_frames.py` compares 4096/1024-sample delivery to native Silero using the same private mono
16 kHz clips (up to 12 seconds), with 1.5 seconds of zero tail padded to a common full frame boundary.
It verifies exact PCM hashes/order, counts frames, measures first endpoint delivery and replay/native
VAD process CPU. This CPU measure includes Python IPC encoding but excludes browser/Playwright and
the total bot. Optional `--asr-engine viegem|gipformer` evaluates each first-endpoint window through
the unchanged pinned local engine; no service or account preference is started/changed.
Reports contain hashes/counts/timings, never transcript text, tokens or private source paths.

```sh
TINA_VIEGEM_DEVICE=mps HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/viegem/bin/python deploy/transcription/benchmark/capture_frames.py \
  /private/manifest.json output/meeting-voice/frame-ab.json \
  --vad-directory /private/pinned-vad-cache --asr-engine viegem
.venv/viegem/bin/python -m unittest discover -s deploy/transcription/benchmark -p test_capture_frames.py
```

This is a packetization/VAD experiment, not streaming LocalAgreement or a labeled WER/wake-recall
benchmark. Complete-frame padding avoids conflating a finite file's unsent partial last frame with
missing samples inside the replay; real Worklet stream teardown can still discard its partial tail.

This harness measures the existing loopback transcription APIs against **human-recorded**
FLEURS Vietnamese/English test audio. It is separate from the mixed-speaker tape-loss oracle
in `core/meetings/eval`: that oracle compares live output against another ASR pass, whereas
this benchmark scores against the dataset's reference transcripts.

## Design fixed before measurement

- Dataset: `google/fleurs`, CC-BY-4.0, [official card](https://huggingface.co/datasets/google/fleurs).
- Source revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`; Parquet revision
  `168de341b3db6859a9bac1c50a2ef5e3b47647e0`. Both source files have pinned LFS SHA-256 values.
- 100 test utterances per language, seed `20261019`, no quality-based replacement. Two
  other test clips per language are reserved for warmup and excluded from metrics.
- Three generated zero-PCM clips (2/5/10 s) measure nonempty output on silence; excluded
  from speech WER/CER. No TTS substitutes for the human-recorded accuracy benchmark.
- Each configuration processes the identical frozen manifest/order: auto language,
  alias `custom`, verbose JSON, no context prompt, concurrency one, no retry.
- Compare native Sherpa/Qwen INT8/Silero/CPU against FunASR/Qwen/FSMN/reported MPS. This
  is a **system** comparison, not a controlled test of VAD, quantization or runtime alone.
- WER uses whitespace tokens (syllable-style Vietnamese); CER removes whitespace.
  Normalization preserves accents/digits, applies NFC/casefold, and removes punctuation
  except in-word apostrophes. Failed requests are empty hypotheses, not silently excluded.
- Client latency and aggregate RTF are whole-WAV API measurements. Per-request RSS
  includes descendants, sampled at 100 ms; it is not full GPU/unified-memory accounting.
- A second tier replays 5 fixed test clips per language into real ephemeral Desktop
  instances, one clip/session at a time, with 100 ms capture.v1 packets at real-time speed.
  It measures first nonempty transcript, finalization tail, and final transcript errors.
  It does not measure real microphone/system hardware, speaker attribution or UI paint.

## Run

From the repository root (requires existing Sherpa/FunASR environments and model caches):

```sh
uv venv .venv/asr-benchmark --python 3.11
uv pip install --python .venv/asr-benchmark/bin/python -r deploy/transcription/benchmark/requirements.txt
.venv/asr-benchmark/bin/python -m unittest discover -s deploy/transcription/benchmark -p 'test_*.py'
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/prepare.py ~/tina-test-rig/asr-benchmark/fleurs-20261019
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/run.py ~/tina-test-rig/asr-benchmark/fleurs-20261019 ~/tina-test-rig/asr-benchmark/run-20261019-01
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/report.py ~/tina-test-rig/asr-benchmark/run-20261019-01
```

Use a new result directory per run; existing results are never overwritten. Dataset files,
transcripts, results and logs stay **outside Git**. Preparation verifies source/audio hashes
and downloads only the two test-language shards (~1.1 GB), not the 102-language dataset.

`run.py` checks that Desktop has no live captures, Sherpa is idle and is the expected
executable, and no second ASR listener is running. It restarts services one at a time for
process-start timing and restores Sherpa in `finally`. Terminal's/global/backend settings
are not rewritten, Desktop is not restarted, and its RAM meeting store is preserved.
The configured ASR endpoint may be unavailable during the other profile's measurement.
Avoid starting real capture/dictation while the benchmark is running.

If startup fails before a profile begins, `run.py CACHE OUTPUT --resume` may preserve
completed profiles when the dataset, host and service fingerprints still match. A completed
profile needs all 207 direct rows and 10 replay rows. Incomplete measured profiles are never
overwritten or spliced together; use a new result directory for those. Resume history stays
in metadata. FunASR starts by its registered model name with HF offline mode and a verified
cache revision (`5eb144179a02acc5e5ba31e748d22b0cf3e303b0`), not a raw snapshot path.

## Interpreting results

Report individual languages, failures and silent controls separately. Do not add stage
percentiles or call whole-file response time "live latency". This random pilot is not a full
official FLEURS score; one run/order does not establish stable thermal/background-load
performance or independent-speaker confidence bounds. Source files remain cached for reuse.

No English–Vietnamese code-switching score is claimed: FLEURS language subsets are monolingual.
CanVEC requires access from its authors; this harness does not contact them or upload user audio.
Real code switching, timestamp alignment, echo and overlapping speakers need separate references.

## Tiếng Việt

Benchmark dùng cùng 100 clip Việt và 100 clip Anh có transcript chuẩn cho hai cấu hình.
Dữ liệu/báo cáo nằm ngoài Git; chỉ chạy một ASR mỗi lần và khôi phục Sherpa sau khi đo.
Lỗi HTTP vẫn được tính là mất toàn bộ từ của clip, không bỏ khỏi mẫu. Replay dùng Desktop
tạm trên cổng loopback riêng, không thu microphone, không mở cuộc họp và không xóa lịch sử.
WER tiếng Việt ở đây tính theo token cách nhau bởi khoảng trắng; CER giữ nguyên dấu.
Kết quả không đủ kết luận về Anh–Việt xen kẽ hoặc người nói chồng lấn trong họp thực tế.

## Live versus post-meeting refinement

`refinement.py` uses the existing FunASR listener on 127.0.0.1:18000 without restarting services or changing settings. It freezes 20 clips each from cached FLEURS VI/EN, Common Voice VI and LibriSpeech test-other; eight first-60s AMI excerpts (four meetings × two microphones); eight VI/EN concatenation controls (four shared source pairs × two orders); and five nonspeech controls. The concatenations are **not natural code switching**. Dataset preparation requires the existing manifests, not new downloads. Use a fresh output directory:

```sh
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/refinement.py prepare ~/tina-test-rig/asr-benchmark ~/tina-test-rig/refinement-NEW
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/refinement.py run ~/tina-test-rig/refinement-NEW
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/refinement.py report ~/tina-test-rig/refinement-NEW
```

`replay.mjs --refinement` streams every frozen case in real time into an isolated Desktop, snapshots live confirmed text, then calls the actual refinement start/status API. It never applies proposals. The candidate transcript hypothetically accepts all ready suggestions, retaining raw live text for missing/failed/skipped suggestions. This is not a simulation of selective human review. Live always precedes refinement because source segments come from live; warm-history/time ordering is a limitation. Waits between clips if the real Desktop has active capture; do not interpret digital replay as hardware/UI latency.

Stage RSS includes each process and descendants sampled at 100 ms, not full Metal/unified-memory allocation. Reports separate first-text/finalization time from extra post-meeting work. WER/CER use `metrics.py`; all failures remain in the paired sample. Bootstrap is paired by clip, grouped by meeting or shared synthetic source pair when applicable, not an independent-speaker confidence interval. A partial run cannot be presented as complete. Results include per-clip CSV, raw JSONL, job coverage/states, source hashes, RSS and production-history preservation.

## Recheck the quiet-speech gate

After building the changed Desktop dependencies, replay the exact 10 baseline clips
with the three original silence controls plus PCM16 quantization residue and quiet
white noise above the new RMS floor:

```sh
pnpm --filter '@tina/desktop...' build
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/recheck-gate.py \
  ~/tina-test-rig/asr-benchmark/fleurs-20261019 \
  ~/tina-test-rig/asr-benchmark/run-20261019-01 \
  ~/tina-test-rig/asr-benchmark/rms-fix-20261020-01
```

The original manifest/audio/results remain unchanged. The recheck stores baseline
hashes, new source/build fingerprints and separate control WAVs in its own output
directory. Each backend runs alone and Sherpa is restored afterwards. It warms on
the original four warmup clips; the original baseline had 200 direct cases before
replay, so before/after latency comparisons are exploratory. `replay.mjs --controls`
includes controls only when explicitly requested; the original 10-clip mode remains
the default. A higher RMS floor explicitly configured by a caller is not overridden.

## Fixed vocabulary pilot

`glossary.py` compares the same cached waveform without context and with the fixed domain vocabulary
in `glossary.json`. Pair order is counterbalanced; failed requests remain in WER/CER. It reuses the
running FunASR process and does not Apply proposals or change settings. It adds eight macOS TTS domain
clips (Linh/Samantha) as explicitly synthetic name/terminology checks; these do not establish human
speech or natural code-switching quality. Whole-clip response time is not live caption latency, and
60-second AMI requests are not the bounded production refinement flow. Use a fresh output directory:

```sh
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/glossary.py prepare BASELINE/manifest.json OUTPUT
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/glossary.py run OUTPUT
```

Vocabulary remains opt-in. Do not derive hints from evaluation references or auto-replace raw words.

## Synthetic meeting pipeline E2E

`meeting_e2e.py` generates a 69-second controlled meeting with macOS voices Linh (VI),
Daniel and Samantha (EN): 15 turns, explicit actions/decisions/facts, negative controls,
and two long pauses. It replays fixed 8-second windows in real time to the existing
Qwen/FSMN worker, writes through the production transcript store, and drives the real
Meeting API diarization, alignment, canonical, memory, rename and edit/restore routes.

The runner uses a fresh `tina_memory_verify_*` PostgreSQL database, the real schema,
production recording adapters and a unique temporary MinIO prefix. It removes the test
objects and database in cleanup. It reads the running `tina-verify-20261015` container's
configuration privately; it never changes user meetings, worker settings or real audio.
No new dependency is needed beyond the existing `.venv/asr-benchmark` and Docker images.

```sh
.venv/asr-benchmark/bin/python -m unittest discover -s deploy/transcription/benchmark -p test_meeting_e2e.py
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/meeting_e2e.py prepare ~/tina-test-rig/meeting-e2e-FRESH
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/meeting_e2e.py run ~/tina-test-rig/meeting-e2e-FRESH
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/meeting_e2e.py report ~/tina-test-rig/meeting-e2e-FRESH
```

Use a fresh output directory. `pipeline.json` holds source snapshots, stage latencies,
owner/revision/evidence checks; `summary.json` and `REPORT.md` add accent-preserving
whitespace WER/CER, best-permutation anonymous speaker scores with a 250 ms collar,
alignment coverage and utterance-level timing outliers. Known speaker count is supplied,
and merged voices still count as confusion. A renamed identity must own actual words.

This is synthetic turn-taking, not a human-speaker benchmark, natural within-speaker
code switching, acoustic capture or overlapping speech. API routes use an in-process HTTP
transport; PostgreSQL, MinIO and all model workers are real. Browser/gateway/Meet transport
are excluded. Request-to-durable latency includes inference and persistence; first-caption
waiting includes the 8-second capture window. MFA uses its Vietnamese model on the mixed
text, so English/OOV words can remain untimed. There is no independent word-boundary truth:
valid bounds or a word midpoint inside its source utterance do not establish phonetic MAE.
Extraction candidates are printed for inspection; exact evidence checks prove provenance,
not semantic extraction precision.

### Boundary regression A/B

For a frozen existing fixture, copy only its `meeting.wav` and `manifest.json` into a fresh directory.
Build `@tina/transcribe-buffer`, then run `node deploy/transcription/benchmark/meeting_e2e_windows.mjs
OUTPUT` before the normal `meeting_e2e.py run OUTPUT`. The planner imports the production `silenceCut`
helper, uses only PCM energy, preserves contiguous sample coverage and records when enough audio has
actually arrived. A missing pause grows the window up to 25 seconds; final EOF always flushes the rest.
It never uses the reference text or TTS speaker/turn annotations. The report records variable window
lengths and distinguishes this mode from the original fixed 8-second control.

## STT foundation verification

`core/meetings/services/desktop/src/foundation-soak.ts` provides a separate accelerated one-hour
source-clock integrity test (`pnpm --filter @tina/desktop test:soak`, fresh external `TINA_SOAK_OUTPUT`).
It verifies actual SQLite PCM receipt, SIGKILL/replay, all source bytes, exact playback and revision
continuity. It intentionally makes no real-model or microphone latency claim.
`foundation_postgres.py` consumes that `foundation.json` through the production owner routes and
actual SQLAlchemy PostgreSQL adapter in a **disposable** `tina_stt_verify_*` database. Invoke it with
`INPUT.json OUTPUT.json`, `PYTHONPATH=core/meetings/services/meeting-api/src` and private DB_* env
inside the existing Meeting API image with the repo source mounted. It refuses any other DB name;
create/drop the temporary database in the caller's try/finally. Do not run against a user database.
Tests include concurrent CAS, owner isolation, idempotence, immutable source history, stale worker
rejection and separation of Desktop authority from the Bot's canonical transcript.

## Real-recording acceptance and latency

`acceptance_replay.mjs MANIFEST.json FRESH_OUTPUT` uses a frozen SHA-256 manifest with
`audio_path`, `audio_sha256`, `meeting_id` and `purpose` (`smoke` or `acceptance`). Acceptance
requires one continuous 45–60 minute mono PCM16/16 kHz WAV. It paces real audio through scratch
Desktop, reconnects with exact-range ACK/replay, compares all archived PCM and checks post-stop
edit/CAS/Restore. It refuses to run while the production Desktop is capturing. Keep artifacts
outside the checkout; do not reuse a previous output directory.
After Stop, it saves `document-at-stop.json` and waits up to 180 seconds for recovery to settle;
`stop_response_seconds` and settled `stop_tail_seconds` are separate. A timeout leaves the run
incomplete. Earlier artifacts that closed without this wait remain unchanged, and their pending
recovery must not be compared as though they were fully settled acceptance runs.

`acceptance_report.py OUTPUT` reads the committed journal after close and the frozen reference
artifacts. It reports WER/CER, selective reference latency coverage, unfinished recovery and
post-warmup RSS separately. Tests: `.venv/asr-benchmark/bin/python -m unittest discover -s
deploy/transcription/benchmark -p test_acceptance_report.py`. See the dated
[investigation](../../../docs/research/caption-latency-investigation-20261024.md) and
[proposed acceptance thresholds](../../../docs/research/stt-roadmap-20261024.md) for scope.

`caption_latency.ts` uses Node's virtual clock and the production Gmeet pipeline with a synthetic
oracle to isolate min-audio, timer, idle and confirmation waits. It does not score ASR quality.

### Paired quality investigation

With the already downloaded AMI acceptance fixture and built Desktop/ASR client:

```sh
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/quality_ab.py prepare BASELINE_ROOT FRESH_OUTPUT
node deploy/transcription/benchmark/quality_ab.mjs FRESH_OUTPUT
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/quality_ab.py report FRESH_OUTPUT
node deploy/transcription/benchmark/quality_prompt_probe.mjs FRESH_OUTPUT
```

Selection is frozen before inference: two lowest and two highest annotated overlap among
disjoint 60-second bins with at least 100 reference words. Four excerpts total 240 seconds; they
are diagnostic extremes, not another 49-minute acceptance run. The direct arm uses consecutive
15-second HTTP windows without prompts. The live arm uses the existing scratch Desktop replay,
real Pyannote, WS/SQLite, Stop and halfway reconnect, with a transparent loopback HTTP proxy.
The proxy preserves request bodies and records PCM hashes, uniquely matched sample ranges,
prompt, raw responses and HTTP errors outside Git. Ambiguous/non-contiguous matches stay explicit.
`acceptance_replay.mjs` accepts an optional third loopback-ASR-proxy argument for this purpose;
its default endpoint and real-worker/production-capture guards remain unchanged.

The report sums error/reference counts per excerpt, preventing words from aligning across disjoint
clips. It separates substitutions/deletions/insertions, audio coverage and exact string matches
in raw responses versus final output. Those string alignments are diagnostic and can be ambiguous
for overlap/repetition. Different windows, prompts and confirmation prevent treating the WER
difference alone as a causal estimate. The prompt probe freezes the first two sub-second requests
and one 2–5-second control with context per excerpt, verifies identical PCM hashes, then varies
only the prompt. Production settings are not changed. Output reuse is refused; interrupted runs
remain incomplete and must not be scored as complete.

Checks: `.venv/asr-benchmark/bin/python -m unittest discover -s deploy/transcription/benchmark
-p test_quality_ab.py` and `node --test deploy/transcription/benchmark/quality_ab.test.mjs`.

`context_policy.mjs PLAN.json FRESH_OUTPUT` compares unconditional inherited prompts against the
production `continuityPrompt` selector, using frozen source WAV hashes and request PCM hashes.
Each plan case supplies `id`, `kind`, `audio_path`, `audio_sha256`, `pcm_sha256`, `language`,
`reference`, `prompt` and optional source `start_sample`/`end_sample`. PCM must be mono PCM16/16 kHz.
It refuses reuse, pauses no user service, and stops if production capture or the shared ASR queue
is active. Cases with identical request parameters share a decode and are marked `shared_decode`;
their duplicated result must not be presented as independent quality/latency evidence. Partial
phone/overlap windows and synthetic repetition/name controls need separate interpretation.

`deletion_audit.py COMPLETE_QUALITY_OUTPUT FRESH_REPORT.json` aligns final deletions against
each exact submitted PCM window and its raw response, recording overlap, filler and clipped-word
annotations. Raw matches can be revised hypotheses or ambiguous repeated words; they are not
automatically publication bugs. Tests: `python -m unittest discover -s
deploy/transcription/benchmark -p test_deletion_audit.py` in the benchmark environment.

`audio_context_probe.mjs PLAN.json FRESH_OUTPUT` compares frozen `original_samples` and
`context_samples` from a source WAV verified by `audio_sha256`; `request_pcm_sha256` verifies
the original request. It never publishes transcript or changes source ranges. Extra context may
decode words outside the original range; without word timestamps those words cannot safely be
assigned to the original segment. Runtime asserts check ranges, hashes and idle services; failed
runs remain incomplete. See [deletion investigation](../../../docs/research/stt-deletion-20261025.md).

### Mixed audio versus native headsets

`mixed_speaker.py prepare SOURCE_DIR FRESH_EXTERNAL_EXPERIMENT` reads a verified
`source-manifest.json` in SOURCE_DIR's parent, original AMI individual headsets/mix, and manual
annotations ZIP. It validates microphone mapping/sample clocks, selects annotation-stratified
10-second windows before inference, freezes references/hashes and a randomized three-repeat
schedule. No audio separation algorithm is used. Controlled mix is the exact integer sum of
native channels quantized at a common 1/4 gain; the same components are the per-channel inputs.
Official mix is an auxiliary arm because its preprocessing is not known to be identical.

```sh
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/mixed_speaker.py prepare SOURCE_DIR FRESH_EXTERNAL_EXPERIMENT
node deploy/transcription/benchmark/mixed_speaker.mjs FRESH_EXTERNAL_EXPERIMENT
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/mixed_speaker.py report FRESH_EXTERNAL_EXPERIMENT
```

The runner refuses reuse, waits for no user capture/ASR work, pins the existing worker and
runtime hashes, records exact wire PCM/raw HTTP/client/final text, and never restarts services.
Finalization is a scratch one-window Gmeet engine using the Desktop recovery filter policy;
cached replies may be used only for byte-identical PCM. This is not a live scheduling,
multi-window dedup, SQLite, revision or UI acceptance test.

Mixed WER is a diagnostic oracle minimum over reference word interleavings that preserve each
speaker's word order and all non-overlapping time relations. Hypothesis tokens are consumed once;
CER uses the chosen WER-optimal whole-word order. It is not official AMI/cpWER and is optimistic
for the mixed arm. Headset outputs are scored separately against their own speaker references;
active-channel primary totals and inactive-channel false insertions stay distinct. Native close-talk
microphones can contain other voices. Repeated requests are repeatability checks, not independent
meetings. Tests include independent exhaustive valid-order enumeration:
`python -m unittest discover -s deploy/transcription/benchmark -p test_mixed_speaker.py` in the
benchmark environment. See [experiment and limits](../../../docs/research/stt-mixed-speaker-20261026.md).

The scratch VAD worker supports frozen `trace-only`, `mixed-only`, `mixed-plus-headsets`,
`all-sources`, and warmup-only `probe-only` schedules. `trace-only` sends one FSMN-on request for
each of the 12 controlled-mix windows, records VAD ranges, and also runs Qwen once. `mixed-only`
pairs mixed/FSMN-on with mixed/VAD-off for three repeats. `mixed-plus-headsets` adds the four
native headset tracks with FSMN on; that schedule is 216 HTTP calls. Example for the
independent-meeting comparison:

For a meeting not already fully cached, `prepare_mixed_speaker_ranges.py MEETING ANNOTATION_ZIP
FRESH_EXPERIMENT` selects windows from manual annotations first, then fetches only exact PCM byte
ranges for the mix and four headset WAVs. It pins ETag, Content-Range, sample offsets, and SHA-256
per range. The resulting plan can be passed to the paired runner:

```sh
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/prepare_mixed_speaker_ranges.py EN2001b ANNOTATION_ZIP FRESH_EXPERIMENT
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/prepare_vad_factor.py FRESH_EXPERIMENT FRESH_OUTPUT mixed-plus-headsets
node deploy/transcription/benchmark/mixed_speaker_vad.mjs FRESH_OUTPUT
.venv/asr-benchmark/bin/python deploy/transcription/benchmark/report_vad_factor.py FRESH_OUTPUT
```

The runner uses a scratch CPU worker on port 18018, leaves the production worker untouched, and
requires a fresh output directory. `probe-only` is a parser/warmup check, not scored evidence.
`trace-only` outputs per-word VAD midpoint/coverage with deletions; it does not rerun the paired A/B.
The paired comparison changes the service's internal segmentation path as well as the number of
Qwen decoder calls; it does not isolate the standalone acoustic accuracy of FSMN boundaries.

## Paired TINA name-prior experiment

`name_bias.py` loads the pinned VieGem/FSMN/KenLM stack locally and computes VAD ranges/CTC
probabilities once per clip. It compares baseline and name-prior weights 0.25/0.5/1 on those
identical probabilities (alpha=0.35, beta=1.5, beam=32). Use a private JSON manifest with
`id`, absolute `path`, `kind` and optional `reference`. Real meeting snippets without manually
verified references must use `real-candidate` or `real-unlabeled-control`; never report them as
positive accuracy or WER ground truth. Synthetic controls may use `synthetic-positive` and
`synthetic-negative`. The summary contains counts, hashes and timings, never audio/hypothesis text.

```sh
TINA_VIEGEM_DEVICE=mps HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/viegem/bin/python deploy/transcription/benchmark/name_bias.py \
  /private/path/manifest.json /private/path/report.json
```

This sweep intentionally sets the baseline prior to zero regardless of the caller's ambient
configuration. No model weights or production settings are changed by running it.

## Paired VieGem custom-word experiment

custom_words_ab.py scores a private manifest of 1-32 labeled clips (each at most 12 seconds)
with the bundled or supplied UTF-8 custom word list. It computes FSMN ranges and CTC probabilities
once per clip, then decodes those same probabilities with custom bias weights 0, 0.25, 0.5, and 1.
The default silence endpoint is the production VieGem value, 1200 ms. Reports contain aggregate
WER/CER, per-clip error counts, target-term recall/false insertions, hashes, and timings, but no
transcript text or source paths; write the manifest/report outside Git in a private directory.

```sh
TINA_VIEGEM_DEVICE=mps HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/viegem/bin/python deploy/transcription/benchmark/custom_words_ab.py \
  /private/path/manifest.json /private/path/report.json
```

Real meeting clips need manually checked references and consent. Keep unlabeled clips separate;
they can show output changes but cannot support WER/CER or target recall claims. A synthetic fixture
only measures the words and voices it actually contains and is not meeting-quality evidence.
