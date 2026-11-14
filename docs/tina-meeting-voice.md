# Local KWS Google Meet voice assistant

New Google Meet bots detect **TINA ơi** or **hey TINA** with local CPU LiveKit WakeWord 2.1.1.
The two retained ONNX models authorize one caller channel; selected ASR supplies the question text
and uninterrupted transcript. ASR spelling variants cannot activate a bot without acoustic evidence.
The standalone TINA and ê TINA models/checkpoints were removed. Participants need no local client.

## Deployment

The main stack needs its normal private `.env.keys`, a healthy selected Gipformer 1.5 + FSMN-VAD
or VieGem + KenLM + FSMN-VAD endpoint, and working Agent model credentials. Neither backend or
its decoder/VAD is replaced. Voice observes the original ASR response before LocalAgreement;
it does not issue a second STT request or change transcript text/confirmation.

With the local encrypted TTS pair at `~/.config/tina/tts-local/`:

```sh
DOCKER_CONTEXT=orbstack TINA_MEETING_VOICE=1 python3 deploy/tts/run.py -- make all
```

Use the matching shared TTS env/key overrides if applicable. Token/key values never belong in chat,
logs or Git. The runner injects the same service token into Meeting API and TTS; the bot receives
only server-side service credentials and one meeting/session capability, not the owner's API key.

The speech profile prepares pinned Silero VAD (~644 KB) once in a named volume, mounted read-only
into each voice-capable bot. Existing cached KWS files need not be removed; bot `--vad-only` mode
never loads them. VieNeu-TTS model/codec assets (~566 MB) remain in a separate shared service.
A separate LiveKit ONNX child loads the two checksum-pinned models from the same read-only cache.
See [wake-word setup](../deploy/wakeword/README.md). Missing KWS assets or worker failure disable
voice activation while transcript ASR continues. Only verified VAD/KWS/service readiness announces LISTENING.
Linux Docker and Apple Silicon Docker use CPU Silero/TTS; VieGem's existing native MPS or Docker
CUDA selection remains independent. This deployment slice covers Google Meet/Docker, not K8s/Lite.

## Use

### Noise suppression and new-meeting defaults

By owner request, newly spawned voice-capable Google Meet rooms with transcription enabled now
start with Voice assistant and NS Low enabled, using only their own meeting transcript. No linked
document is selected automatically. Existing saved room policies (including explicit off) are
preserved when continuing a room. A continued/planned room without a saved policy receives the new
defaults on its next capable spawn. Account-level/per-spawn voice preparation overrides still win.
Legacy policy reads and omitted request fields retain conservative behavior; no old row is migrated.
Terminal keeps voice controls out of the meeting page. Use **Settings → Voice assistant** to set the
default for new bots and check TTS readiness.
Only the two acoustic calls activate a new bot. Legacy ASR variants may clean a question copy
after KWS confirmation; neither ASR output nor recorded text is replaced with TINA.

The owner may toggle **Thử nghiệm lọc tạp âm WebRTC NS Low** independently in the room policy.
Changing NS alone never grants extra sources. Ubuntu noble's pinned
webrtc-audio-processing 0.3.1-0ubuntu6 runs NS Low only on CPU; AEC, HPF and AGC are verified off.
Per-channel native states process 160-sample frames through a FIFO, compensate measured 96-sample
(6 ms) algorithm delay and pad/trim only final processing frames. Original 64 ms packets retain
their source sample count/time metadata. Raw archive taps precede filtering; the same cleaned copy
feeds transcript ASR and Silero. Capture-to-processing diagnostics include this additional latency.

The owner audio snapshot reports off/starting/low/failed. On worker error, overload or 1.5-second
packet stall, only unacknowledged original frames are delivered once and late outputs are fenced.
Failure stays visible and requires toggling off/on to retry. Capture stops before the filter drains,
then the ASR buffer finalizes. Original audio/history/model weights remain unchanged.

The earlier trial produced mixed results; the new default is an explicit owner choice, not a new
accuracy finding. On a small fixed FLEURS subset (10 VI, 5 EN), adding
synthetic colored noise at 10 dB produced mixed effects: VI WER Gipformer 10.71% → 9.29%, VieGem
8.57% → 8.93%; clean VI Gipformer 7.50% → 7.86%, VieGem 9.29% → 8.21%. On eight unlabeled real
name candidates, approved-prefix counts were VieGem 2 → 2 and Gipformer 7 → 6, not wake recall.
All 50 conditions retained exact sample counts; standalone filtering CPU median was about 0.11%
of audio time, excluding browser/IPC/full-bot load. Silence/noise-only controls produced no text.
These are whole-window backend tests, not a live meeting/LocalAgreement evaluation or CUDA proof.
Private references/audio/hypotheses stay outside Git; ignored reports contain only scores/hashes.

**Settings → Voice assistant** shows LiveKit model/version/CPU, owner-scoped current-bot KWS readiness and actual authenticated TTS model,
voice/device metadata and readiness. **Nghe thử giọng** synthesizes a fixed sample through shared
TTS and plays its WAV only in the browser; it never publishes a meeting command or saves a room
answer. Preview is authenticated, limited to one request per account per ten seconds, and bounded
to 15 seconds of PCM/35 seconds upstream wait. No endpoint/token reaches the browser.

Identity owns `voice_prefs.prepare_new_bots` through `GET/PUT /user/voice`: null follows deployment
(TTS URL present), false disables preparation, true prepares voice when TTS is configured. The
existing internal bot-context carries this non-secret default. A new manual Google Meet spawn with
no explicit `voice_agent_enabled` applies it; explicit per-spawn true/false wins. Programmatic and
calendar callers keep their existing behavior. If configured Identity is unreachable, the bot may
still join but omitted voice capability stays off. Running bots, selected ASR and room-sharing
policies are preserved. New capable rooms now receive the defaults below; existing saved room policies are retained.

1. Set **Settings → Voice assistant → Default for new Google Meet bots** to Enable voice, or keep the deployment default.
2. Create a new voice-capable Google Meet bot and admit it. Existing bots keep their current configuration.
3. Say `TINA ơi, ai phụ trách demo?` and stop speaking. The bot checks the meeting transcript and speaks a source-supported answer.
4. Use `TINA ơi` or `hey TINA`. KWS, not ASR prefix matching, authorizes the call; raw ASR text is preserved.

Saying only `TINA ơi`/`hey TINA` opens a bounded wait for a same-channel continuation. Another person's
channel cannot supply that question. A name at the start of an ordinary statement can still invoke
voice: single-name activation cannot reliably distinguish a direct address from every mention.

## Turn and playback rules

`LISTENING -> CAPTURING -> THINKING -> SPEAKING -> QUIET -> LISTENING`

KWS confirms the call. A final ASR window or two consistent question hypotheses supplies its text; no ASR name match is required.
Repeated windows update one candidate instead of launching multiple questions. Window shifts retain
only preceding text with a verified source boundary; ambiguous overlaps are discarded. Raw transcript
and original audio are not rewritten. One room turn runs at a time; no stale request queue is replayed.

Native Silero tracks each channel independently and reports the actual speech-end sample rather
than the silence tail. Voice waits until the ASR result covers that endpoint and has settled briefly.
No-question waits are bounded to five seconds after candidate detection; the complete candidate is
bounded to twenty seconds. Stop, departure, policy changes and worker failure fence late results.

During acknowledgment, thought, manual Speak and answer playback, voice triggers are suppressed;
ordinary transcript ASR continues. The one fixed acknowledgment is prewarmed in local TTS; private
answers are never cached. The validated answer is split at Vietnamese sentence boundaries and, for
long sentences, bounded whitespace boundaries. Only one sentence plays at a time; a shared playback
receipt completes after the last sentence and microphone cleanup. Policy is checked before every
sentence. Already emitted audio cannot be retracted; Stop prevents subsequent chunks. No voice
barge-in is enabled in this slice. After playback, approximately 800 ms of received room quiet re-arms
voice and excludes older ASR windows from new activation.

The shared TTS FIFO queue allows one synthesis and three waiters with a fifteen-second queue wait.
Disconnected waiters are dropped. Active native synthesis cannot be interrupted, but its cancelled
result is never played. Model/worker errors disarm voice; explicitly save settings after checking it.

## Diagnostics

Terminal does not show voice controls, runtime status or audio diagnostics on the meeting page.
The owner-only voice API retains bounded status and channel measurements; bot logs include
content-free voice timing. The transcript remains the place to inspect what ASR heard.

## Latency and acceptance

For voice-capable Google Meet bots, the owner-only status API reports up to 16 channel rows with
received frames/samples, latest RMS energy, observed sample-index
gaps/overlap, returns to sample zero, frame-end-to-bot delay, in-flight ASR count/errors and latest
ASR round-trip. Queue time is read from the backend `Server-Timing: asr_queue;dur=...` header;
missing/malformed timing stays absent. End-of-window-to-ASR-submit time is separate from capture
transport delay. An in-flight count includes both waiting and executing requests; it does not assert
the worker is currently inferring that channel. Energy does not establish speech or speaker identity.

These numeric snapshots share the session-authenticated status heartbeat and owner-only GET; there
is no additional per-frame HTTP traffic. They contain no audio, text, speaker names or participant
IDs, never change transcript scheduling and are not saved to meeting history. Snapshots expire
within 15 seconds, old/ended sessions are hidden, and inactive channel rows age out after 30 seconds.
Gaps are missing intervals in observed source sample indices, not proof of dropped network packets;
silence gating/source restart can also make clocks discontinuous. No source clock means unknown,
not zero loss. The observer is optional and throwing observers cannot interrupt ASR confirmation.

Voice-enabled Google Meet bots capture 1024-sample/64 ms frames instead of 4096-sample/256 ms;
non-voice callers retain the old default. A paired native Silero replay on 18 existing clips saw first
endpoint delivery 96 ms earlier at median (range 0–192 ms). First-endpoint ASR outputs were identical
within each backend across the two packet sizes (18/18 VieGem+LM and 18/18 Gipformer). These clips
are not a labeled accuracy corpus. See `output/meeting-voice/frame-ab-{viegem,gipformer}.json` for
local counts/hashes/timings. Replay/native VAD CPU was about 0.3% of replayed audio duration for both
sizes; this excludes browser/Playwright, full-bot CPU, inference and multi-room contention. Native
IPC sends four times as many messages. Both worklet sizes passed exact source sample/timestamp
tests and a real Web Audio synthetic-source continuity probe. The replay pads finite files with
silence; it does not prove complete tail delivery on real stream teardown or end-to-end meeting latency.

Voice hypotheses carry the channel's observed speech onset separately from the ASR window start,
so a fresh invocation can retain 200 ms pre-roll across rearm without accepting a previous turn.
Continuous low background can keep that channel onset older than rearm. When this happens, the
voice trigger uses the selected backend's timed speech intervals to keep only complete intervals
starting after rearm. Intervals must be ordered, non-overlapping and reconstruct the original ASR
text; invalid, straddling or untimed old windows cannot reactivate a previous question. A source
window wholly after rearm is fresh even when the channel onset is retained. This projects only
voice input and its prefix diagnostic: the original ASR text, transcript confirmation, retained
audio and request count are unchanged. No second ASR request is introduced; the separate LiveKit KWS child supplies acoustic activation.
Buffer-generation/deferred-close checks run before voice observation; discarded ASR cannot wake the bot.
Stop commits its Redis playback fence and releases the room reservation even if durable reply-history
storage fails. Such failures emit a content-free warning; a repeated stopped receipt repairs history
after recovery, and incomplete history remains unconfirmed rather than claiming successful playback.
The bot verifies the meeting mic label after its single toggle (up to one second for UI updates).
A missing, blocked, unknown or unchanged mic state fails playback; mute verification failure also
prevents successful completion and makes Stop report an error. This observes UI state, not remote audibility.

Terminal and the Extension Bot viewer show a separate **TINA trả lời** card for verified Voice
assistant answers. These cards are not ASR transcript segments and are not sent back into Knowledge
as participant speech. The full validated text is saved before playback; states distinguish queued,
started, completed, stopped and failed. A stopped/failed/unconfirmed card can include text that was
never spoken. Timestamps reflect the server receiving playback receipts, not remote audibility.
Fixed acknowledgments and legacy manual Speak are not recorded as Knowledge answers.

Reply history lives in `meeting.data.voice_replies`, survives Redis expiry and bot departure, and is
returned by the existing owner-only `GET /meetings/{id}/voice-assistant` endpoint as `replies`.
Incomplete replies from a departed session display as unconfirmed. Other transcript viewers and share
links do not gain access; generic meeting/transcript projections omit the history. Artifact deletion
removes it and prevents late receipts from restoring it. Extension voice polling does not block ASR;
switching account/meeting cancels pending reads. Reload the built Extension after updating it.

TINA still uses bounded HTTP ASR windows, not token streaming. The regular per-channel cadence remains
two seconds with a two-second minimum. In an enabled Google Meet voice session, a Silero speech-end
event can advance a request on that channel through the same selected ASR backend, including short
standalone names. It reuses a completed/in-flight result covering the endpoint; when an in-flight
request misses the tail, it waits for that result before submitting the retained window once. Repeated
endpoints are coalesced. It never resets/closes the transcript buffer or skips LocalAgreement. A new
speech onset supersedes an old endpoint; answering requires ASR coverage through the speech end with
only 2 ms rounding slack. FSMN-VAD stays in both ASR backends; Silero supplies voice endpointing.

Bot stdout emits content-free JSON `voice_timing` snapshots correlated by generated `request_id` and
capture channel. `stages_at_ms` contains capture-clock `speech_end`, VAD observation, ASR dispatch and
completion, ASR observation, name confirmation, question readiness, answer request/response, separate
acknowledgment and answer playback starts, and turn completion/cancellation. ASR timestamps are
optional for older producers. Speech-end/ASR stages may update as the same person continues;
name confirmation remains the initial invocation time. Missing stages stay absent, not zero.
`durations_ms` reports VAD delay, ASR request time, ASR availability after speech end, question readiness,
answer service time, acknowledgment delay, and answer playback delay. Answer service includes network,
retrieval, LLM and validation; it is not a model-only benchmark. Playback start means local injection,
not proof a remote participant heard audio. Stop/failure has no fabricated answer-playback timestamp.
Timing logs contain no names, question/answer text, tokens or PCM. For an existing bot container:

```sh
docker --context orbstack logs <bot-container> 2>&1 | rg '"type":"voice_timing"'
```

Run a new bot after updating its image. Use matched real meeting audio to evaluate latency and
transcript quality before claiming an improvement; offline timing fixtures only verify scheduling.

Readiness is content-free; owner-only diagnostics may briefly include three leading ASR words. Request IDs, source spans and policy revisions prevent replay;
no raw text/audio is written to voice diagnostics. Transcript remains the place to inspect what ASR
heard. Test real accented speech, immediate questions, mid-phrase pauses, overlapping people,
speakerphone echo, Stop between sentences and two rooms sharing TTS before claiming meeting-level
accuracy or remote audibility. Speech models are local; fully local reasoning also requires selecting
a local LLM endpoint. The meeting transport itself still needs network access.

## Voice answer context

Voice uses its own short-answer prompt. Retrieval combines BM25 relevance, up to twelve transcript
segments from the last 120 seconds, and neighboring transcript/document passages. Newer timestamps
break relevance ties; newer decisions supersede old ones only when the evidence explicitly says so.
The budget is 32 sources / 24,000 characters, with at most 1,200 characters per passage. This is
lexical retrieval with recent context, not embeddings or a semantic reranker.

When transport participant identity is available, up to three completed voice question/answer turns
can resolve follow-ups for that participant in the same bot session and sharing-policy revision.
The Redis cache expires after 15 minutes. Interrupted/failed answers are excluded; source changes,
revocation or artifact deletion prevent reuse. With unknown identity, voice still uses approved
recent meeting transcript but does not attach personal history. History is never evidence itself.

The prompt asks for two or three short spoken sentences, exact names/numbers/dates, and one concise
clarifying question when a referent is ambiguous. Output is bounded to three supported claims and
800 characters, or a clarification question of at most 200 characters. Citation IDs are validated;
this does not prove semantic entailment or measured answer-quality gains. No web access, model
change or extra ASR call is introduced.

## Verification before speech

Voice completion now adds a separate source-grounding review after generation. It first rejects
claim digit/date tokens missing from cited evidence, then asks the selected LLM to verify owner,
task, amounts/units, dates, negation, proposals and later corrections against supplied sources.
Clarifying questions are also checked for unsupported premises. Generation/review have provider
budgets of 25/15 seconds within the existing completion deadline. Failure or rejection returns
insufficient evidence, with no playback of the unchecked answer. Same-model review is fallible;
live quality and added latency still need measurement.

The accepted display answer is stored as before. TTS derives its pronunciation copy server-side,
using bounded numeric rules and operator-approved project words keyed by meeting ID. See
[the TTS dictionary guide](../deploy/tts/README.md#project-pronunciation-dictionary).

## Streaming voice playback

TTS generates PCM incrementally using VieNeu `infer_stream()` and stateful 48→24 kHz resampling.
The bot buffers 150 ms before starting its player and prepares at most one following sentence
while the current sentence plays. Neither preparation nor lookahead opens the meeting mic. Source
policy is rechecked immediately before playback; Stop and policy/departure cleanup discard both
streams. A truncated HTTP response never receives a completed playback receipt. Whole-answer LLM
verification still finishes before any private answer text enters TTS. See the TTS streaming guide
for queue, backpressure, cancellation and latency measurement limits.

## Standalone name acknowledgment

A confirmed standalone built-in name (for example `TINA ơi`) now speaks the fixed cached
`Dạ, em nghe.` after speech ends and ASR covers the endpoint. It does not dispatch an empty
question to the LLM. Wake detection is locked during acknowledgment and requires the usual
received-room-quiet interval before resuming. The same source channel may then provide a question
without repeating the name for up to ten seconds. A known transport participant ID must still
match; without participant metadata this is a short channel-bound continuation, not a verified
person identity. Other-channel speech cannot supply the question. The pending acknowledgment
context also expires if rearm does not occur within fifteen seconds.

Stop, departure, policy change, failed playback and old ASR results cannot arm a continuation.
The subsequent answer does not repeat the acknowledgment. Calling name plus question in one
utterance retains its existing response path. Readiness alone does not guarantee real microphone
control or remote audibility; verify those separately in an actual meeting.

A question spoken immediately after the acknowledgment is not discarded during cooldown: the bot
buffers at most eight same-channel ASR hypotheses and native VAD continues endpoint tracking while
wake acceptance remains gated. After quiet rearm, original source-clock/participant checks apply
to the buffered hypotheses. A pure echo of `Dạ, em nghe.` cannot consume the continuation slot.

Voice audio uses separate PulseAudio sinks: meeting_rx receives browser playback, while tts_sink
feeds virtual_mic. The source stays unmuted so Meet sees a usable device; TTS sink mute plus the
verified meeting UI gate speech. This does not change captured PCM or either ASR backend.

After a successful reply, an identified caller can ask again for 5 seconds without a wake word.
The same five-second window applies after the fixed acknowledgment and a resumable interruption.
Both channel and known transport participant must match. Unknown identity requires another call.
Stop/policy change/failure clear this window. Quick answers skip the acknowledgment; a slow new
request gets it after 900 ms, while follow-ups do not repeat it. Short answers to clarifications
retain source-validated context. Explicit same-caller interruption and bounded lexical pause handling are described below; no semantic turn model is added.

Busy voice turns now accept fresh explicit “Khoan”, “Dừng lại”, “Ý tôi là…” from the identified
current caller. VAD/selected ASR continue while KWS stays locked. Ordinary acknowledgments, other
speakers and spoken-text echoes do not interrupt. Incomplete lexical endings wait at most two
seconds from speech end. Interrupted history/cards keep only whole completed sentences, while the
generated proposal and raw transcript remain separate. See deploy/wakeword/README.md for limits.

For multiple participants, other fresh channels with distinct known transport IDs do not cancel
the selected caller. Unknown or duplicate identities remain ambiguous. A fresh identified wake
can transfer an idle follow-up slot after playback/quiet; it cannot steal a pending question or
active reply. Per-person history keys and meeting-owned source permissions remain unchanged.

## Answer sources and public questions

In Terminal, open **Settings → Voice assistant → Room answers** after starting a Google Meet bot.
Select its meeting, keep **Use this meeting’s transcript** enabled, and choose any linked documents
that the bot may read to everyone in the room. The assistant may request one bounded extra lookup
across that authorized transcript/document snapshot before answering. Missing evidence, rejected
verification and provider failures now have separate explanations instead of one generic refusal.

**Allow general knowledge** enables standalone definitions such as “TINA ơi, ASR là gì?” or the
explicit prefix “Kiến thức chung: …”. This route receives no meeting history or documents and does
not claim to know meeting decisions. **Allow public web search** enables “TINA ơi, tìm trên web về
Redis”. Only the explicitly spoken query goes to web search. Both are opt-in per room; saving a room
policy stops its current voice turn. Web support was checked with the configured OpenAI Responses
model, `gpt-6-luna`; other adapters/accounts may report unavailable.

Terminal and the rebuilt Extension show public citation links separately from the spoken text.
Reload the unpacked Extension after rebuilding it. These changes preserve VieGem + KenLM + FSMN-VAD,
Gipformer + FSMN-VAD, the two LiveKit wake-word models, VieNeu-TTS, and canonical transcript history.
See `core/agent/eval/voice/README.md` for the 30-question synthetic check; it is not a real meeting
quality benchmark or an end-to-end latency measurement.

## Optional self-hosted LiveKit Agents pilot

After starting a bot with the current image, select **Settings → Voice assistant → Room answers →
Voice runtime → LiveKit Agents · local pilot** and save. One meeting at a time is supported. Keep
**TINA** selected for the existing pipeline; changing runtime stops the current turn and keeps source
permissions unchanged. The pilot deployment is enabled by an encrypted `LIVEKIT_AGENT_URL` and
started by `make all` through its optional profile. See `deploy/livekit/README.md`.

This first integration uses custom HTTP I/O: confirmed questions from the existing ASR/KWS enter
AgentSession, and generated PCM returns to the same microphone player. Raw audio is not republished
through LiveKit rooms. TINA still owns model settings, authorized RAG/tool retrieval and heard-prefix
history. Agents handles the custom LLM/TTS nodes and task cancellation. Native Agents automatic voice
endpointing/barge-in and a replacement tool planner are outside this pilot.

A compact voice activity label sits in the Terminal transcript toolbar and Extension
footer beside Open Terminal for Google Meet. Its primary labels are “Chờ gọi tên”, “Đang nghe câu hỏi”, “Đang xử lý”,
and “Đang trả lời”. Quiet rearm, startup, disabled voice, no active bot, ended sessions and outages
have separate labels. Listening requires fresh session-bound heartbeat and ready KWS evidence;
missing data is never inferred from ASR text or bot mic state. Client readiness expires within
15 seconds without a successful status read and immediately on an observed request failure.
The Extension reuses its existing voice snapshot read and grants no capture/control permissions.

Voice retrieval covers long segments/paragraphs using overlapping 1200-character chunks rather than truncating their tails. Original source text, segment identity and parent timestamps are preserved; exact character offsets locate each quote. Adjacent evidence and existing prompt/call budgets still apply. No embedding model or vector database is added.

Semantic voice RAG runs in Agent API on local CPU: multilingual-E5-small INT8 (384 dimensions), BM25 + reciprocal rank fusion, then existing adjacent-source and prompt budgets. This is separate from ASR/KWS/LLM/TTS. Cold indexing is bounded to three seconds plus the in-flight batch; partially indexed long meetings continue using BM25 and complete cache on later turns. Model failures retain lexical retrieval with a content-free warning. Deployments can prepare the pinned assets with `python -m control_plane.voice_retrieval --download`; Docker builds include them automatically.

To recap the full transcript, say “TINA ơi, tóm tắt cuộc họp” or “Từ đầu đến giờ đã chốt gì?”. Requests for a recent time range retain regular retrieval. Whole recaps process chronological parts, preserve original citations and verify the final short spoken answer. If preparation cannot finish within the voice deadline, TINA reports progress and asks you to repeat. Completed part work is cached for 15 minutes; every part must be processed before a factual whole-meeting recap is released. A recap is a concise selection of salient facts, not every detail or a replacement for canonical notes.

Spoken delivery follows the turn: acknowledge a name-only call, answer a clear question directly,
and ask one precise question for unresolved scope. Follow-ups supply the new detail without another
greeting; corrections retain the original goal with the latest scope. The LLM keeps the existing
JSON/source-verification contract. Missing evidence is distinguished from an ambiguous request.
Waiting speech describes a tool only when core progress belongs to the active leased session and
policy revision and the bot sees the same request within 15 seconds of the progress event.
Otherwise it uses neutral waiting copy. The notice timer skips speech if the answer arrived during
the readiness check. Notices are not committed as factual assistant answers or added to answer history.

Recovery distinguishes silent input expiry, unresolved input, unavailable sources, service failure
and playback failure. An idle five-second follow-up expires silently; fresh quiet capture reports
no_input, while speech without enough ASR and stale capture retain distinct diagnostics. It does
not announce repeated reminders to the whole room. A source-valid heard clarification chain gets
shorter repair guidance, then an example, and pauses after two unsuccessful repair prompts.
Clear answers are still accepted at that limit. Task flows retain fields and count retries per
missing step; failures do not count against the caller. Neither pause nor a service error creates
a draft, invents missing data, or opens another automatic same-person follow-up.

Unavailable answer requests may play one bounded public service notice only while the policy and
generation remain current and TTS is ready. A failed/throwing TTS attempt reports playback failure
in the UI and never recursively speaks another error. Terminal and Extension present only fresh,
same-session recovery diagnostics. Model errors do not imply quota exhaustion or user error.

## Recording a decision through Pipecat

Call “TINA ơi, ghi quyết định chuyển sang PostgreSQL”. If needed TINA asks “Đây là đề xuất hay phương án đã chốt?”. Proposed content can proceed to readback; decided content needs an exact authorized source passage plus independent verification. If sources are missing/conflicting, point to the discussion or explicitly say “ghi dưới dạng đề xuất”. After readback, say “đồng ý” to prepare a private draft; the meeting owner reviews it under the existing voice drafts in meeting Q&A. Corrections and “hủy” are supported. Stop/source changes fence the pending turn. Voice confirmation never replaces owner approval. Paused/service-error decision flows can use Continue in chat.

## Bounded recovery for mic and draft failures

A stalled Meet mic evaluation has a five-second caller deadline; local PCM stops and the actual UI operations remain serialized to avoid late unmute races. Server cancellation and heard-prefix receipt do not wait for that browser operation. Unverified mic state prevents new playback until mute is verified.

Task and decision histories retain the initial request and exact current-field input snippets at their bound, so corrections and explicit confirm/cancel stay available. An uncertain task/decision save blocks blind recreation; a definite source conflict instead returns to source clarification. Raw ASR/audio stay unchanged.
