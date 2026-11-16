# agent · shared

Retrieval V2 uses `voice_lexical.py` for raw/Vietnamese BM25, scoped technical aliases, low-weight
character candidates and weighted RRF. `voice_evidence.py` narrows speaker/time candidates, expands
bounded original-source windows and builds compact evidence references without rewriting quotes.
Entity hints affect rank only. See [V2 behavior and offline evaluation](../../../docs/tina-retrieval-v2.md).

Shared agent primitives used by both the control plane and the worker: config/settings loading (`config`, `agent_config`), domain `models`, hexagonal `ports` and `adapters`, and the `core` run wiring.

`voice_trace.py` also ships unchanged as a standalone stdlib-only module in the LiveKit image.
Local graph/API/model spans share the request UUID, have unique span UUIDs for deduplication,
distinguish cancellation and allow only numeric source/round metadata. Private text is excluded.

Parallel graph read batches also record bounded `tool_count` and `parallel` metadata. Batch elapsed
time is wall time, while per-tool child spans may overlap. No search terms or source text are added.

Lookup routing additionally emits only allowlisted `lookup_outcome` values (found, empty, unavailable,
partial, access_changed); provider messages and failed-source contents are not logged.

`voice_tools.py` owns provider-side argument schemas for all voice tools and normalization to the
existing bounded `{name, query}` transport/storage shape. It uses the project's JSON Schema validator,
rejects extra fields, and leaves legacy query-format calls compatible. `voice_schema.py` generates
name-discriminated tool schemas from the available-tool list; `voice_tool_calls` normalizes typed
LLM output before TINA's existing source/permission/execution checks. LangGraph reuses the same
module and duplicate fences after normalization. These schemas do not change ASR, source scope or
the owner review required to publish task/decision drafts.

Translation helpers:

- `translation_groups.py` owns deterministic same-speaker phrase boundaries over finalized canonical
  segments. It preserves source member IDs/text, canonical revisions and timestamps, applies sentence/pause/size limits,
  and computes cache fingerprints. It makes no model calls and never edits transcripts.
- `translation_text.py` extracts visible English text from model output, removing inline reasoning
  blocks and rejecting incomplete, empty or oversized results. Both worker output and cache reads use it.
  It also owns the fixed translation failure-code/HTTP-status mapping shared by worker and control
  plane; provider response text and credentials never enter translation status.

The control plane supplies observed tail stability and meeting completion state; renderers consume
the resulting [meeting-translation.v2](../contracts/meeting-translation.v2/README.md) groups without
re-deriving boundaries. Grouping tests live in `../tests/test_translation_groups.py`; cache, model
selection and reasoning-output regressions live in `../tests/test_meeting_translation.py`.

`voice_knowledge.py` selects bounded voice evidence using BM25, recent transcript and neighboring
segments. It validates short voice responses and source-backed conversation context without changing
the chat Knowledge prompt. Voice history is context, never a new factual source.

Voice replies also pass a digit/source guard and separate constrained LLM review before output.
Failed or unavailable review releases an empty claim set, never the unchecked draft.

Voice answers can request one bounded round of read-only transcript/shared-document lookups.
`voice_knowledge` owns query routing, tool-argument validation, bounded snapshot retrieval and
allowlisted failure explanations. Explicit public queries and general definitions are isolated from
meeting history/evidence. `eval/voice` contains 30 synthetic regression questions, not a real ASR or
meeting-quality benchmark.

Voice planning validates at most two authorized lookup names/queries; current heard history is revalidated against source fingerprints before entering any meeting prompt.

Voice routes include conservative server-owned assistant intents. Numeric/semantic verification can repair one rejected draft against the same sources, reverify it, and return bounded content-free check codes.

Voice-only retrieval splits long approved sources into sentence/word-aware slices of at most 1200 characters with 200-character overlap. Each slice carries parent key/fingerprint and exact character offsets; original segment timestamps remain parent intervals, not inferred chunk timing. Short sources retain their existing identity.

Voice ranking accepts an injected semantic candidate ranking and fuses it with BM25 using reciprocal ranks before selecting anchors and neighboring evidence. Shared code and worker require no embedding dependency; absent/busy/failed semantic retrieval leaves lexical retrieval available.

voice_summary owns conservative whole-meeting recap intent detection, chronological bounded transcript parts and separate map/selection prompts. Local/time-limited recaps retain normal query retrieval.

Supplemental voice context uses opaque key/fingerprint hashes and at most three adjacent original chunks on each side. Multi-query merging shares the existing budget across lookup groups so earlier useful evidence is retained.

The spoken meeting prompt uses concise conversational phrasing, direct answers and short follow-ups.
Vietnamese replies use “em” only when self-reference is useful, address the listener as “bạn” without
inferring age/rank, and omit pronouns where unnecessary. Partial answers describe the missing detail
without claiming whole-meeting coverage. This affects generated and repaired wording only; cited
claims, numeric checks, reviewer requirements and history-as-context rules remain authoritative.

Voice source review checks the claims actually asserted. A cited answer may cover the known part
of a compound request without inventing an unknown detail; missing coverage alone is not a false
claim. The reviewer still rejects invented details, unsupported absence claims and contradictions.
VOICE_FORMAT_SYSTEM regenerates malformed wire output from the original authorized evidence; its
result must pass ordinary claim and source review before release.

`voice_schema.py` builds provider-side answer/plan/review/rerank shapes with authorized source-ID
enums. Nullable optional fields preserve the existing semantic validator and source checks.
`voice_rerank.py` optionally selects up to 12 useful excerpts when retrieval returns more than
eight, retaining recent speech and heard-history references within 32 excerpts/24000 characters.
Valid `source_ids: []` is an `empty` result, not a failure. Only explicit recent/heard-history pins
remain; automatic per-meeting comparison pins apply to nonempty rankings. Invalid rankings,
oversized protected context and provider failures retain the original list as `fallback`.
No-match describes the bounded supplied excerpts, never an exhaustive absence from the meeting.
The verifier still sees every originally retrieved excerpt, including contradictions. After an
empty ranking, generation and format/semantic repair may cite only the retained pins; repair cannot
reseed discarded sources. A verified empty reply reports `retrieval_empty`, while actual generation/
verification failures keep their service-error status. Small inputs still skip optional reranking.
`voice_numbers.py` creates comparison-only quantity facts for Vietnamese cardinals, signed decimals,
percentages and thousand/million/billion scales with VND/USD/EUR aliases. Source quotes, original
reply text and citation fingerprints are not rewritten. Amount, sign and explicit unit must agree;
19% differs from 24%, and 100 triệu differs from 100 tỷ. Facts are extracted per cited quote so
separate citations cannot concatenate into a new number. Ambiguous grouping/date/version spellings
stay literal; bare “không”/“năm” are not inferred as zero/five, and ambiguous year phrases are not
guessed. Numeric equivalence still requires the existing semantic reviewer and one-repair budget.
`voice_trace.py` records only UUIDs, fixed stages/statuses, elapsed milliseconds and source counts.
Its request context is reset after each call; questions, excerpts, tokens and provider output are omitted.

voice_calculate.py evaluates bounded Decimal arithmetic and signed calendar-day differences using explicit question inputs or returned authorized source handles. Derived proofs bind source fingerprints; there is no eval, external execution or vector-store write.

`voice_task_flow.py` bounds structured user-requested task fields and review transitions. Fields remain literal user input; this is neither meeting evidence nor permission to publish a task.

`voice_recovery.py` counts only heard, source-valid clarification context; delivery guidance varies repair prompts and a terminal marker closes an exhausted chain.

`voice_knowledge.py` keeps exact assistant intents as the fast path. Unrecognized social-looking
utterances may use the selected LLM's `voice_intent` mode with a four-second completion timeout.
Only identity/capabilities/greeting/thanks enums are accepted and spoken through existing fixed
replies; mixed action/questions, malformed output and classifier outages retain the evidence path.
The classifier receives only the current utterance, with no tools, documents or meeting history.
It is an optional final-answer routing step, not an additional autonomous agent or public-search grant.

`dialogue_context` derives an intent note from at most three caller-scoped, actually heard,
source-valid turns. Follow-up chains retain their goal and two literal refinements for up to
120 seconds; clarification prompts keep the existing 30-second expiry. Standalone questions get
no note. Retrieval V2, planning, reranking and final verification share this scope; original
questions/quotes remain intact. The note contains no generated answer facts, creates no new
memory store, and never enters the isolated public web/general-knowledge path.

`voice_decision_flow.py` defines literal decision fields, bounded reprompts, correction/cancel/leave and exact evidence-quote checks. Proposed/decided describes discussion evidence; owner approval remains the separate existing voice-draft review. The worker extracts structured patches and independently verifies decided evidence before the control plane can stage a review prompt.

At draft-history capacity, Task/Decision Flow retains the original request and literal snippets proving current fields plus the newest input. Cancel/leave do not append input; confirm remains explicit with the same final-turn check. This bounds retained history without discarding current-field provenance or trapping control commands at eight entries. TaskState.save_uncertain, like DecisionState.save_uncertain, pauses blind reconfirmation after an unknown write; cancellation and private chat handoff remain available.


Voice history preserves an optional `follow_up` question separately from verified answer facts.
Completed, source-valid follow-ups use the existing 30-second pending clarification context for
short replies in retrieval and LiveKit planning. An acknowledgment does not become source evidence.
