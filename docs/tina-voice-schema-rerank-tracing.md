# Voice schema, reranking and timing

TINA reuses its existing LiveKit/native orchestration, CompletionPort model selection and source
permissions. These changes adapt useful AgentScope patterns without installing AgentScope or
adding a second RAG store. ASR, KWS, voice capture and VieNeu playback are unchanged.

1. OpenAI Responses/compatible Chat Completions receive strict JSON Schema for voice answers,
   tool plans and source review. The schema restricts cited IDs to the supplied authorized set.
   Explicit unsupported-format responses fall back to the existing validated completion path;
   other provider errors do not. Other adapters retain their current validation path.
2. Queries with more than eight retrieved excerpts optionally call the selected LLM once to rank
   up to 12 IDs, with a four-second HTTP timeout. The generation prompt keeps the top results,
   recent speech and heard-history references, up to 32 excerpts/24000 characters. A valid empty
   ranking is `empty`, retaining only explicit recent/heard pins and no automatic comparison pins.
   Invalid rankings, timeout and oversized pinned context retain the original excerpts as `fallback`.
   Numeric/entailment review still sees original evidence, so a dropped correction cannot authorize
   an obsolete answer. After `empty`, generation and format/semantic repair are restricted to the
   retained pins; discarded excerpts cannot be restored by repair. A verified empty reply is
   `retrieval_empty`, without relabeling real service errors. Whole-meeting recap retains its
   separate all-chunk map/reduce/verify flow.
3. Meeting API forwards the validated bot request UUID as `X-Tina-Voice-Request-Id`. Agent API
   carries it into its internal worker dispatch envelope, separate from the model input.
   `voice_stage` JSON logs report `agent`, `tool_context`, `tool_plan`, `tool_lookup`, `answer`,
   `answer_service`, `semantic_retrieval`, `source_selection`, `rerank`, `generation`, `verify`,
   `repair`, `format_repair` and `web_search` as applicable. Fields are UUID, status, elapsed milliseconds and
   bounded numeric counts. No room text, tool arguments, identities or credentials are recorded.

The existing bot `voice_timing` events use the same UUID and measure speech/ASR and microphone
playback. Server stages measure service work, not proof that someone heard the reply; only the
existing playback receipts advance heard history. Concurrent or nested stage durations overlap
and must not be added together. Ranking adds a model call; its net quality/latency benefit still
needs evaluation on representative meetings before claiming an improvement.

Offline tests are in `core/agent/tests/test_voice_structured.py`, `test_voice_rerank.py`,
`test_voice_trace.py` and both domains' voice API suites. No new settings, credentials or models
are needed. Stop, source-policy revisions and final source fingerprints retain their existing fences.
