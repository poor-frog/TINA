# agent · worker

The agent worker: runs a single agent workload to completion. Owns the generic turn engine
(`engine`), the per-meeting loop (`meeting`, `meeting_transcript_mcp`), and its container image
(`Dockerfile`). Model/harness access goes through the provider-agnostic [`llm`](../llm) ports —
card beats via `CompletionPort` (a direct HTTP completion), workspace turns via `HarnessPort` (the
`TINA_RUNNER`-selected CLI agent); no vendor name lives in this package. Spawned by the control
plane; liveness = workload lifecycle.

The image installs the operator-owned Codex command-network policy from
`codex-requirements.toml` at `/etc/codex/requirements.toml`. It limits online shell traffic to the
listed GitHub hosts and prevents workspace configuration from widening that list. The adapter
selects an offline profile for untrusted/read-only turns; keep the managed `enabled` field unset.
See [Codex networking](../llm/README.md#codex-web-and-command-networking) for the separate hosted
web-search grant, credential boundaries and verification scope.

Terminal dictation polish is a one-shot, read-only `CompletionPort` job in the worker. It has no
harness tools and does not write chat history or workspace files.

TINA Capture live translation is also a one-shot, tool-less `CompletionPort` job. It receives one
confirmed transcript segment and a fixed target-language code; the source is treated as untrusted
text, and the translated result is returned to the loopback client without writing transcript or
workspace history.

Meeting transcript translation reuses this same entrypoint with one backend-grouped phrase as
its source text. `engine.py` passes the saved `TINA_MEETING_MODEL` override to CompletionPort
(falling back to its configured completion model when absent). The shared `translation_text`
helper removes inline reasoning and rejects unusable output before emitting a message delta.
Failures emit no translated text and do not log the transcript or provider response body.
The private terminal `turn-complete` marker carries an optional fixed `translation_error` code
(see `meeting-translation.v2`); it never carries exception text. Typed adapter status and transport
errors distinguish phrase timeout/output failure from owner-wide auth/quota/service cooldowns.
The control plane accepts translated deltas only after a successful completion marker, discarding
partial output on error or an interrupted stream. Deploy worker and control plane together to
enable this classification; a legacy worker's empty result remains a conservative service error.
The control plane owns phrase grouping, persistence, leases and retry; this worker performs
only the tool-less translation and leaves original/canonical transcripts unchanged.

# Canonical notes jobs

`processed_notes.py` handles the private canonical-window entrypoint before the legacy live loop.
It calls the existing tool-less meeting CompletionPort using canonical text and resolved speaker
names, then emits a candidate result. It does not publish live notes, edit canonical text or
overwrite workspace documents. Meeting API owns source/lease validation and final publication.

New meeting policies select `agent_backend: sandbox`. Voice planning and answer generation use
an ephemeral instance of the account's configured CLI harness. LangGraph authorizes/executes its
structured source-tool proposals. Legacy `completion` remains selectable. Classification, reranking,
format recovery, repair and independent factual verification use CompletionPort.

Sandbox planning and ordinary answers request native JSON Schema where supported. Existing
tool/citation validators still run after generation. Malformed plans get one bounded CompletionPort
format repair with the same available tools and retrieval deadline; ordinary answers retain their
existing single format regeneration. No harness service/auth failure triggers this repair or an
automatic Direct LLM fallback. If answer format repair still fails, `generation_format_invalid`
is a generation error, separate from an empty retrieval or a factual `verification_rejected`.
Stop/current-turn checks also fence repaired output. General/public/map generation receives its
corresponding schema where available; this does not grant tools or bypass its existing validation.

Knowledge jobs mount no account workspaces or chat tools. The sandbox receives only the authorized
question, excerpts and receipt-confirmed conversation. CLI execution, web and MCP grants are disabled; source
lookups go through TINA's existing tool budgets and policy checks. Its private cwd and CLI history
are disposable; no CLI session is resumed. The existing caller-scoped heard history provides
multi-turn context without retaining unspoken candidates or revoked evidence.

`voice_sandbox.py` bounds the complete harness process group to the remaining job budget (at most
40 seconds), polls the current room lease with bounded Redis I/O and kills subprocesses on Stop or
timeout. Data-plane credentials are removed before launch. No candidate/tool event reaches TTS
without the existing source/numeric/semantic checks. Voice cannot publish workspace edits.
Codex may still advertise built-ins such as `apply_patch`; its read-only filesystem profile, not an
empty tool catalog, prevents file writes. A JSON Schema request does not expand those permissions.

The server-owned retrieval deadline still bounds planning; exhausted internal planning budgets
use the existing empty-plan verified-answer path. Other failures retain the normal error handling.

Voice review and one optional repair share the remaining completion deadline. No repair runs after verifier outages; every corrected claim and follow-up is checked again.

Recap map jobs use the normal numeric/semantic review and repair; reduction jobs select/compress cited map facts but never authorize evidence. A separate final verify job reviews original transcript chunks. All jobs keep the selected CompletionPort model and existing bounded completion deadlines.

Malformed ordinary voice replies get at most one final JSON regeneration within the same
50-second completion budget. This includes prose around JSON and unexpected tools in a final-only
step. Regeneration receives the original sources/question and untrusted failed output, cannot
request additional TINA lookups/actions, and must pass claim validation and semantic review. Invalid recovery and provider
failures still fail closed; private drafts are never logged.

Meeting voice uses optional provider-side JSON Schema for generation, plans, review and repairs.
A larger retrieval (>8 excerpts) first gets one optional ranker call with a four-second HTTP timeout,
using the same selected model and authorized excerpts. Rank failures retain the original retrieval;
the ranking call has no capability fallback retry. This call consumes the existing 50-second
scheduling budget; source/numeric/semantic checks and one-repair limits remain mandatory.
Structured `voice_stage` logs correlate ranking/generation/review/repair with the bot request UUID
forwarded by Meeting API and the control-plane dispatch envelope. No content is logged.


`voice_source_intent` is a bounded, structured, question-only source classifier used for opt-in
automatic public web routing. It receives no private source excerpts/history and cannot execute
tools. Its four-second provider timeout also respects any remaining retrieval deadline.

Sandbox turn checks cover every model stage, including API-only classification, recap verification,
format recovery and repair, plus the final output. A call already in flight may finish, but cancelled
results and subsequent calls are blocked. Timeout fallback plans also require a live turn.
Process-group cleanup includes descendants whose leader has exited. Claude prompt input is written
concurrently with stdout consumption, preserving structured CLI errors when stdin closes early.

Both Direct LLM and sandbox live voice jobs carry server-owned room leases. Agent API checks the
lease through a cancelable stream reader every 250 ms and requests runtime Stop for exactly that
isolated worker when revoked. Worker stages also reject revoked results. This cannot undo provider
work or charges already incurred before Stop. Public voice answers require Agent-Reach original
excerpts and the independent verifier. A native provider summary with links alone is not evidence;
without the retrieval service the public voice route reports web_unavailable.

Public web failures preserve separate reasons: web_no_sources means no usable original excerpts;
web_answer_empty means generation produced no claims; web_numeric_mismatch means deterministic
numeric/unit checks rejected every remaining claim. generation_format_invalid, llm_unavailable,
verification_rejected and verification_unavailable retain their existing meanings. Content-free
voice_web_result logs record the voice request UUID, retrieved-source count, outcome and verification
codes, plus allowlisted upstream retrieval errors. A blocked answer never becomes a successful
factual response. LiveKit lookup and final delivery retain the same reason/checks in VoiceReply.

Public voice retrieval reads two top distinct page URLs concurrently and may refine an unanswered
public question once. Across both rounds it attempts at most three page reads and retains six
original excerpts (5,000 characters each). Refinement uses the completion API with a validated
query-only schema, never the sandbox's private context. Generation still uses the selected direct
or sandbox backend, followed by the existing independent verifier. The core's lookup deadline is
forwarded into voice_web and bounds search, reads, refinement, generation and verification together.
See [Agent-Reach limits](../../../deploy/agent-reach/README.md) for fallback and cancellation behavior.

Public voice verification now allows one API-only repair using the original public question, draft, rejection indexes and unchanged excerpts. The repair shares the voice deadline and lease, cannot search or access a private workspace, and must pass numeric and semantic verification again. A later semantic failure is reported as verification_rejected rather than retaining an earlier numeric label. Supported subsets are reviewed independently before release.

Gold-price web questions use an eight-row structured extraction instead of free-form numeric claims. Each row binds source ID/URL, literal product/amount, side, scale, currency, per-lượng/per-chỉ/per-ounce basis and optional original update text. An independent API reviewer checks row/column/table/date relationships against all original excerpts. One repair shares the existing deadline and Stop fence. Fixed output retains source date/time, avoids cross-source buy/sell merging and warns when a today request lacks a matching price update date. Missing product uses the existing heard clarification flow; only fixed public product choices resume it. `price_extract`, `price_repair` and `price_verify` spans contain timings only.
