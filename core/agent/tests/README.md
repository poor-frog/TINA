# tests — agent-api (L1 + L2 of the validation pyramid)

Reranker regressions distinguish valid empty/no-match selections from malformed/provider/budget
fallback, preserve recent/heard pins without automatic unrelated meeting seeds, restrict empty
generation/repair source IDs and keep full contradiction review. Lookup budgets and service-error
status remain protected; trace/evaluation reports retain empty outcomes separately.

`test_voice_numbers.py` exercises comparison-only Vietnamese cardinal/decimal/percent/scale and
currency equivalence, unchanged quotes/replies, wrong values/signs/units, literal dates/ambiguous
separators, negation/year ambiguity, citation boundaries and semantic rejection of names/conflicts.
Normalization never substitutes for model review and retains its single-repair limit.

`test_voice_retrieval_v2.py` covers real offline Vietnamese segmentation, search-only alias/n-gram
views, shared lexical fusion budget, per-workspace dictionary isolation, speaker/time/entity handling,
bounded original-source context windows and compact evidence references. Reranker artifact tests
pin safetensors/tokenizer manifests and streamed checksums; no BGE weights are needed in unit tests.
Retrieval eval tests distinguish exact-quote/unique-segment relevance from unrelated slices and
human-reviewed answer quality.
`test_voice_retrieval_runtime.py` covers semantic initialization/inference recovery and bounded retries
without real model weights. V2/API regressions also cover deep JSON fallback and disabling recent
context for search/evaluation; unknown/non-finite timestamps cannot become recent evidence.
Voice document tests protect selected direct/Wiki sources against unrelated linked-document
displacement, including a Wiki origin outside the first eight roots. The returned evidence budget
stays eight, and removing links or selecting an unlinked private file still fails authorization.
Optional source I/O/UTF-8 failures are isolated in voice plan/lookup/answer/readiness, including late
Wiki roots and unselected targets. Selected files and unresolved link proofs still return a service
error; empty voice selection does not relax the generic Knowledge routes.

`test_voice_tools.py` covers per-tool provider schemas, typed-to-legacy normalization, field/type/
handle/date validation, tool allowlists and unchanged wire budgets. Worker and Meeting Knowledge
tests also exercise structured planner output through the existing scoped API.

`test_voice_retrieval_eval.py` checks pinned private transcript labels, exact evidence/revisions,
owner/case scope, draft-versus-approved scoring and separate service/refusal outcomes.
`test_voice_trace.py` and `test_voice_eval_report.py` check content-free graph spans, cancellation,
rounds, UUID deduplication and private-log aggregation without copying questions or provider text.

Parallel lookup report tests use batch wall time rather than adding overlapping child durations;
bounded batch count/parallel metadata stays content-free.

`uv run pytest -q` (driven by `gate:python`).

| File | Level | Proves |
|---|---|---|
| `test_contracts_consumer.py` | L1 contract | transcript.v1 + workspace.v1 goldens validate by-path; meetings internals are un-importable |
| `test_core_run.py` | L2 unit | `core.run()` with **faked ports**: reads a transcript.v1 golden → emits the stub action → would-commit a workspace.v1-conformant entity |
| `test_config.py` | unit | `TINA_*` env validates + fails fast; secrets stay out of repr; worker `env` matches `runtime.v1` golden |
| `test_translation_groups.py` | unit | fragmented speech joins into phrases; speaker identity, pauses, sentence/size boundaries, source timestamps and stable group IDs are preserved |
| `test_meeting_translation.py` | API + unit | owner authorization, durable shared phrase cache, in-flight source/revision/access rechecks, concurrent viewer deduplication/lease expiry, per-phrase bounded retries, owner-wide service cooldown/generation, SQLite upgrade/restart, live-tail buffering, stop flush, saved Meeting model and visible-only output |
| `fakes.py` | — | in-memory `WorkspacePort` / `RuntimePort` — the seam that makes L2 possible |
| `conftest.py` | — | loads transcript.v1 goldens by path (the spec, P8) |

Focused translation checks, from `core/agent`:

```bash
uv run pytest tests/test_meeting_translation.py tests/test_translation_groups.py tests/test_llm_openai_compat.py tests/test_llm_anthropic.py -q
uv run pytest tests/test_api.py -k translation -q
```

These tests fake provider calls and do not need API keys or consume inference quota. The broader
agent suite includes POSIX file locks and symlinks; run it on Linux/WSL or in the existing Docker
test environment when developing on Windows. Frontend behavior belongs to the Terminal canvas
and extension suites, not these backend tests.

`test_voice_structured.py` checks schema wire formats, authorized ID enums, nullable optionals,
explicit capability fallback and no fallback for auth/quota/schema errors. `test_voice_rerank.py`
covers invalid IDs/timeouts, protected context and reviewing against the original evidence.
`test_voice_trace.py` plus voice API tests check UUID correlation and content-free timings.

`test_voice_summary.py` checks waiting for the background map/select/verify stages in one turn,
the shared deadline and no partial publication on expiry. Voice API tests cover the service-secret
turn permit and no further dispatch after Stop; bot tests cover the one-time notice, automatic
playback and late-result fences across Stop, departure, policy change and a new question.

`test_api.py` rejects partial translation deltas on terminal worker errors or missing completion
markers. `test_llm_openai_compat.py` checks typed failure status through all three HTTP completion
adapters, including quota and timeout, without live credentials.

Codex network/web probes run explicitly in an isolated built worker image. They do not use model
credentials or production workspace volumes. Run from the repository root (use the appropriate
Docker context for the host):

```sh
for probe in codex_network_smoke.py codex_web_smoke.py; do
  docker run --rm --read-only --tmpfs /tmp --tmpfs /work \
    --security-opt seccomp=unconfined --security-opt no-new-privileges --cap-drop SYS_ADMIN \
    -v "$PWD/core/agent/tests/$probe:/smoke.py:ro" \
    --entrypoint python tina/v012-agent-worker:dev /smoke.py || exit 1
done
```

The network probe checks allowed HTTPS/Git, blocked domains/private addresses/proxy bypass,
offline/read-only turns and metadata/credential protection. The web probe uses a local Responses
fixture to inspect real Codex requests on new/resumed threads: live, cached and disabled modes.
It does not claim that a live model/account actually performed a search.

Voice regressions: `test_voice_knowledge.py` covers relevance/recency, source budgets, stale history
and bounded clarifications; `test_meeting_voice.py` checks approved-source isolation and the dedicated
voice CompletionPort prompt. These use synthetic sources and no provider credentials.
Conversation tests retain authorized clarification context for short answers, expire pending
clarification hints, and reject history whose source fingerprints changed.
Social-routing regressions cover natural thanks, compound questions, malformed classifier output,
provider failure, the selected worker's four-second structured completion and private-source isolation.
Dialogue-note regressions cover chained follow-ups, corrections, expiry/revocation and propagation
to both LiveKit tool planning and final answers; these notes are intent only, not evidence.
Missing-evidence regressions keep verifier diagnostics and empty evidence while avoiding an
unnecessary clarification question for an already clear request. Delivery guidance stays inside
the same JSON and source-verification path; synthetic routing is not a naturalness listening score.
`test_voice_eval_report.py` checks the 20-scenario suite, JUnit evidence, A/B compatibility,
content-free timing summaries and the isolated runner's macOS temporary-path handling.
`test_voice_task_flow.py` checks literal user-field extraction, optional omissions, corrections,
explicit confirmation, selected CompletionPort schema/budget and owner-reviewed draft creation.
Recovery regressions cover two distinct task repair prompts, per-step retry reset, pause without
losing literal fields, and accepting a clear answer despite an earlier clarification streak.

Voice answer coverage: `test_voice_knowledge.py`, `test_meeting_voice.py` and
`test_llm_openai_responses_voice.py` prove bounded lookups, public-mode opt-ins, source isolation,
revocation checks, verifier diagnostics and required native search citations. See `eval/voice` for
30 synthetic questions and an explicit live-provider evaluation command.

The refinement Apply/Restore translation regression verifies that canonical text changes
invalidate the affected phrase's cached translation, retain other phrases, and translate
restored source text again without returning the previous revision's translation.

`test_meeting_voice.py` covers LiveKit tool planning, authorized retrieval, explicit public-query isolation, heard-history revocation and final generation without a nested tool loop.

Voice regression cases cover conservative assistant intents, partial replies, one-repair limits, forged citations, verifier outages and bounded completion timeouts.

Voice regression tests require the selected CompletionPort even when the chat runner is Codex;
no voice CLI process may start. The existing chat Codex harness tests remain unchanged.

test_llm_openai_responses_voice.py covers valid JSON generation/verdict deltas followed by early EOF, [DONE], incomplete/failed events, or invalid terminal status, plus successful completion with/without deltas and existing web citation validation. All provider calls are synthetic.

Voice format-recovery tests exercise the worker boundary with a malformed first reply, valid
recovery, repeated malformed output and contradicted recovery. Only one format regeneration is
allowed and successful output still requires the reviewer. Test provider responses are synthetic.

`test_voice_actions.py` covers private task/decision proposals, completed-readback eligibility, owner review, Stop/policy fences, duplicate/conflicting publication and symlink refusal.

`test_voice_read_tools.py` checks opt-in approved-action retrieval, same owner/meeting, current entity edits and calculation revocation. `test_voice_calculate.py` checks safe decimal/date execution, missing operands and proof reconstruction.

`test_voice_shared_meetings.py` covers explicit owned scope, namespaced IDs, revocation, metadata, current-only recaps/tools and balanced cross-meeting evidence.
# Agent Reach

`test_agent_reach.py` covers bounded public retrieval, citation validation, granted MCP operations,
scrubbed-environment launch, voice routing/verification and Groq namespace compatibility.
`agent_reach_smoke.py` is an explicit pinned-worker proof with a fake LLM and real public page;
run it only against a running Agent Reach service. See deploy/agent-reach/README.md.

`test_voice_handoff.py` checks server-derived owner identity on every handoff chat send/reconnect, fail-closed revocation, bounded data grounding and exclusion of ambient full-meeting context.

`test_voice_decision_flow.py` covers proposed/decided separation, literal fields, bounded reprompts, exact evidence, command/negation rejection, independent verification, source/privacy/policy changes, Stop permits, retained fields on service failures, and owner-only pending-draft approval.

Draft recovery regression tests cover eight-input and character-capacity confirmation/cancel/correction with retained literal provenance, and a successfully written task whose response is lost: an uncertain retry must leave exactly one draft.

Voice draft pagination regression uses21 drafts:20 newer discarded records cannot prevent the owner listing/reviewing the older pending record. Direct lookup retains existing authorization and stale-policy/readback checks.
