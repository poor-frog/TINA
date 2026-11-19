# Voice answer regression

Retrieval V2 adds raw/Vietnamese BM25, scoped aliases/character candidates, weighted RRF and
bounded context/evidence metadata. See [implementation, filters and BGE candidate](../../../docs/tina-retrieval-v2.md).
`--retrieval-version v1|v2 --k 10` permits a controlled compatibility comparison. The report includes
Recall@k, unique-segment MRR/NDCG@k and p50/p95 latency; optional `relevance` 1–3 grades refine the
existing binary labels. Unjudged sources remain zero in this provisional metric, not known irrelevant.
NDCG requires the exact labelled quote in the returned slice, not just the same segment ID.
`--bge-directory` runs only verified local weights; `--llm-rerank` explicitly calls the deployment
provider and records applied/empty/skipped/fallback counts. `empty` is a valid no-match selection,
possibly retaining explicit recent/heard pins; it is not counted as provider failure or fallback.
Content-free stage reports retain the same outcome counts. Neither reranker is enabled by default; keep model,
snapshot/case hashes and environment fixed when interpreting comparisons.
All modes cap final evidence at `--result-limit 12` by default (including reranker fallback),
with `k <= result-limit <= 48`. Pre-rerank evidence recall/counts are separate from final metrics;
compare runs with identical candidate and result budgets, not historical uncapped full recall.

## Private real-transcript retrieval baseline

`retrieval.py` evaluates production chunk selection over a local snapshot without changing meetings,
publishing Wiki pages or calling an LLM. Keep snapshots, labels and reports in ignored `output/`
with private permissions; never commit real meeting contents. A snapshot contains
`meetings: [{meeting_id, owner_id, canonical: {segments: [...]}}]` from one owner. Labels contain
`snapshot_sha256` (SHA256 of the exact snapshot bytes) and `cases`. Each case has an `id`, selected
`meeting_ids`, `question`, `expected` (`answerable`, `unanswerable`, `clarification`), `reference_answer`,
`review_status` (`draft` or `approved`) and `evidence` records with meeting/segment ID, revision and
an exact source `quote`. Labelled quotes are checked against the selected snapshot before scoring.
Human review should check the question, reference and source meaning; stored ASR alone does not
prove correct transcription or establish that the statement is true outside the meeting.

From the repository root:

```sh
PYTHONPATH=core/agent core/agent/.venv/bin/python core/agent/eval/voice/retrieval.py \
  --snapshot output/rag-meeting-eval/meetings.private.json \
  --dataset output/rag-meeting-eval/cases.private.json \
  --output output/rag-meeting-eval/bm25.json
```

Add `--semantic` in the prepared Agent API environment for pinned local E5 + BM25/RRF. Weights are
never downloaded by evaluation. Reports distinguish semantic failure from a successful hybrid run.
Evidence recall requires the exact labelled quote within a returned chunk; compound questions need
all their evidence. Small source pools can inflate results. Draft labels are provisional and never
count as approved answer accuracy. Negative cases have no retrieval recall: returning irrelevant
excerpts does not itself prove a false answer.

Optional `--answers private-results.json` accepts `{"cases":[{"id":"real-01","reason":"answered",
"human_correct":null}]}` from separately recorded answer runs. Missing cases are not run. Service
failures are separate from answerable refusals; negative answers are flagged for review. Correctness
requires explicit boolean human ratings on approved reference cases, never keyword matches or the
model's own verifier. Keep sources/provider/model and policy identical for answer comparisons. This
retrieval-only harness does not exercise LiveKit, provider quota, ASR, TTS or playback.

## Per-turn LangGraph and LLM timings

Local `voice_stage` spans cover graph total, plan, each allowlisted tool and verified-answer API time.
Span UUIDs deduplicate records; the request UUID joins graph/API/model work with bot `voice_timing`.
Round/source counts are allowlisted; questions, source text, tokens and exception messages are omitted.
Cancellation has its own status. External LangSmith tracing remains off.

```sh
python3 core/agent/eval/voice/report.py --stage-log output/private-voice-stages.log \
  --timing-log output/private-bot-timing.log --output output/voice-stages.json
```

Use combined local LiveKit/Agent API/worker logs for plan, retrieval, generation and verification.
Reports show per-request stages, p50/p95 and error/cancel counts. Parent API/graph times include child
work: do not sum them with model/tool times. Missing stages are unmeasured, not zero. Bot timing
keeps answer PCM/playback separate from acknowledgments and waiting notices; absent bot logs cannot
establish speech-to-audio latency. Reports bound 1000 requests/64 spans each and disclose omissions.
`run.py --stage-log` also attaches these metrics to the existing synthetic conversation report.

Parallel reads emit `rag_lookup_batch` with bounded tool count and a parallel boolean. The per-turn
table uses the batch's elapsed wall time, retaining individual overlapping tool spans for diagnosis.
Legacy logs without a batch span retain the prior sequential sum. Do not sum concurrent tool times
to estimate latency savings; compare measured batch/request/first-answer-PCM times instead.

`rag_assess` and allowlisted `lookup_outcome` fields distinguish empty results, temporary unavailability,
partial remaining evidence and source/session access changes. These are control outcomes, never an
automatic correctness rating or proof that the meeting contains no answer.

30 synthetic questions cover meeting owners/deadlines, corrected decisions, proposals, negation,
amounts, document retrieval, unanswerable questions, public definitions and explicit web queries.
These are regression fixtures, not recordings or a Vietnamese meeting benchmark.

From `core/agent`, run with its Python environment and `PYTHONPATH=.`:

```sh
python eval/voice/run.py --output /tmp/tina-voice-routing.json
python eval/voice/run.py --live --output /tmp/tina-voice-live.json
```

The first command checks routing without a provider call. `--live` uses the configured completion
provider and may incur its normal charges. Supply credentials through the normal environment,
never command arguments. It runs the real voice control-plane and worker over temporary synthetic
meeting/documents; it does not access a real meeting or modify a workspace. Output includes per-case
reason, lookup counts, public citations and duration. Expected term checks are only a smoke signal;
human review is required for paraphrases, semantic correctness and whether a clarification helps.
Web availability is reported separately and must not inflate meeting-answer accuracy.

Conversational cases 31–36 cover concise answers, short heard-history follow-ups, a corrected
premise and a partially answerable request. The runner reconstructs history source fingerprints
from the synthetic fixture instead of treating prior assistant text as evidence. Use `--cases`
to select cases and `--label` to identify a run. For a controlled before/after comparison, save the
previous VOICE_SYSTEM prompt to a private text file and pass `--prompt-file` for the baseline:

```sh
python eval/voice/run.py --live --cases 31,32,33,34,35,36 --label baseline --prompt-file /tmp/voice-baseline.txt --output /tmp/voice-baseline.json
python eval/voice/run.py --live --cases 31,32,33,34,35,36 --label candidate --output /tmp/voice-candidate.json
```

Use the same provider, model and source fixtures for both runs. The prompt override changes voice
generation and its repair wording; reviewer rules and source permissions stay fixed. Per-case output
includes verification codes, source count, total answer-service time and empty human-rating fields.
Rate naturalness and factual correctness separately from 1 (poor) to 5 (good). Listen for a direct
answer, ordinary phrasing, no repeated acknowledgment, a concise follow-up and accurate names,
numbers and uncertainty. Leave ratings blank until a person reviews them. A term match or approved
verifier result is not a naturalness score. Timing excludes live ASR, microphone playback and user
perception. This runner does not synthesize audio or measure speech-end-to-first-audio latency;
those require the existing bot timing events and a separate listening trial.

Cases 34 (owner known, phone unknown) and 36 (approval versus testing) also exercise partial-answer
review and strict JSON recovery. Include both when checking generation changes; a 200 HTTP response
with a refusal or llm_unavailable is not a successful answer. Inspect reason, verification and source
count alongside wording. Format regeneration can add one completion call, bounded by the existing
worker budget; it does not allow a new tool round or bypass numeric/semantic verification.

The runner exits nonzero on wrong routing, HTTP failures, missing expected meeting terms/evidence
or an unsupported answer in a negative case. Public/general answers still require manual quality
review. A saved JSON report is retained even when these smoke criteria fail.

## Twenty Vietnamese conversation scenarios

`conversations.json` contains 13 answer-service cases and seven runtime cases. The answer cases
cover direct replies, short follow-ups with explicitly seeded heard history, scope corrections,
ambiguous topics/tasks, missing and partial evidence, proposals, numbers, shared Wiki, incorrect
premises and negation. Seeded history is a controlled fixture, not a newly generated previous turn.
The runtime cases reference existing bot tests for name-only/wake-plus-question behavior, actual
tool waiting notices, Stop, overlapping participants, backchannels and TTS echo rejection.
These are synthetic regression cases, not recorded speakers or a Vietnamese accuracy benchmark.

From the repository root, first produce the bot's actual JUnit evidence (about 75 seconds):

```sh
core/meetings/services/bot/node_modules/.bin/tsx --test --test-reporter=junit \
  core/meetings/services/bot/src/meeting-voice.test.ts > /tmp/tina-bot-voice.xml
```

Then, from `core/agent`, using the existing Python environment:

```sh
PYTHONPATH=. .venv/bin/python eval/voice/run.py --suite conversations \
  --runtime-report /tmp/tina-bot-voice.xml --label local-logic \
  --output ../../output/voice-conversation-eval/local-logic.json
```

The report records `routing_passed` for answer routing and `passed` for a matched successful bot
test. Without JUnit evidence, runtime cases are `not_run`; missing/skipped tests in supplied JUnit
fail qualification. No runtime test is inferred from its name alone. Neither result grades LLM
wording. JSON and Markdown are written together; the Markdown contains a blank listening scorecard.

To evaluate real wording, configure the same CompletionPort provider/model used for the intended
evaluation via the normal environment, then run `--live`. This isolated runner uses synthetic
sources and environment credentials, not a signed-in Terminal account's personal preferences.
Do not assume a deployment-default local model is the account's chosen voice model. An unavailable
provider is a failed case even when the service returns HTTP 200 with `llm_unavailable`.

For A/B, save the old `VOICE_SYSTEM` text before editing and use the same suite/model both times:

```sh
PYTHONPATH=. .venv/bin/python eval/voice/run.py --suite conversations --live \
  --runtime-report /tmp/tina-bot-voice.xml --prompt-file /tmp/voice-baseline.txt \
  --label baseline --output ../../output/voice-conversation-eval/baseline.json
PYTHONPATH=. .venv/bin/python eval/voice/run.py --suite conversations --live \
  --runtime-report /tmp/tina-bot-voice.xml --label candidate \
  --baseline ../../output/voice-conversation-eval/baseline.json \
  --output ../../output/voice-conversation-eval/candidate.json
```

The baseline overrides generation, repair and format-recovery wording together. Comparison rejects
different source fixtures, execution modes, case sets, questions, providers or model IDs. It records
prompt hashes and before/after wording but never declares an automatic naturalness winner. Keep
provider endpoint/settings consistent too. Review correctness, naturalness, clarification usefulness
and acknowledgment appropriateness separately; 1 is poor and 5 is strong. Use N/A where appropriate.
Phrase/length hints are for review only. Listen to both texts using the same selected VieNeu voice
through the existing preview/listening workflow before rating speech pacing or pronunciation.

## Real bot timing logs

Add `--timing-log /path/to/bot.log` to either report. The existing `voice_timing` events supply
speech-end-to-answer-playback, speech-end-to-answer-PCM, answer-service, ASR, wake acknowledgment
and waiting-notice durations separately. The reader deduplicates repeated snapshots by request,
reports sample counts and p50/p95, and separates completed turns from interrupted/unfinished ones.
Service-error notices use `answer_failed` and stay outside completed-answer latency, even when
the bot successfully played the notice; missing-evidence replies retain `no_evidence`.
Only numeric allowlisted fields are copied to the report; raw request IDs and other log content
are not copied. Use a log from the matching run for meaningful comparison. A missing timing log
means **not measured**; answer-service duration never stands in for end-to-end audio latency.

`tests/test_voice_eval_report.py` checks JUnit verdicts, timing deduplication, notice-only logs,
private-log filtering, A/B compatibility and a live-shaped synthetic API call with a fake worker.
The latter also guards macOS temporary-directory symlink handling, without calling a model.
