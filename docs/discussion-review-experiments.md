# Discussion Review: concurrency and batching results

Measured locally on **2026-11-06**. Reproduction instructions and the strategy descriptions are
in [Discussion Review](discussion-review.md#offline-concurrency-and-batching-experiments).

## Setup

- RTX 3070 Laptop GPU, 8 GiB VRAM; i7-12650H; 16 GB host RAM, 7.57 GiB exposed to Docker.
- Ollama **0.20.5**, Qwen 2.5 7B Instruct Q4_K_M.
- Model digest: `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`.
- Same four-window/eight-turn VI/EN payment-retry fixture for every primary run.
- Input SHA-256: `71b19c71693cdeba1e67b768d295402f5c4b1501dcd6aa69a277322fadf02ea3`.
- Same rubric, full explanations/evidence output and 1200-token completion cap; server-default
  temperature, matching the app. The paired future-context diagnostic separately used temperature 0.
- Dedicated benchmark Ollama, read-only existing model cache, app inference idle/unloaded. App
  endpoint/configuration was not changed. All inference stayed GPU-resident with either setting.
- 8192-token context per sequence. Sequential and concurrent controls used one and two server slots.
  Batches of two/four ran sequentially, on the one-slot server.
- **10 warm runs per condition, 60 primary runs total**, with strategy ordering rotated within
  each server configuration. Server configurations ran in separate time blocks, not simultaneously.
- Timings cover offline classification and validation, including corrections/failure cleanup, but
  exclude warm-up, app dispatch, authorization, publication and rendering. No experimental reports
  were published through the app. Every successful run also passed the full report contract.

## Primary results

"Fixture passes" means all three smoke-fixture expectations passed: off-scope football tangent,
personal hostility on the insult, and repetition on the final exchange. A failed run does not count
as a fixture pass. Structural validity is not the same as classification accuracy.

| Client strategy | Ollama slots | Valid / 10 | Median all runs | Median valid runs | Correction calls | Fixture passes / 10 |
|---|---:|---:|---:|---:|---:|---:|
| Sequential | 1 | 8 | 43.83 s | 46.40 s | 10 | 8 |
| Concurrent, max 2 | 1 | 8 | 43.76 s | 43.76 s | 10 | 8 |
| Batch size 2 | 1 | 8 | 50.23 s | 52.33 s | 9 | 7 |
| Batch size 4 | 1 | 10 | 57.64 s | 57.64 s | 6 | 6 |
| Sequential | 2 | 8 | 47.54 s | 48.16 s | 12 | 8 |
| Concurrent, max 2 | 2 | 9 | 39.58 s | 40.07 s | 11 | 8 |

Failed runs can finish early, so compare both timing columns rather than treating early failure as
a speed improvement. There were no completion-length truncations in these samples. Observed prompt
usage was 1164–2894 tokens and output usage 116–928 tokens across the primary conditions.

### Interpretation

1. **Concurrent HTTP requests alone did not help on a one-slot server.** All-run medians were
   effectively equal; requests still queued in Ollama.
2. **Two-slot inference modestly helped concurrency.** Within that server configuration, median
   valid latency fell from 48.16 to 40.07 seconds, about **17%**. It did not approach a 2x speedup.
   Concurrent runs ranged from 27.67 to 52.90 seconds including failures.
3. **Batching was slower in this experiment.** Larger generated responses and occasional whole-batch
   correction calls offset the reduction in HTTP calls. Fewer correction requests is not necessarily
   less correction work, because a batch correction regenerates multiple windows.
4. **Batch validity did not establish quality.** Size four returned 10 valid reports, but only six
   passed all three fixture checks. It also exposes later target text to earlier decisions.
5. **Neither strategy meets the 3–5 second live target or 10 second ceiling.** These are full-report
   throughput experiments, not a substitute for a compact incremental live checker.

## Memory and startup

Ollama reported approximately **5.34 GB** of GPU-resident model/context allocation with one slot,
and **6.30 GB** with two slots; `size == size_vram` in the residency responses. Two-slot GPU samples
peaked at **6025 MiB total GPU use** and reached 100% utilization. One-slot GPU sampling covered
only the early part of the suite because the host supervisor was interrupted; the Linux runner
continued and completed all 40 samples (verified exit 0 and final result counts). Its partial GPU
sample maximum must not be treated as the whole-suite peak.

The two-slot server warm-up took **208.2 seconds**, excluded from the table. An earlier isolated
warm-up exceeded the initial 180-second client timeout, so the runner permits up to 600 seconds for
warm-up while keeping the model-call timeout at 180 seconds. The cold-load cause was not isolated.
Live operation would require warm-up/readiness handling in addition to faster inference.

## Additional diagnostics

### Eight windows

One stress run per strategy, created by repeating the synthetic transcript with distinct segment
IDs and shifted timestamps, on the two-slot server:

| Strategy | Time | Valid complete result |
|---|---:|---|
| Sequential | 82.27 s | No |
| Concurrent, max 2 | 37.86 s | No |
| Batch size 2 | 69.45 s | Yes; all three original fixture checks passed |
| Batch size 4 | 58.33 s | No |

Failed runs aborted before complete coverage. Their shorter times are **not** measurements of a
successful eight-window review. This small stress test provides no general accuracy conclusion.

### Future-context pair

Two fixtures share an identical ambiguous first window and differ only in the later clarification
(sarcastic versus sincere). Each ran sequential and batch-size-two once at temperature 0.
Validation failures prevented a clean paired label-stability comparison, so that comparison is
**inconclusive**.

However, a valid batch report's explanation for the **first** window explicitly discussed a retry
limit proposed only in the **second** window while citing only the first source. This demonstrates
why citation checks cannot enforce reasoning isolation once future text is visible. Keep batching
retrospective and experimental rather than presenting it as equivalent to earlier-only analysis.

## Recommendation

Keep the sequential app default. Two-way concurrency is a possible modest post-meeting throughput
optimization after broader quality/reliability evaluation and shared-GPU scheduling work. Do not
promote batching from this evidence. For live checking, benchmark compact incremental Qwen versus
Tev1 separately; neither full-report experiment addresses the dominant generation cost enough.

These are repeated runs of one synthetic fixture, not independent labeled meetings or a production
load test. They do not establish statistical significance, p95 latency, or a hard deadline. No
experimental strategy was wired into the UI/API, so end-to-end experimental app latency was not
measured.

The two-slot server logs confirmed two sequence slots and all 29 layers offloaded, with no input
truncation or out-of-memory warnings during its suite and diagnostics.

## Verification and artifacts

- **63 targeted Python tests passed** in a disposable Linux container, covering the existing review,
  concurrent/batch behavior, and OpenAI-compatible completion adapter.
- Discussion-review contract goldens and the architecture/data-flow gate passed.
- Raw timing/results and GPU samples are in ignored `output/discussion-review-docker/`:
  `experiment-parallel1.json`, `experiment-parallel2.json`, `experiment-long8.json`,
  `experiment-future-joke.json`, `experiment-future-sincere.json`, and matching `*-gpu.json` files.
- `experiment-pilot-parallel1.json` is a separate one-run-per-mode temperature-0 pilot and is not
  pooled into the primary results.
- The benchmark container is disposable; the app's inference configuration and stored reports are
  unchanged by the experiments.
