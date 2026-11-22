# Discussion Review — Option A

## Use

Open a **completed** meeting. In Terminal, expand **Tools** above the transcript and select
**Discussion review**; in Dashboard, select **Discussion review** beside the transcript.
Enter the meeting objective/agenda, then choose **Tạo đánh giá thảo luận**. The saved
review includes that agenda; editing the draft requires generating again to apply the change.

The tool-less LLM classifies chronological transcript windows, one call per window, predominantly
Vietnamese with English technical terms. Each call sees the current exchange and earlier context,
not later turns. Explanations are requested in Vietnamese and non-CJK explanations are rejected
for one correction attempt. Each exchange shows:

| Task | Classes |
|---|---|
| Relevance | relevant / useful tangent / off scope / uncertain |
| Interaction | constructive disagreement / personal hostility / sarcasm / dismissive address / threat / uncertain |
| Progress | advancing / exploring / repeating unresolved positions / uncertain |

Interaction supports multiple labels; an empty list means no listed signal was detected.
`uncertain` is exclusive. The rubric distinguishes technical disagreement and consequences from
personal attacks/threats, and productive exploration from stalled repetition. It evaluates exchanges,
not participant reputation. This text-only version does not infer vocal emotion.

Expand the cited speaker/time entries to see exact text, text revision and segment ID. Audio playback
uses the existing authenticated segment-audio route when source audio is available and the report is
current. Reports include the actual model name and the fixed `discussion.vi-en.v1` rubric version.
Classification quality, especially sarcasm and Vietnamese pragmatics, needs evaluation on labeled
meetings; schema/reference checks establish structural validity only.

## Bounds and consistency

- Explicit manual request; no automatic analysis or live alerts.
- One request includes the entire nonblank finalized source, up to **200 segments / 24000 transcript
  characters / 20 windows**. Windows target 60 seconds or 3000 characters at segment boundaries.
  A longer individual segment remains intact. Oversized input returns 422; nothing is silently dropped.
- Windows are processed chronologically. Each call sees the target window and earlier context, never
  later turns. Relevance/interaction evidence must be from the target window; progress may cite
  earlier windows. Repetition needs at least two distinct turns.
- The model is asked for schema-shaped JSON; adapters use native JSON Schema output settings where
  supported. The worker and API validate the response and evidence regardless. Invalid/unavailable
  model output is an error, never a fabricated `uncertain` classification.
- Each window call allows 180 seconds for local model startup/inference. The total relay deadline
  scales with the window count up to 15 minutes. The UI keeps the previous saved report when
  generation fails.
- The API authorizes the meeting/canonical source on every read and before saving. Source changes
  reject delayed publication or mark saved results stale on the next read. This is cross-store
  freshness checking, not a distributed database transaction.
- The latest report and its agenda are stored atomically at `.discussion-reviews/{meeting_id}.json`
  in the caller's current private writable workspace, using the existing workspace lock and an
  `expected_id` compare-and-swap. Other workspaces have their own reviews. These are private derived
  snapshots like meeting Q&A; removing meeting access makes them unavailable through this API.

## Configuration and deployment

Use the existing **Models** settings or deployment `TINA_LLM_PROVIDER`, `TINA_LLM_BASE_URL`,
`TINA_LLM_MODEL` and server-side credentials. No new model installation, service, environment variable
or database migration is needed. Rebuild Agent API, agent-worker, Gateway and the client images to
ship the change. Runtime workers must use the rebuilt worker image.

Inference stays behind `CompletionPort`, making a future AWS adapter independent of the review UI
and contract. Agenda and bounded transcript text go to the configured model endpoint. No audio,
chat history or unrelated workspace documents are sent. Payloads use the existing private job path,
short-lived output stream and sanitized error logging.

## API

Gateway paths (internal Agent API uses `/api/` instead of `/agent/`):

- `GET /agent/discussion-reviews/{meeting_id}` → `{report, stale, can_generate}`.
- `POST /agent/discussion-reviews/{meeting_id}` with
  `{"agenda":"Choose a retry strategy for payment service","expected_id":null}` → the same state.
  For replacing a report, supply its current ID. Identical source/agenda/rubric returns the saved
  report without another model call.

Owner access is derived from gateway identity. Live meetings or conflicting revisions return 409;
empty/oversized input returns 422. Failed inference uses the existing sanitized 5xx completion errors.
Both clients adapt the same `discussion-review.v1` result; neither derives classifications locally.

## Verification

- Agent tests: `cd core/agent && uv run --frozen --group dev pytest -q tests/test_discussion_review.py`
  (the existing workspace lock requires a POSIX environment).
- Gateway tests: from `core/gateway/services/gateway`, `uv run --frozen pytest -q tests/test_agent_proxy.py`.
- Terminal behavior: from `clients/terminal`, `pnpm exec vitest run src/surfaces/__tests__/discussionReview.test.tsx`.
- Contract: `node core/agent/contracts/discussion-review.v1/validate.mjs`.
- Real local model + browser smoke test: follow [the Compose Option A instructions](../deploy/compose/README.md#option-a-real-model-browser-smoke-test).

Tests use injected completions; they do not assert real-model accuracy or require provider credentials.

## Offline concurrency and batching experiments

See [measured local results](discussion-review-experiments.md) for the 2026-11-06 comparison.

`worker.discussion_review.classify()` exposes three execution strategies. The app's `run()` always
uses the existing **sequential** default; there is no client/API mode switch and no cache-key change.

| Strategy | Model requests | Context and retries |
|---|---|---|
| `sequential` | One window at a time | Current/earlier turns only; one correction attempt per window |
| `concurrent` | Up to two windows in flight | Independently precomputed current/earlier turns; results assembled chronologically; one correction per window |
| `batch` | Two or four adjacent windows per call, batches sequential | One source table with window-qualified aliases; one correction of the entire batch |

Concurrent requests require actual provider parallelism to overlap inference. With
`OLLAMA_NUM_PARALLEL=1`, requests queue. Compare client concurrency 1/2 under **both** server
parallelism settings 1/2. Monitor VRAM and verify full GPU offload: additional context slots consume
memory. Failure cancels unscheduled concurrent work and drains in-flight requests; no partial
classification is returned. Only fully validated candidates are accepted after a retry.

**Batching is retrospective only.** A model sees later targets in the same request, so it can use
future context even when its citations are valid. Per-target schema/validation rejects future
citations, but cannot guarantee reasoning isolation. It is not a drop-in live-checking strategy.

### Benchmark runner

From `core/agent` in a Python/POSIX environment with the locked dependencies installed:

```bash
uv run --frozen python scripts/benchmark_discussion_review.py \
  --base-url http://localhost:11435 --parallel-slots 1 --runs 10 \
  --output ../../output/discussion-review-docker/experiment-parallel1.json
```

The default input is `tests/fixtures/discussion_review_benchmark.json`, the same eight-turn,
four-window synthetic scenario as the browser smoke test. Use `--repeat-transcript 2` for an
eight-window stress input. The `discussion_review_future_joke.json` and
`discussion_review_future_sincere.json` fixtures share an identical first window and change only
the later clarification, for detecting context influence. Use `--input` to select a fixture.
These fixtures are diagnostics, not a representative labeled accuracy dataset.

The runner rotates strategy order, warms separately, keeps the same generation cap (1200 tokens),
and records actual model digest, version, residency, token usage, calls, corrections, truncation,
validity, full contract checks, fixture checks and both successful/all-run timing summaries.
Temperature is omitted by default, matching the app; `--temperature 0` is a separate controlled
condition. Failures remain in results; there is no silent sequential fallback. Verify context
capacity and inspect server truncation warnings before interpreting longer inputs; no benchmark
silently removes transcript turns to fit. A larger output cap is a separate experiment.

Artifacts can contain the supplied transcript's derived classifications and evidence IDs; use
synthetic fixtures or keep frozen private inputs and results in private local storage. Error
logging records exception types only. The runner never calls the app API or writes saved reviews.

### Local Docker execution

For the existing `tina-local` setup, start a **separate** benchmark Ollama using the pinned image
and the existing model cache mounted read-only. Run this while the app's inference is idle and
its model is unloaded; two loaded servers competing for the same GPU invalidate the comparison.
No app model endpoint or Compose settings need changing.

```bash
docker run -d --name tina-review-benchmark-ollama --gpus all \
  --mount type=volume,source=tina-local_ollama-models,target=/root/.ollama,readonly \
  --network tina-local_tina -p 127.0.0.1:11435:11434 \
  -e OLLAMA_CONTEXT_LENGTH=8192 -e OLLAMA_KEEP_ALIVE=30m \
  -e OLLAMA_NUM_PARALLEL=1 -e OLLAMA_MAX_LOADED_MODELS=1 ollama/ollama:0.20.5

node core/agent/scripts/benchmark_discussion_review.docker.mjs --parallel-slots 1 --runs 10
docker rm -f tina-review-benchmark-ollama
```

The Node wrapper uses a disposable Linux runner based on `tina/v012-agent-api:local`, mounts the
checkout agent source read-only, and captures GPU samples alongside progress/results under
`output/discussion-review-docker/`. It requires Docker, the named local network/model volume,
and the already-built local API image. Run it from a persistent terminal until completion.
If the host wrapper is interrupted, check/stop `tina-review-benchmark-runner` before starting
another condition; disconnecting the Docker client can leave its Linux job running.

Repeat with `OLLAMA_NUM_PARALLEL=2` in the server launch and `--parallel-slots 2` in the wrapper
to run the sequential/concurrent controls. `--parallel-slots` records configuration; it does
not reconfigure the server. `--modes sequential,batch2,batch4`, `--name`, `--input`,
`--temperature`, `--max-tokens` and `--repeat-transcript` can select additional conditions.
Do not combine batching and request concurrency in the initial comparison.

Tests: append `tests/test_discussion_review_experiments.py` to the agent pytest command above.
Measure full-app latency separately after any winner is selected; these timings bypass dispatch,
authorization and report publication and do not establish the 3–5 second live target/10 second limit.
