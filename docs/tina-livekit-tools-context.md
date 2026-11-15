# LiveKit tools and heard context

The core now serves [Retrieval V2](tina-retrieval-v2.md) behind the same capability boundary.
Local search argument schemas accept optional speaker/time narrowing and soft entity hints;
normalization keeps the existing bounded query wire shape. Returned evidence refs preserve original
quotes/keys/fingerprints; lexical aliases, ranks and entity hints are never new meeting facts.

LangGraph owns up to two bounded API tool batches inside the LiveKit LLM adapter. LiveKit keeps the per-caller ChatContext in its existing
three-meeting worker (one process/replica). TINA owns source permission, model credentials, retrieval, verification,
reservations and actual microphone receipts. ASR, KWS, VAD and VieNeu-TTS are unchanged.

Internal capability-authenticated `POST /bots/voice/{meeting}/{session}/agent` has context, plan and
lookup operations. Context reserves the existing room turn, then returns at most three source-valid
heard user/assistant turns. Each plan calls the selected LLM for up to two read-only tool requests; a second plan sees completed lookup queries and source excerpts and may stop or target missing details.

Provider plans use `{name, arguments}` with a separate argument schema for each tool. Search query,
source/context handles, draft request, arithmetic expression and explicit calendar dates are no
longer overloaded inside the LLM's query string. Shared validation normalizes them to the existing
`{name, query}` API/Redis representation before execution. Existing query-format clients/planners
remain compatible. The unchanged 200-character canonical query limit and current room permissions
still apply; unsupported scope/path/owner fields cannot enter the normalized call.
Lookup executes only transcript/shared linked Markdown/Wiki queries allowed by current room policy.
Voice document loading prioritizes the explicit room selection before the eight-document evidence
budget. Selected Wiki targets still require a unique current link from a direct meeting document;
if needed, discovery examines additional meeting-linked roots (at most 1000), without retaining
those roots as extra evidence. Generic meeting Q&A keeps its existing bounded discovery behavior.
Unlinked, ambiguous, missing or unsafe selected paths remain unavailable.
Unreadable unselected listing/discovery files do not block independently verified selected evidence.
Selected read failures remain service errors. If an unreadable direct root leaves a selected Wiki
link unproven, retrieval fails closed as unavailable rather than assuming permission or absence.
Generic meeting Q&A retains strict read-error handling.
Public web lookup requires owner opt-in and the exact explicit public query; private room context is
never exported as a generated search query. Worker-supplied source quotations are never accepted.

The local `StateGraph` runs plan and lookup nodes, then calls the existing verified answer endpoint
with `agent_context`. There is no second SDK function-tool loop, graph checkpoint or external trace.
Only verified final text reaches the LiveKit output stream. TINA accepts only context matching its own
completed-playback history (or nonempty stopped played prefixes), recomputes authorized retrieval,
and verifies/rechecks the final reply before registering playback. Finalization uses the original
request ID/room reservation. Stop/policy/session changes fence every later tool/final response.
The numeric check recognizes unambiguous Vietnamese word/digit equivalents, percent spelling,
signed decimals and monetary scales/aliases only in a comparison view. It preserves source text,
citations and final wording; changed amounts, signs and units remain blocked. Ambiguous forms stay
literal and every numerically supported reply still needs semantic verification. The production
guarded LLM reranker and retrieval policy are unchanged.

SDK contexts are keyed by hashed transport participant within meeting/session/policy revision, not
account identity. Unknown speakers retain no personal context. At most 32 callers and three turns
per caller are retained, with 15-minute expiry. Generated but unheard proposals never enter the
retained context; the next turn refreshes it from TINA's actual playback receipts.
Redis holds at most three confirmed turns plus one pending reply,
while SDK/core prompts receive only the last three heard turns. Failed or stopped-unplayed
attempts do not consume a heard slot; stopped completed prefixes retain only their confirmed text.
Tool results stay in TINA's authorized retrieval snapshot and cannot grant source permission or become history
facts. The native TINA path keeps its current tool loop and does not use this protocol.

LangGraph runs pairs of independent local transcript/Wiki/approved-action reads concurrently,
with at most two in flight. Non-read/dependent/mixed batches remain sequential. TINA atomically
reserves the same four-call budget, revalidates each result and stores successful/completed calls
in original plan order. The graph waits for all calls before planning/finalizing; Stop or fatal failure
cancels and drains siblings. Core lease/policy checks reject remote work that completes after
cancellation. No new tool round, broader source scope or retry is introduced.

Local read responses now add `lookup_status` (`found`, `empty`, `unavailable`) without changing the
lookup request shape. A temporary read failure consumes its planned slot and is marked completed,
not executed. It retains the lease while another source finishes. Graph assessment routes partial
success to the existing verified answer API, all-unavailable/no-success to service failure, and empty
searches to the remaining bounded plan round. Core also refuses final dispatch if a read failed and
no source lookup found evidence. Permission/session/source changes (401/403/404/409), Stop, malformed
results and uncommitted transport errors remain fatal; successful sibling results cannot override
revocation. A successful count is not factual proof: TINA still verifies/rechecks every released claim.

To try it, select **Settings → Voice assistant → Room answers → LiveKit Agents · local pilot**
for the active Google Meet and explicitly share its transcript and the linked project document.
After actual meeting speech says who owns the demo and its deadline, ask “TINA ơi, ai phụ trách
demo?”, wait for playback, then ask “Còn hạn bàn giao?” in the follow-up window. Compare against
Wiki with “TINA ơi, đối chiếu quyết định vừa rồi với tài liệu dự án.” For public web, enable the
room's web permission and say “TINA ơi, tìm trên web về LiveKit Agents.” Private transcript text
is never automatically turned into a public search query. These manual checks require a working
selected LLM subscription/API; passing fixture tests does not prove provider quota or live meeting
recognition and listening quality.

Focused checks: `uv run --project deploy/livekit pytest deploy/livekit -q` and the meeting API's
`test_meeting_voice.py` / `test_speech_status.py`. The worker image's `python smoke.py` uses a real
self-hosted room, LangGraph API tools, heard ChatContext and local VieNeu synthesis with a synthetic
Meeting API; it does not use private meeting data or prove Google Meet playback.

Assistant identity, basic social/capability requests and unsupported external actions are routed
from server-owned metadata without transcript fact generation or tool planning. General knowledge
remains opt-in and public search remains explicit. Ambiguous/compound room questions keep the
meeting evidence path. This is a conservative local intent router, not an unrestricted LLM router.

After a factual draft fails numeric or semantic verification, one repair is allowed using only
the same approved evidence. The repaired draft is verified again; no new tool batch is introduced.
A supported partial answer may append one short follow-up question. Provider/verifier failures
fail closed without a repair. Generation/review/repair calls share a 50-second scheduling budget
inside the existing API timeout. Persisted verification contains at most two enum codes, never
private drafts or reviewer text. Existing source/revision and caller/heard-history checks apply.

Long transcript segments and shared Markdown paragraphs are fully covered by overlapping voice-only chunks (up to 1200 characters, 200-character overlap), preserving parent identity, full-source fingerprint, speaker, parent time interval and exact character offsets. Search ranks these chunks and includes adjacent context within existing budgets. Source edits revoke chunks; legacy history referencing a formerly long parent may be dropped conservatively. Short source identity is unchanged. This applies to native and LiveKit answers; raw transcript and generic meeting Q&A storage are not rewritten.

Voice RAG now combines BM25 and CPU-local multilingual-E5-small INT8 semantic retrieval through reciprocal rank fusion. Search receives only the authorized chunk snapshot and final answers retain the same source checks. Token windows cover long inputs without dropping their tails. Model/tokenizer bytes are revision/hash-pinned and baked into Agent API, not downloaded on a meeting request. The private RAM cache stores vectors (no source text), is capped at 8192 entries/15 minutes and scoped by owner/meeting/policy/key/fingerprint. Cold cache encoding has a three-second budget per call (plus the running inference batch); later calls fill remaining chunks. Busy or unavailable embedding falls back to lexical retrieval. Public-web/general routes do not receive private semantic context. No vector database or new cloud credential is needed.

Whole-meeting recap requests bypass keyword tool planning and process every approved transcript chunk in chronological parts (up to 12 sources/12000 characters each). Per-part facts are verified, bounded reduction groups select salient facts, and the spoken final result is verified against original transcript chunks plus related evidence. Transcript permission is mandatory; shared documents are excluded from this recap path. The source snapshot is taken when asked; appended speech belongs to later recaps. Policy/source changes revoke release, including changes to uncited input segments. Private RAM caches map/selection/verify jobs by owner/meeting/policy/input fingerprint for 15 minutes (512 jobs, three concurrent tasks). Unfinished work returns summary_pending and resumes when asked again. It does not write canonical transcript/notes or Wiki.

Supplemental lookup is limited to two plans/four attempted tools and a 30-second shared retrieval
deadline, beginning with the core room reservation. `read_source_context` accepts only an opaque
ctx-SHA256 handle returned by a successful lookup in the same question. Core stores the allowlist;
the authorized API resolves it against current source fingerprints and reads at most three
neighbors before/after in the same document/parent chunk or within 30 seconds of transcript audio.
A source edit invalidates the old handle. No arbitrary path, source key or owner identity is accepted.
When time expires, tools are marked skipped and final generation reuses only successful lookups;
web timeout yields web_unavailable rather than another search. Merged excerpts share their budget
across rounds so a later lookup does not evict the earlier useful result. Final source verification,
Stop/session/policy fences and heard-only history remain in TINA. Native JSON tool planning retains
its one-round behavior; whole-meeting recaps still use their separate map/reduce flow.

Supplemental service failures also keep successful prior queries available for verified final
generation. Graph node calls are bound to the exact turn object, preventing a late result from
attaching itself to a later question. No source or permission check is bypassed by this fallback.

Voice answers now retain verified source references through playback receipts. Terminal and Extension show a collapsed Sources control, load fresh owner-authorized evidence on open, and clear quotes if validation fails or sharing changes. Source details include speaker/time or document paragraph and links to the original transcript/document via Terminal. Historical replies created without saved references are not backfilled. This is read-only evidence display; the ASR/KWS/TTS and answer verification pipelines are unchanged.

Pending clarification tasks and owner-only progress labels extend this same bridge; see [clarification and progress](tina-voice-clarification-progress.md). They reuse the current SDK version, tool loop and heard-context authorization rather than adding a second task orchestrator.

Explicit action requests may also propose draft_task/draft_decision through this same bounded loop. Publication requires a completed readback and the authenticated meeting owner's separate Terminal confirmation; see [voice action drafts](tina-voice-action-drafts.md).

Explicit same-caller updates while THINKING replace the old task after acknowledged cancellation. See [task refinement](tina-voice-task-refinement.md) for source/caller fences, public-query restrictions and late-result behavior.

Speaking interruptions also accept bounded same-caller soft corrections, retain the original question and persist completed-sentence prefixes before remote cancellation. See [speaking interruption](tina-voice-speaking-interruption.md).

Approved task/decision retrieval and deterministic numeric/date tools extend the same bridge; see [approved actions and calculations](tina-voice-read-calculate.md). Action sharing defaults off and public routes remain isolated.

Owner-selected other meeting transcripts can be compared through search_shared_meetings with attributed source inspection. See [shared meeting voice sources](tina-voice-shared-meetings.md).

Read-only source navigation uses the same LangGraph loop, then a once-claimed owner Terminal hint after playback. See [voice source opening](tina-voice-open-source.md).
