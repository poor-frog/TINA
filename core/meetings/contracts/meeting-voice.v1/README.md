# meeting-voice.v1

LLM planning uses internal per-tool `arguments` schemas and a shared normalizer. The wire contract
here remains `{name, query}` for `VoiceLookupQuery`: typed expression/date/handle/request fields are
validated and converted before reaching HTTP/Redis. Legacy query calls and existing golden payloads
remain valid; tool-specific argument validation does not expand source permissions or query budgets.

Independent LangGraph local read pairs may execute concurrently; the existing lookup shape and
two-round/four-call budget do not change. TINA reserves each call atomically, rechecks policy and
keeps executed/completed calls in planned order for deterministic follow-up retrieval. Both calls
must settle before the next plan/final. Stop and revoked sources still fence late completions.

The internal local-read operation response optionally reports `lookup_status`: found/empty/unavailable.
Unavailable reads are completed but excluded from executed queries and consume the same budget.
Core retains a turn for sibling completion but refuses final answer dispatch if no successful evidence
lookup remains after a read failure. This additive internal result metadata does not change the
published lookup request or golden payloads. Source/session permission failures remain fatal.

`VoiceReply` describes an owner-only validated TINA answer, its generated request ID, receipt state
and server timestamps. Durable meeting history is separate from participant `transcript.v1`; stopped,
failed or unconfirmed answers may contain unspoken text. Terminal and Extension render the same
history through `GET /meetings/{id}/voice-assistant`. Full answer text never enters diagnostics or
generic transcript/share payloads. Artifact deletion also deletes reply history.

Core-owned room voice policy, bounded question request, and bounded runtime diagnostics. Newly spawned capable Google Meet rooms with transcription enabled receive an explicit initial policy: LiveKit Agents selected, Voice assistant on, NS Low on, own-meeting transcript/general knowledge/explicit public web enabled, no documents. Existing saved room choices survive continuation; a room with no saved policy gets the new defaults on its next capable spawn. Request-model defaults and legacy reads remain conservative rather than reinterpreting old missing fields. Policy updates compare revision and increment it. Capability-authenticated bot routes bind meeting and active session; public GET/PUT is owner-scoped. Question requests may not supply documents or an owner identity. Active room state is ephemeral; original audio/transcripts are not rewritten.

New KWS-capable bots accept acoustic TINA ơi / hey TINA through LiveKit WakeWord 2.1.1.
`wake_variants` remains a revision-bound owner-approved list of at most eight exact ASR name aliases
for cleaning a captured question copy and compatibility with older ASR-addressed bots. It grants no
activation authority to ASR text in a new KWS bot. Raw/canonical transcript is unchanged.

`VoiceState.kws` optionally reports pinned engine/version, CPU, activation mode, off/starting/ready/
failed state, exactly the two retained model IDs and original observation time. Capability/session
checks and 15-second freshness apply. Settings services reports only active owned meeting sessions;
shared rooms, previous sessions and expired reports cannot establish readiness. Older bots may omit
this field and are shown as requiring a new bot rather than ready. No token, participant ID or audio
is accepted in this snapshot. `kws_unavailable` is an allowlisted failure diagnostic.

Settings services also returns `new_meeting_policy` from the same factory used when spawning a room.
Terminal displays these defaults without an active meeting; optional room overrides remain separate.

Completed playback may open a 15-second local follow-up window on the same channel and known
participant ID. It confers no extra source/account permissions. Missing identity, Stop, expiry,
policy change or failed playback requires a new wake. The bot reuses the existing answer request
shape and speaker header; private source-validated history marks completed clarifications so a
short follow-up can answer them. No transcript rows are rewritten.

Optional `VoiceReply.played_text` separates completed playback from the full generated proposal.
Interrupted (`stopped`) history forwards only a nonempty played prefix and clears pending
clarification state; replies without confirmed prefix are excluded. Source fingerprints, speaker,
session and policy gates still apply. Cards show whole completed sentences for known stopped
progress; legacy unknown playback remains explicitly uncertain. No partial-word claim is made.
Diagnostics include `waiting_turn_end` and `interrupted` for bounded pause waits and explicit stops.

## Owner diagnostics

Bot `VoiceState` optionally carries a `VoiceDiagnostic` with a UUID event ID, allowlisted reason
code, original observation timestamp, optional source channel/start and at most the first three
ASR words (64 characters). It never carries the full question. `heard_at_ms` preserves the age of
text across later phase changes. Older bots may omit diagnostics.

Meeting API binds every write to the active bot session and exposes diagnostics only via the
owner-scoped voice settings endpoint. State heartbeats expire after 15 seconds; the separate
`meeting:voice:{meeting}:diagnostic` key expires within 30 seconds of the original heard/observed
time. Retries of an event ID and delayed older observations cannot extend/replace a newer event.
Expired, departed or previous-session details are not returned. These fields never write to the
canonical/raw transcript, meeting JSONB, recordings or application diagnostic logs.

The owner runtime response includes `session_active`, `heartbeat_fresh` and optional `diagnostic`.
No heartbeat is not interpreted as a listening bot. Terminal invalidates runtime on failed reads and after 15 seconds without a successful read, including a hanging poll; recovery preserves unsaved policy edits. `evidence_available` on the private answer
response distinguishes an insufficient-evidence fallback from a supported response; the source
and policy validation path remains authoritative.

Optional `VoiceState.audio` carries `AudioSnapshot` with at most 16 distinct `AudioChannel` numeric
rows. It is session-capability authenticated and returned only by the owner runtime endpoint.
Snapshots share the 15-second status expiry; original observation timestamps prevent a delayed
snapshot from appearing fresh. No frame payload, transcript, name or participant ID is accepted.
Queue latency is measured by the backend; an absent measurement stays null/absent. Sample-index
gaps/overlap are observations, not assertions about network loss. Older state producers remain valid.

## Optional conversation scope

Bot answer requests may include `X-Voice-Speaker-Key`, a 64-character SHA-256 of the transport
participant ID. The JSON question contract is unchanged. Unknown participant identity omits the
header and disables personal history; channel IDs and display names do not infer a person/account.
Meeting API scopes its private Redis history by meeting, bot session, policy revision and speaker
key. At most three turns live for 15 minutes; only completed playback receipts may enter the next
prompt. Agent revalidates all historical source fingerprints against currently approved sources.
Questions/history never enter public reply projections, transcript rows or diagnostic logs.

Room answer modes are separately authorized by `VoicePolicy.allow_general_knowledge` and
`allow_web_search` (both false for missing/legacy fields). Settings → Voice assistant → Room answers
edits the active owner's room with the existing revision check; a change cancels the current turn.
Meeting mode can request one round of at most two read-only lookups: recent transcript, keyword
search across the authorized transcript snapshot, and explicitly shared linked Markdown/Wiki.
The model cannot open arbitrary paths. Excerpts, output length and lookup counts are bounded;
all factual meeting claims retain source validation, verification and the final revocation check.

Public web requires a spoken `Tìm trên web về …`, `Tra cứu web về …`, or `Search the web for …`.
Only that explicit query is sent; transcript, documents and voice history are excluded. The configured
completion adapter must support native web search (currently OpenAI Responses); unsupported or
uncited results fail visibly. Standalone definitions or `Kiến thức chung: …` use an isolated general
completion, never a fallback for an unsupported meeting fact. General/web answers announce their
kind. Both modes still recheck room policy before releasing an answer, and neither writes Wiki.

`VoiceReply.answer_kind`, `reason`, `lookups` and `links` preserve a bounded explanation separately
from playback state. Failure reasons distinguish no approved sources, retrieval miss, insufficient
support, rejected/unavailable verification, LLM failure and disabled/unavailable web/general modes.
Public links come from provider citation metadata, are validated as HTTP(S) and displayed as links
in Terminal and Extension. They are not fabricated from model text. Existing replies default to
meeting/answered with no links. No model, audio window, canonical ASR row or source permission is
changed by these answer-mode additions.

`VoicePolicy.engine` is `tina` (default, including old records) or `livekit` (explicit one-meeting
self-hosted pilot). The owner changes it with the existing revision check and Stop fence. LiveKit
configuration/readiness is separate from TTS readiness. New bots advertise `X-TINA-Voice-Runtime:
livekit-v1`; old bots cannot silently run native voice under a selected pilot policy. The bot config
carries the scoped internal agent URL; no LiveKit server secret or owner API key reaches the bot.
Confirmed selected-ASR text goes through AgentSession's TINA LLM adapter and local VieNeu TTS
adapter over custom HTTP I/O. Actual heard-prefix/Stop receipts remain controlled by the bot,
not by SDK audio-delivery events. Source, session and caller fences remain unchanged.

LiveKit Agents uses internal capability-only `POST /bots/voice/{meeting}/{session}/agent`
(`VoiceAgentQuestion`: context, plan, lookup). Context reserves the request and returns at most three
source-valid heard turns. The selected LLM plans at most two read-only queries; SDK function tools
execute only that plan. Final `VoiceQuestion.agent_context` must match the caller's actual completed
or stopped-prefix playback history; source references stay server-side. Query and completion budgets
are reserved atomically; Stop, policy/session changes and mismatched callers fence later operations.
Native TINA requests omit `agent_context` and keep their existing tool loop. `VoiceLookup.tool` also
accepts `search_web`, authorized only for an explicit public query and room web opt-in.

`VoiceReply.answer_kind=assistant` marks fixed server-owned identity, greeting, thanks, capability
and unsupported-action responses. These contain no meeting facts and grant no new sources.
Compound or unrecognized requests retain conservative meeting routing; public web remains explicit.
`verification` records up to two content-free codes: approved, numeric_mismatch, unsupported_claim,
contradiction, ambiguous, unavailable, repair_failed. A first rejected draft may be repaired once
against the same approved evidence and must pass numeric and semantic checks again. A provider
outage skips repair. Supported claims may include a separately validated short follow-up question.
Original drafts and reviewer prose are never persisted in this metadata. Source fingerprints,
policy/session/Stop fences and actual played-prefix history remain authoritative.

Voice retrieval may expose a bounded chunk of an authorized parent source, identified by a deterministic voice-chunk key. Source fingerprints include the parent fingerprint and the exact character range. Per-chunk timestamps retain the parent interval. Source references still use key/fingerprint; they grant no additional source authority.

VoiceReply.reason includes summary_pending for recap preparation that exceeded the bounded wait. The bot announces slow recap work once, then automatically plays the verified result in the same reserved turn. All background map/select/verify stages share a 120-second waiting budget; an expired run returns no partial facts or promise of later playback. Completed recaps retain answer_kind meeting and existing original-source references/verification. Transcript capture continues; another voice question requires stopping/correcting the active turn first.

Internal `GET /internal/meeting-voice/{meeting}/turn/{request}` returns `VoiceTurnPermit` to Agent API
only with the matching service secret and owner header. Its boolean confirms the current exclusive
reservation and active bot session, never an account identity derived from a speaker. Every recap
job checks it before and after inference. Source-policy revisions and fingerprints are checked
separately; Stop, replacement sessions/requests, departure and artifact deletion fence late results.
The room lease is 360 seconds; the bot's 330-second total budget leaves time for bounded playback.

The LiveKit agent protocol now allows at most two plans, two tools per plan and four attempted lookups total. VoiceLookup/VoiceLookupQuery add read_source_context, whose query must match ctx-[0-9a-f]{64} and appear in the same turn allowlist. VoiceReply.lookups holds at most four traces. The 30-second retrieval deadline skips unfinished work without discarding successful earlier queries; finalization waits for attempted/skipped tools and uses executed queries only. Native tool planning remains one round; recap preparation uses its separate protocol.

VoiceReply.source_refs is internal durable metadata (key/fingerprint only); public history strips it and derives source_count. VoiceSources returns up to 32 freshly authorized source quotes and an unavailable count. Source reads recheck current room sharing, linked documents, source fingerprints and artifact deletion; ended meetings remain owner-readable. Sources do not enter public transcript/share payloads.

Turn ownership remains exclusive per meeting. Admission may atomically replace a reservation only when its known bot session has been superseded; current and unrecognized reservations remain fenced. Retired playback is stopped without rewriting canonical transcript or source policy. No request/response schema changed for this recovery.

Agents also uses capability-authenticated `GET /bots/voice/{meeting}/{session}/turn/{request}?revision=...`
returning the same VoiceTurnPermit. No internal service secret or owner/provider key is needed.
It confirms the exact Redis reservation, active session and current LiveKit policy revision before
PCM synthesis, periodically while streaming and at completion. SDK Stop-cache loss after restart
cannot authorize an old or another meeting's request.

`VoiceProgress` is optional owner-only runtime metadata: allowlisted stage, request/session IDs, policy revision and observation timestamp. It is returned only during THINKING for the exact live room lease, with a 180-second TTL. Bot VoiceState payloads remain unchanged. Clarification intent can retain source-free, completed questions for the same caller; pending state expires 30 seconds after the latest clarification and never grants factual source authority. See docs/tina-voice-clarification-progress.md.

VoiceActionDraft/VoiceActionReview describe owner-reviewed task and decision proposals. The existing LiveKit tool names additionally allow draft_task/draft_decision, with the same query and turn budgets. Only explicit spoken action requests offer those tools. Finalization records a private draft; owner GET/review requires the completed readback and current policy. Approval writes one create-only workspace entity; voice has no approval tool. VoiceProgress.stage also accepts drafting. See docs/tina-voice-action-drafts.md.

Question/state shapes remain unchanged for task refinement. A same-caller explicit update during THINKING is combined with the original user intent only after cancellation acknowledgment and gets a fresh request UUID. Old request-bound state cannot overwrite a replacement lease/capture. Public queries need explicit restatement; see docs/tina-voice-task-refinement.md.

Speaking interruption keeps existing contracts: only confirmed completed-sentence played_text enters stopped history. The bot reports this prefix before core cancellation, and does not resume automatically if receipt delivery fails. Same-caller final soft corrections extend recognition without changing source permissions or canonical ASR. See docs/tina-voice-speaking-interruption.md.

VoicePolicy.include_approved_actions is optional/default false and shares only owner-approved voice task/decision entities from this meeting. VoiceLookupQuery/VoiceLookup additionally allow search_approved_actions and calculate. VoiceSource.kind also accepts calculation with required calculation_query and no fake document/transcript identity. Derived inputs/results are re-evaluated against current authorized operand fingerprints. See docs/tina-voice-read-calculate.md.

VoicePolicy.shared_meeting_ids defaults empty (max four distinct positive other-owned IDs). Saving and querying recheck ownership/artifact deletion. search_shared_meetings is an additional read-only tool; current-only tool semantics remain unchanged. VoiceSource optionally carries meeting_id, meeting_title and meeting_start_time for attributed evidence. See docs/tina-voice-shared-meetings.md.

open_source is a server-selected cited-handle tool for same-caller recently completed answers. VoiceNavigationHint is optional owner runtime metadata and VoiceNavigation is the once-claimed, freshly reauthorized target; claims require owner auth and completed acknowledgment. See docs/tina-voice-open-source.md.

`VoiceAgentQuestion.operation` additionally accepts `flow_plan` and `flow_apply` for Pipecat task
draft conversations. The existing capability, request UUID, revision and caller hash fence both.
Context optionally returns `task_flow.node` for an explicit task request or a same-caller flow
whose last exact prompt completed playback. Slot state and cached model proposals stay core-owned;
workers cannot submit fields, authorize sources or approve/publish a draft. Plan/apply run once per
reserved turn before the normal final answer, which preserves playback receipts and owner review.
State expires after five minutes, is limited to eight user turns, and is not RAG or source evidence.

Recovery adds `no_input`/`dialogue_paused` diagnostics and `clarification_exhausted`/`draft_unavailable`
reply reasons. Paused clarification and service failures do not arm a follow-up. A completed
source-free terminal-history marker closes a clarification chain; history updates are lease-CAS
fenced. Failed TTS can recover retained task fields only by re-asking the missing prompt, without
interpreting new slot data or writing a draft. Stopped/queued prompts cannot resume a flow.

## Private voice-to-chat handoff

An identified caller's paused clarification or answer-service failure can expose optional `runtime.handoff` (`VoiceHandoffHint`) alongside the existing voice status. Normal answers expose no handoff. Only the meeting owner can POST `/meetings/{meeting_id}/voice-assistant/handoff/{request_id}` to claim `VoiceHandoff`; a subsequent GET revalidates it for each private chat turn. No caller name or speaker hash grants account identity.

Claims require completed/failed playback, an idle room lease, unchanged task state, current sharing revision and fresh source fingerprints. Stop, a new unclaimed voice turn/session, expiry, source revocation or artifact deletion invalidates the transfer. A successful task claim atomically detaches that voice task flow; it does not create a draft. Hints expire after five minutes; claimed contexts after fifteen. Only collected fields, up to three heard turns and eight current source excerpts transfer, never the full transcript or credentials.

Terminal shows **Continue in chat** beside voice status only when a handoff is available. The action prepares a separate private chat composer; the owner reviews and presses Send. A nonempty composer is preserved. `voice-handoff-{meeting_id}-{request_id}` chat sessions resolve the owner snapshot server-side on every send/reconnect and omit ambient meeting grounding. Requested task fields remain proposals; uncertain draft writes must be checked before retrying.

## Pipecat Decision Flow

The existing internal `task_flow` envelope can additionally carry `kind: decision` and the nodes `title`, `decision_status`, `decision_evidence`, `review`. `flow_plan`/`flow_apply` keep the same caller, active-session, revision and lease checks. Core calls owner-authenticated `/api/internal/meeting-voice/{meeting_id}/decision-flow` with `DecisionFlowQuestion`; SDK callers cannot submit decision fields or evidence. Unknown speaker identity refuses decision-flow admission rather than creating an unchecked one-shot decision.

`DecisionState` separates requested discussion status (`proposed`/`decided`) from source verdict (`unchecked`/`supported`/`missing`/`conflict`) and from the draft's existing review status (`pending`/`approved`/`discarded`). User-provided content/status/locator must be literal. Up to three exact current source quotes support decided status, followed by independent verification. Source snapshots and policy are rechecked before readback/creation, and a current-turn permit is required immediately before the pending draft write. No voice instruction approves the draft. Original ASR and selected audio backends are unchanged.

`VoiceHandoff` and `VoiceHandoffHint.kind` additionally support `decision`, with optional `decision` fields carrying title, requested status, evidence verdict and missing field. Current proof references are revalidated on claim/read; chat cannot treat a speaker's assertion as verified consensus. Existing task handoffs remain compatible.

## Draft recovery fixes

TaskState and HandoffTask additionally accept optional `save_uncertain` (default false), matching Decision Flow. An unknown finish response preserves that marker; voice cannot blindly retry creating a second draft under a new turn UUID. The owner inspects existing drafts or continues in private chat. Definite upstream request/source rejection statuses remain typed: a decision finish conflict returns to source clarification without claiming the write is uncertain. Stop/session/policy fences still apply before playback.

At eight retained inputs or the 8,000-character boundary, draft input history compacts to the original request and exact user-input snippets proving current fields plus the new input. This is bounded ephemeral field provenance, not a full conversational audit or canonical ASR rewrite. Explicit cancel/leave do not consume capacity; confirmation and corrections remain valid.

VoiceActionDraftPage bounds owner list responses to20 drafts with optional next_offset; GET voice-drafts accepts a nonnegative offset. Direct review and its pre-write reauthorization resolve the requested ID independently of list pagination, retaining owner/meeting/policy/completed-readback fences. Missing next_offset means the last page. Legacy first-page response keys remain compatible.

Previously recorded replies may retain optional `detail_text` and `answer_complete` metadata.
The API keeps these fields readable so switching runtimes does not discard historical answers;
new replies follow the existing single verified-answer flow.


`VoiceHistoryTurn.follow_up` is an optional nullable question (1–200 characters). It preserves a
verified answer's follow-up as pending intent, without changing its `clarification: false` or source
evidence. Only completed playback can keep it; interrupted playback clears it. Existing session,
caller, revision, source fingerprint and pending-expiry checks continue to apply.
Heard history timestamps completed turns at playback completion, so synthesis/playback latency
does not consume the 30-second pending-intent lifetime.


Project source profiles add nullable `source_profile_id` (32 hex) and
`source_profile_fingerprint` (64 hex) to VoicePolicy, supplied together. The profile is an explicit,
immutable, owner-scoped selection of up to 8 documents, 4 other meeting transcripts and existing
source permission flags. It is copied to each room; it does not automatically enroll future meetings
or share an entire workspace. Profile removal/source loss blocks subsequent use, including TTS
readiness checks. Profile rooms bypass the readiness cache to recheck revocation before playback.

The owner saves/lists profiles through GET/POST
`/agent/workspace/meeting-knowledge/{meeting_id}/source-profiles`, removes one with POST to
`source-profiles/remove` carrying `{key, fingerprint}`, and applies its reference through the existing
room policy PUT. Profiles live outside normal Wiki documents at
`.meeting-knowledge/voice-source-profiles/{owner}.json`, use the existing workspace write lock and
atomic replace, and are limited to 20 named selections. All file and meeting grants remain checked.

`auto_web_search` defaults false when parsing legacy policies. Newly created capable Google Meet
rooms explicitly seed both `allow_web_search` and `auto_web_search` true; saved room choices remain
unchanged. When both web flags are on,
a conservative question-only model classifier may select web for a self-contained public question;
local tool selection, source verification, Stop and room policy checks remain authoritative.

`include_workspace_wiki` grants read-only retrieval over the owner's primary private workspace
content Markdown: README.md and files under kg/, wiki/, notes/, docs/, sources/ and concepts/.
New capable Google Meet rooms seed it true; omitted legacy policies remain false. It does not
grant another account, attached/shared workspace, hidden metadata, symlinks, or canonical transcript
access to other meetings. All qualifying documents enter the existing bounded retrieval pipeline;
the eight-document linked-selection cap applies only when this flag is off. Existing limits of
1,000 discoverable documents and 200 KB/50,000 characters per document remain; the all-Wiki corpus
has a 20 MB UTF-8 budget. Exceeding a source/corpus limit fails explicitly rather than silently
omitting documents. Source fingerprints, policy checks and current-turn/Stop guards remain intact.
Profile defaults do not change this separate room-level grant. Turning it off restores explicit
document selection. This sharing allows spoken answers to everyone in the room.


`VoicePolicy.agent_backend` selects `completion` or `sandbox`. Legacy reads/request defaults remain
`completion`; newly created capable rooms default to `sandbox`. Source profiles do not grant or
change harness execution mode. The sandbox produces source-tool proposals and candidate JSON;
TINA remains responsible for execution authorization, source revocation, verification and playback.
Only the authenticated internal completion edge freezes a live voice lease into a private worker
payload. Stop invalidates that lease. Private dispatches mount no account workspaces and do not
resume CLI history; heard caller history remains source/revision scoped.

`VoiceReply.reason` and eligible `VoiceHandoff.reason` add `generation_format_invalid`: a sandbox
answer remained malformed after its one format repair. It carries no factual claims or verification
verdict, and is distinct from missing evidence or a rejected factual answer. Existing handoff owner,
source, Stop and completed-playback checks still apply. Chat responses are not given a voice schema.
