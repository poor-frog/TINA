# Self-hosted LiveKit Agents voice runtime

Default self-hosted voice runtime for new capable Google Meet rooms. One worker process supports up to three concurrent meetings,
with a separate LiveKit room, AgentSession, turn lock and caller contexts for each meeting/session.
Use one replica/process; horizontal scaling requires worker ownership and routing and is not supported.
The existing bot owns Google Meet capture, per-speaker KWS, ASR windows, turn ownership and microphone
playback receipts. Confirmed questions use custom HTTP I/O into Agents; PCM uses custom HTTP output
back to the existing bot microphone. This pilot does not publish raw meeting audio into LiveKit rooms
or add a second ASR/transcript writer.

## LangGraph RAG

Local search arguments may also carry nullable speaker/source-time filters and soft entity hints.
The existing 200-character canonical wire budget remains; the core applies filters only inside
approved source sets. RAG now uses [Retrieval V2](../../docs/tina-retrieval-v2.md), including Vietnamese
search views and compact evidence refs. E5, source verification and the guarded LLM reranker remain;
BGE is an offline evaluation candidate, not an extra model in this worker.

LLM tool plans use per-tool `arguments` schemas. Searches accept `{query}`, recent transcript accepts
`{}`, context reads accept `{context_handle}`, source opening accepts `{source_id}`, and draft tools
accept `{request}`. Calculation accepts either `{expression, context_handles}` or
`{start_date, end_date, context_handles}`; handles are explicit arrays (empty for spoken inputs).
`voice_tools.py` is shared with the Agent domain and copied into this image. It validates typed
arguments and normalizes them to existing `{name, query}` HTTP/Redis calls, retaining the overall
200-character wire limit. Old query-format plans remain accepted for compatible deployments.
Unknown fields, mixed calculation modes, invalid handles/calendar dates and unapproved tool names
are refused. Scope is fixed by each tool and current TINA policy; models cannot provide an owner,
meeting ID, document path or URL to expand that scope. Numeric operands and returned-source handles
are still checked by TINA's calculator. Per-tool input validation does not grant source permission.

Ordinary Q&A and source navigation run a pinned local LangGraph 1.2.22 `StateGraph` inside
the existing `TinaLLM` LiveKit adapter: plan → lookup → plan → lookup → verified answer.
An empty plan skips remaining lookups. At most two plans and two calls per plan execute, with
no retries or duplicate queries. Graph nodes call the existing capability-authenticated TINA
API; credentials, source permissions, BM25/E5/RRF retrieval, final verification and source
revocation remain owned by TINA. The second plan targets missing details of compound requests;
ambiguous requests can leave retrieval for a specific clarification.

A batch of two independent local reads (recent/current/shared-meeting transcript, shared Wiki or
approved-action search) runs concurrently in one `asyncio.TaskGroup`. At most two requests are
in flight; the existing two-plan/four-tool and shared core retrieval deadline remain unchanged.
All other or mixed batches, including calculation/context/navigation/drafts/public web, retain
sequential execution. A fatal lookup cancels and drains its sibling before the turn fails;
Stop/disconnect propagates to both HTTP requests and the existing core lease fences late results.
Each lookup still rechecks current sharing policy. Core Redis preserves completed/executed calls
in planned order even when the slower lookup finishes last. The next plan/final waits for all
lookups. Remote synchronous work may finish after HTTP cancellation, but cannot release a late
answer through the stopped lease. `rag_lookup_batch` measures wall time; individual spans overlap
and must not be summed as user latency. Semantic encoding still uses its bounded CPU lock/fallback;
concurrent HTTP reads do not imply parallel GPU/model inference.

### Lookup outcome branches

The graph's assess node distinguishes `found`, `empty` and `unavailable` local reads. Empty searches
may use the remaining plan round, then TINA decides a supported answer, clarification or no-evidence
reply. A core-confirmed temporary read failure is committed as completed-but-not-executed, retaining
its consumed call budget and reservation so a concurrent source can finish. The graph waits for the
batch and, if another lookup found evidence (including a prior round), skips further planning and
calls the existing verified answer endpoint. If no successful evidence remains, it fails as service
unavailable without dispatching a factual answer. Core independently enforces that last condition.
Source counts signal retrieval availability, not entailment; final claims still require current
source verification and the final revocation check.

Protected HTTP 401/403/404/409 source/session changes raise a fatal access-change error, cancelling
siblings; they never become empty or unavailable search results. Stop and malformed responses also
remain fatal. Raw worker-to-core transport errors are fatal because the worker cannot confirm whether
the reserved lookup committed. Only TINA can mark a recoverable read; no retry, new tool round or
draft-write recovery is added. Content-free `lookup_outcome` logs distinguish partial/unavailable/
empty/access-changed paths without copying provider errors. The bot's existing service-error recovery
handles the no-evidence-after-service-failure case instead of presenting a false factual refusal.

LiveKit no longer runs a second native function-tool loop for these turns. Existing Meeting API
planning/tool progress continues to reach Terminal/Extension. Only the final checked reply is
emitted into the SDK text stream; tool output, drafts and graph state never enter TTS directly.
Stop/disconnect cancellation propagates through the current graph node; late results cannot
cross the original request binding. No checkpointer, LangGraph server or external LangSmith
tracing is enabled. Heard `ChatContext` still comes from TINA's playback receipts, not graph state.

Local `voice_stage` spans reuse the Agent domain's stdlib-only `voice_trace.py`, copied unchanged
into this image. They record graph/plan/per-tool/answer timings with the original request UUID,
span UUID and bounded round/source counts, never question/source text or capabilities. Cancellation
is separate from errors. See [evaluation and timing reports](../../core/agent/eval/voice/README.md).
For local Python entrypoints outside pytest, set `PYTHONPATH=../../core/agent/shared` from this directory.

Run `uv run --project deploy/livekit --locked pytest deploy/livekit/test_rag.py deploy/livekit/test_adapters.py deploy/livekit/test_server.py` for graph budgets, lookup traces,
missing-deadline follow-up, clarification, per-caller isolation and real SDK cancellation checks.
These use synthetic source/model authority; they do not establish answer-quality or audio-latency
improvement on real meetings. Keep provider/model/source fixtures identical in before/after
model evaluations described in `core/agent/eval/voice/README.md`.

## Pipecat task and decision draft flows

Pinned `pipecat-ai==1.16.0` supplies a real `FlowManager`, function handler and node transition
inside a text-only pipeline in this worker. Explicit task and decision requests from identified callers use
that pipeline instead of the LangGraph RAG loop for the turn. Ordinary questions and
source navigation use LangGraph through Agents. An unrelated question leaves the flow before
normal Q&A starts; two orchestrators never execute tools concurrently for one turn.

The flow collects a title, optional assignee and optional literal deadline, reads back the proposed
fields and asks for confirmation before creating the existing owner-reviewed private draft. Say
“để trống” to omit an optional field, correct a field during review, or say “hủy” to abandon the
conversation. No voice command approves, assigns or publishes the task. Example:

1. “TINA ơi, tạo task kiểm thử đăng nhập.”
2. “Bạn muốn ghi ai phụ trách, hay để trống?” → “Lan.”
3. “Bạn muốn ghi hạn bàn giao, hay để trống?” → “Thứ Sáu.”
4. Review → “Không, đổi sang thứ Hai.” → updated review → “Đồng ý.”
5. TINA prepares a private draft; the meeting owner reviews it in Terminal as before.

The selected TINA CompletionPort performs bounded structured field extraction; Pipecat receives
neither provider keys nor direct workspace access. Every new field must literally occur in the
current spoken input. Relative dates stay literal for owner review rather than being guessed as
calendar dates. User-requested fields are proposals, not verified meeting consensus.

Core Redis stores the staged flow per meeting/session/policy/caller for five minutes, with at most
eight user turns and 8,000 input characters. It resumes only after the previous exact prompt has
a completed playback receipt. Unheard/interrupted prompts, a different caller, policy changes,
retired sessions and expired state cannot continue it. Unknown speaker identity retains the old
one-shot task behavior; decision creation requires an identified channel. Stop cancels the Pipecat task and fences its late plan/write/readback.
This flow state is ephemeral task data, not RAG or factual conversation memory.

Recovery keeps valid fields and tracks unmatched answers at the current node. The first repair
asks more briefly, the second gives a response-format example, and a third unmatched answer pauses
the dialogue without creating a draft or arming another automatic follow-up. New valid input resets
the node's retry counter. Ambiguous values such as “người đó” and “như hôm trước” are not stored as
names/deadlines. Service/schema failures do not consume user retries. If prompt playback failed,
the next identified caller turn re-asks that prompt with the retained fields before interpreting
new slot input; Stop/stopped receipts still cannot continue an unheard prompt.

Run `uv run --project deploy/livekit pytest deploy/livekit/test_task_flow.py deploy/livekit/test_server.py`
from the repository root. These use actual Pipecat pipeline/Flows code with synthetic core APIs;
they do not prove model extraction quality or Google Meet microphone behavior.

## Local audio bridge

`TINA_AUDIO_DENOISER=dtln` selects local DTLN in the bridge; `webrtc` retains NS Low (the default
for upgrades). The room's existing noise-reduction switch still controls whether filtering is used.
Only one filter runs before the shared KWS/Silero/STT split. Settings reports the selected filter
from the live service, and original captured audio stays unchanged.
Idle noise connections revalidate session authority and the noise switch every 15 seconds instead
of closing a healthy stream. Revoked sessions and disabled filtering still close the connection.
After transport/filter failure, the bot passes raw frames through exactly once and retries on the
next valid frame after a five-second cooldown. Disabled/closed filters do not reconnect, and replies
from retired generations cannot replace or duplicate already delivered audio.

DTLN uses the original two ONNX models from `breizhn/DTLN` at revision
`1de1f15a8b5b7e1c44905618ff2ef70ca8277fbc`, with exact sizes/SHA256 and MIT notice pinned in
`dtln_assets.py`. Image builds download and verify the approximately 4 MB weights once; inference
never downloads. Both models use ONNX Runtime CPU with one intra/inter-op thread. Weights are
shared within the process; each channel has independent LSTM and overlap-add state. See
[upstream license](DTLN-LICENSE).

The original 512-sample window and 128-sample hop are retained at 16 kHz. TINA compensates the
384-sample overlap-add offset and flushes the final partial frame through its existing exact-count
buffer; capture remains 64 ms and source clocks/sample counts stay unchanged. The initial version
mixes 50% denoised speech with 50% time-aligned original audio to limit over-suppression. It adds no
AGC, echo cancellation or high-frequency rolloff filter. This is a direct adapter of upstream ONNX
inference, rather than the community FrameProcessor's startup/resampling queues.

Focused checks: `uv run --project deploy/livekit pytest deploy/livekit/test_dtln.py`.
`dtln_smoke.py` exercises actual weights over private TCP with three paced sessions, two channels,
64 ms frames and a 777-sample tail. Automated signal/transport checks are not a Vietnamese ASR or
wake-word quality benchmark; compare original/NS Low/DTLN on the same recordings before judging quality.

`TINA_LIVEKIT_AUDIO=1` routes **both continuous transcript windows and voice-question ASR** through
a custom `livekit.agents.stt.STT` adapter in this service. The model and token are pinned to the
backend selected when each Google Meet bot starts: VieGem + KenLM + FSMN-VAD or a configured OpenAI-compatible endpoint.
ASR window sizes, retries/LocalAgreement in the bot, original segment offsets, quality checks and
the sole Meeting API transcript writer stay in place. Continuous transcript does not enter
AgentSession as a question. This uses standalone SDK recognition, not a whole-utterance
`StreamAdapter` or automatic room audio input.

New bridge-capable bots send each accepted channel/turn PCM16 frame once over one private `/stt`
WebSocket. This worker retains at most 32 seconds for each of up to 32 turns per connection and
assembles referenced ASR windows. The bot's existing cadence, silence/cap-cut logic and LocalAgreement
retain window-selection authority and a bounded local PCM copy. A request carries only the turn key,
source start, sample count, PCM checksum and existing decode options; overlapping windows do not
resend their audio. Draft results retain backend offsets, confidence and Server-Timing and go through
the same client quality/language filters before LocalAgreement can confirm them.

Cache misses/checksum disagreement or a disconnected stream fall back to the exact original WAV over
the existing authenticated HTTP bridge. Subsequent frames reconnect; late replies from the old socket
are ignored. Request aborts cancel the matching SDK inference. Turn close releases its server cache;
disconnect releases all caches/tasks. Continuous input still uses windowed ASR inference,
not model-native streaming. No new VAD, endpoint threshold or confirmation policy is enabled.

The same private bridge performs the selected **DTLN or WebRTC NS Low** once before splitting PCM into
ASR, Silero and KWS. NS Low reuses the bot's native DSP library and exact-count/delay-compensated stream;
there is no Krisp, ai-coustics license or extra filter. Raw captured audio stays unchanged in the
archive. Each channel keeps separate filter state. Original 64 ms frames and sample clocks are
preserved; failures drain pending raw frames once using the existing bot fallback.

The feature defaults off for upgrades. Set it in the selected Compose env, rebuild the bot first,
then `livekit-agent` and `meeting-api`, and start a **new** Google Meet bot. `make all` performs this
build order. Existing bots keep their original route. Set it back to `0` and create a new bot to
roll back. Other meeting platforms retain their original ASR path.

Audio uses private HTTP/WS rather than public LiveKit tracks. The bot gets a signed meeting/session
capability, including its pinned backend credentials; treat it as a secret. It travels in HTTP
Authorization / WS subprotocol headers, never URL queries. Meeting API checks the latest active
session and Stop state before/after recognition and periodically during filtering. The service
accepts bounded mono PCM16 16 kHz WAV windows; SDK retry is disabled so the bot owns retry policy.
There are at most eight simultaneous ASR calls, eight STT connections and eight filter connections
in one worker. Pending input is bounded; overflow takes the HTTP fallback rather than dropping a
canonical window. Content-free `asr_stream` events report readiness, backpressure and fallback.
Silero still owns realtime speech activity; FSMN stays in ASR. Smart Turn/Namo stay observation-only.

### Hosted Silero observation

`TINA_LIVEKIT_VAD_SHADOW=1` adds a private `/vad` WebSocket for new voice-capable bots using the
audio bridge. It reuses the exact pinned Silero model and `VadMonitor`/`SileroVad` implementation
from the bot: CPU, 800 ms silence, 150 ms minimum speech and 22 s maximum speech. The existing model
cache is mounted read-only; the service never downloads it during inference. Missing observer assets
report `vad_shadow_ready=false` without taking down transcript or TTS readiness.

The bot tees the same filtered Float32 frames and state/generation controls to the hosted monitor.
Source-stamped speech transitions and numeric endpoint candidates are compared in content-free
`livekit_vad_shadow` events. Candidates check the caller channel's speech end against ASR tail coverage;
the bot retains lexical checks, wake ownership, room quiet and final question dispatch. No question
text, caller names or API keys enter observer messages/logs. Old-generation candidates and replies
are ignored; Stop/disable/disconnect closes the monitor. Audio permission additionally requires the
current room voice policy to be enabled.

This is the comparison phase: both local and hosted Silero run, and the local controller remains
the authority/fallback. Observer disagreement, timeout or failure cannot trigger a reply or stop ASR.
Defaults are off for upgrades; enable the flag in the selected encrypted Compose env and recreate
`livekit-agent`/`meeting-api`, then create a new bot. Turn authority is not switched automatically.
The native TCP proof `vad_shadow_smoke.py` checks real pinned Silero transitions/endpoints across
three synthetic sessions, each with speech and a separate quiet channel, using a fixed local TTS clip.

Focused offline verification: `uv run --project deploy/livekit pytest deploy/livekit/test_audio.py`.
Native-library parity requires the built Linux image; a synthetic bridge test does not establish
Vietnamese recognition quality or live Google Meet acceptance.

```sh
docker run --rm --network none --read-only --tmpfs /tmp -e PYTHONPATH=/app \
  -v "$PWD/deploy/livekit/audio_smoke.py:/proof/audio_smoke.py:ro" \
  --entrypoint python tina/livekit-agent:dev /proof/audio_smoke.py
```

`stt_stream_smoke.py` and `stt_stream_smoke.mjs` run the real Linux SDK/WebSocket/Node bot pipeline
against synthetic meeting and acoustic authority. Start the Python fixture in an isolated container
on port 8081 (no published port), then run the JS fixture in a bot container sharing its network
namespace. It asserts two overlapping channels, source attribution, final tail, and no missing,
duplicate or HTTP-fallback words. This is transport/assembly verification, not an acoustic benchmark.

Agents runs a custom LLM adapter calling TINA's capability-authenticated, policy-checked answer API
and a TTS adapter calling the existing local VieNeu service. LLM choice, retrieval permissions, source verification and actual playback receipts remain in TINA.
The TTS adapter obtains the session-pinned, signed owner voice/pronunciation profile from Meeting
API for every synthesis. Caller-provided profile text cannot override that selection; the signing
key never enters Agents or bot containers. Fixed notices use the same profile on the direct TTS path.
LangGraph executes up to two batches of two authorized API tools, using the selected LLM through TINA's
credential boundary. It does not receive an owner API key or access private workspaces. Per-caller
ChatContext is refreshed from source-valid heard history; history resolves references, never facts. This is an orchestration pilot, not a new model or a quality guarantee.

## Enable and select

Set `LIVEKIT_AGENT_URL=http://livekit-agent:8080` in the Compose environment (encrypt with dotenvx
when using the encrypted deployment). Start it with the local TTS/voice profile using the existing
dotenvx runner:

```sh
make all
```

Enable `TINA_MEETING_VOICE=1` in the selected main environment (new templates already do this).
`make all` decrypts it with its matching root `.env.keys`, loads the separate encrypted TTS token
through `deploy/tts/run.py` when needed and automatically adds the `livekit` and `speech` profiles.
Explicitly supplied valid TTS credentials still work. A missing key fails before application restart;
`make plan` can report missing credentials without creating any file. KWS bootstrap verifies the
existing model cache, or imports the two pinned local ONNX files from `TINA_KWS_MODELS_DIR`.
It creates separate LiveKit API keys with a domain-separated HMAC of the decrypted internal secret;
the original secret is not forwarded to LiveKit. Both services stay on the private Docker network.
There is no new public port, Cloud account or model download.

Start a new Google Meet bot so it has the bridge-capable image and seeded defaults. To change a room override, open **Settings → Voice
assistant → Room answers**, choose the active meeting, set **Voice runtime → LiveKit Agents · local
pilot**, then save. Saving stops the old voice turn. Keep transcript/documents/general/web permissions
as desired: selecting the runtime grants no additional sources. Choose **TINA** and save to switch
back. A deployment without the pilot URL refuses this choice. Old bot images cannot claim pilot
readiness. New capable Google Meet rooms default to Agents with all four answer options on. Existing saved policies and account opt-outs remain unchanged. Up to three active Agents meetings are supported.
The pilot does not change ASR model selection, audio windows or canonical transcript writes.

The bot owns KWS/VAD endpointing, wake/follow-up speaker ownership and explicit interruption commands.
Agents runs the LLM/TTS model adapters and generation/playout task cancellation. The TINA answer API
still owns authorized retrieval, source verification, model selection and played-prefix receipts. HTTP PCM
delivery is not proof that anyone heard it; only existing bot microphone receipts establish that.
LangGraph handles the bounded retrieval loop inside the Agents LLM adapter for transcript, shared
Wiki/documents and explicit public web queries. Automatic Agents turn detection/barge-in remains disabled. See
[tools and context](../../docs/tina-livekit-tools-context.md) for the internal protocol and limits.

## Checks

```sh
uv sync --project deploy/livekit --locked
uv run --project deploy/livekit pytest deploy/livekit -q
```

`smoke.py` runs inside the worker with its existing environment. It creates a real self-hosted room,
runs real AgentSession LLM/TTS adapters, uses the real local TTS service, proves Stop replay fencing
and deletes the room. Its meeting API is a synthetic fixture; it does not read real meeting data.
A real Google Meet listening test remains separate. The pilot reserves at most current PCM plus one
lookahead, bounds frame queues/audio length, and reaps inactive/revoked sessions. Rooms close after
90 seconds idle or when the meeting/session policy becomes invalid.

All fixed, prewarmed phrases in the bot's `VOICE_NOTICES` catalog go directly to the shared local TTS endpoint,
so it cannot queue behind the same AgentSession's pending LLM call. Generated answer sentences use
the Agents TTS adapter. Both paths retain the bot's microphone/Stop and played-prefix receipts.

Whole-meeting recap computation remains in TINA's existing background pool. AgentSession waits for
the verified final answer in the same exclusive room turn: core HTTP timeout 150 seconds, SDK LLM
timeout 160 seconds and overall answer wait 165 seconds. Busy sessions are not idle-reaped. Stop,
disconnect and source-policy/session changes still cancel the turn; no late result starts a new reply.

Speech completion also requires every VieNeu synthesis stream for the current request to reach a
validated end; SDK SpeechHandle completion alone is insufficient. A synthesis/transport failure
aborts the chunked PCM response, so the existing bot reports playback failure and cannot mark the
unspoken remainder as heard. Header size checks use pure ASGI middleware to preserve these streamed
failures on the actual HTTP connection. Tests include a real local TCP client receiving incomplete
chunked transfer, plus recovery on the next speech request.

Room cleanup rechecks registry ownership and idle/busy state while holding the same per-meeting/session
lock used to replace that session. Connection/startup and cleanup in one room do not block a ready
runtime in another room. Pending initializations reserve capacity alongside ready/closing rooms;
the limit remains three, and cancellation releases the pending slot after partial cleanup.
Same-room concurrent admissions share one runtime; idle lock entries are weakly held to avoid a
registry that grows with past sessions. Each runtime generation has a distinct room name, so a delayed remote room-delete
request cannot delete its replacement. A deterministic concurrency test holds the old policy check
while a replacement runtime opens and verifies that the old runtime closes only once.
A failed synthesis retires its SDK session before the next request, including after repeated failures
that exhaust the SDK's error budget. Source history remains in TINA and is revalidated as before.

The internal Meeting API endpoint is `http://meeting-api:8080` (the same address used by the gateway).
The Agents readiness probe checks both LiveKit server and Meeting API connectivity, so a wrong port
or unavailable TINA API cannot be reported ready. Tests assert Compose endpoint consistency and
verify readiness fails on connection refusal or a non-200 Meeting API response.

`/ready` additionally authenticates to shared TTS and validates PCM16/mono24kHz readiness without
synthesizing or calling a paid LLM. Compose health checks and Meeting API voice preflight use it.
`/health` retains dependency liveness and capacity/session counts; a full worker stays healthy and
refuses a fourth meeting with 503. PCM requests also validate the exact live Redis turn through the
capability-authenticated Meeting API before starting, periodically while streaming and at completion.
This check survives SDK runtime recreation; local in-memory Stop markers are not the authority.

Run `python production_smoke.py` inside the prepared worker for automated qualification. It opens
three actual local LiveKit rooms/AgentSessions, executes LangGraph API tools, checks different room contexts,
streams fifteen uncached local VieNeu replies over TCP, rejects a fourth room, checks Stop isolation,
quota-error recovery and refusal of old audio after runtime recreation, then deletes its own rooms.
Meeting API, LLM and playback receipts are explicit synthetic fixtures; no actual meeting data or
Google Meet audio is accessed. It reports measured first-PCM latency, not a production speech SLO.
See [production qualification](../../docs/tina-livekit-production.md) before releasing broadly.

Meeting API permission/session failures remain distinct from service outages: 401/403/404 deny
access, 409 invalidates the room session/policy, and other non-200 service responses return 503.
A transient service outage does not make the reaper revoke a busy or recently used room. New requests
still require a successful policy check; retaining a room grants no additional source access. The
existing idle cleanup remains bounded, and a later explicit revocation still closes the session.

Planner/tool/final generation failures release the core turn and retire the SDK runtime before the
next request, so repeated LLM outages cannot leave a closed Agents session permanently unusable.
Heard history stays in TINA and is restored only after successful policy/source validation.

A second bounded plan can change search terms or read surrounding original text when the first
lookup does not answer every part of the question. The core caps the retrieval phase at 30 seconds
and four attempted tools. Context reads require a per-turn handle returned by an earlier tool.
A deadline skip keeps the successful earlier results for final generation; Stop and changed
permissions reject every late operation. No new tool result is retained as heard chat history.

Supplemental service failures also keep successful prior queries available for verified final
generation. SDK calls are bound to the exact turn object/call ID, preventing a late callback from
attaching itself to a later question. No source or permission check is bypassed by this fallback.

The shared bot controller treats the optional acknowledgment as best effort and re-prepares a failed unplayed lookahead once when its playback turn arrives, including a LiveKit stream that fails before any PCM is ready. It rechecks generation/policy before replacement and playback; Stop and actual played-prefix receipts remain authoritative. No already-started audio is retried.

Shared bot recovery also handles buffered-but-unplayed stream failures, with at most one retry and no retry after playback starts. Acknowledgment TTS has its own three-second deadline. Core admission reclaims only provably retired session reservations using CAS, including stale playback ownership, while current session and late-result fences remain enforced.

PCM admission credits follow the entire ASGI response lifetime. A client disconnect before headers
or before the body iterator starts closes the iterator and returns the reserved slot, so cancelled
requests cannot exhaust the two per-room speech/lookahead slots. The regression test injects a
header-send disconnect and checks both credit and lock cleanup.

The TTS adapter explicitly closes its upstream PCM iterator on completion, failure and cancellation,
including interruption before the first PCM chunk. SDK interruption also clears unplayed output.
This unwinds the HTTP streaming context so the shared TTS worker observes the closed connection.
Tests cover Stop before first audio and with already buffered PCM; the native ONNX chunk already
executing can finish, but the sidecar discards its late output and starts no further chunks.

Explicit task/decision requests can invoke draft_task/draft_decision through the existing authorized tool loop. These propose owner-reviewed drafts only; no SDK tool can approve, assign an account, or publish an entity. See ../../docs/tina-voice-action-drafts.md.

DELETE /turn now acknowledges after the exact current SpeechHandle has been interrupted and its request cleanup has finished (bounded wait). Late old Stop requests cannot interrupt another handle. See ../../docs/tina-voice-task-refinement.md.

Read-only search_approved_actions and calculate extend the LangGraph API tools. Owner policy, returned-handle authorization, deterministic calculation and source verification stay in the TINA API. See ../../docs/tina-voice-read-calculate.md.

search_shared_meetings compares explicitly selected owned meeting transcripts via the existing TINA authority bridge; it cannot select or grant a meeting itself. See ../../docs/tina-voice-shared-meetings.md.

open_source executes a server-selected citation handle through the same bounded tool loop; it does not accept paths/URLs. Owner Terminal navigation is claimed through Meeting API after actual playback, not SDK delivery. See ../../docs/tina-voice-open-source.md.

Pipecat is a pinned pip dependency under BSD-2-Clause; its installed distribution includes the upstream Daily copyright and license. No Pipecat model weights or cloud service are bundled.

## Decision Flow

Say “TINA ơi, ghi quyết định dùng PostgreSQL”. The flow collects literal content, asks whether it is a proposal or already decided, searches only currently shared sources from this meeting, then reads back before explicit draft confirmation. Clear complete input skips unnecessary questions. Decided evidence must contain exact source quotations and pass the existing independent voice verifier; commands, negations, questions and proposals do not establish agreement. Missing/conflicting evidence asks for a source locator or an explicit downgrade to proposed. No web search is used to establish meeting consensus.

Decision nodes reuse the same manager/lease/receipt state as tasks (`title`, `decision_status`, `decision_evidence`, `review`). A new task or decision request replaces the prior caller flow; ordinary unrelated questions leave it. The decision planning budget is bounded to 90 seconds for extraction/retrieval/verification. Service errors retain collected fields, and paused/error states can use the owner-only Continue in chat handoff. The owner still reviews a pending decision draft in Terminal; voice confirmation is not owner approval.

If a decision draft write cannot be confirmed, its state is marked uncertain and voice cannot blindly retry creation. The owner must inspect existing drafts or continue in chat first; this avoids a new voice request producing a duplicate after a lost response.

Draft recovery retains bounded field provenance at input capacity so the next confirm/cancel is not a validation error. Both task and decision unknown writes pause blind retries; source conflicts instead request fresh evidence. These are core-owned transitions and do not change SDK audio/STT selection.

Initial context lookup is owned by the same disconnect-aware wait helper as later flow operations. Client transport disconnect cancels the pending context task and releases the meeting turn; a real HTTP regression checks that the next question can proceed without waiting for the old lookup.

## Runtime admission and disposal

Both answer and PCM admission watch the client connection, including cold room connection and SDK start. Cancellation cleans partial SDK/RTC resources and the generation-specific room. A runtime that completed admission during the disconnect tick is removed only when it was created by that admission task and is still unused; reusing a runtime cannot close another caller's active session. The existing global admission lock and three-room limit remain; simultaneous valid cold starts are serialized.

Runtime disposal is shared/idempotent and shielded from its caller's cancellation. It cancels the tracked context/flow task, interrupts current speech, requests core release for the captured request UUID, bounds task/turn/SDK/RTC cleanup waits, and deletes only that generation's room. Closing runtimes refuse new answer/PCM work. The policy reaper retains registry ownership until disposal completes. If core is unreachable, release is best effort and core policy/lease expiry remains authoritative; no replacement can clear another request's lease.
