# Wake-word + TTS implementation plan

Status: phases 1–3 and the phase 4 multi-client arbitration/controller are implemented.
Remote meeting audibility, two physical host/microphone acceptance and human wake-word
validation remain open. Implementation and simulated checks are not the human release gate.

Phase 3 implemented coordinator, bounded Silero capture, participant client and core-owned
speech.v1 playback receipts. Focused checks passed for Meeting API/legacy Stop, bot speech and
Gateway/manifest seams. See [the speech client README](../clients/speech/README.md#authorized-voice-turns).

Live synthetic integration evidence (2026-11-04): a paced WAV passed native KWS/Silero capture,
real self-hosted STT, the existing meeting Knowledge LLM endpoint with an explicitly created
synthetic Markdown source, and actual bot playback in an admitted Meet session. The turn and
bot receipt both reached completed; the participant controller returned to ARMED. The supported
answer was "The synthetic review is Friday." No real transcript sources were approved for this run.
Stop during a separate long playback reached stopped in 138 ms. Native negative replay made
zero turn requests. Evidence is under ignored `output/speech-stage3/e2e-proof.json` and
`live-turn.log`. Remote audibility/Stop listening confirmation is still pending the user;
real-human microphone/accent validation remains deferred as explicitly requested.

Compatibility fix from the live run: omit the unused empty meeting_ids request field for older
single-meeting Agent APIs, and bind absent per-source meeting IDs to the fixed authenticated
Knowledge endpoint. Explicit different meeting IDs and unapproved document paths still fail.
The focused speech suite now has 51 passing tests including phase 4. This does not add cross-meeting retrieval.

Resource constraint after the Windows virtual-memory incident: run builds/tests sequentially,
limit Node heap to 2 GiB, and apply the operator's WSL resource cap before container integration
builds. The default shared voice remains the approved Trúc Ly / "ti na".
Branch: `feat/tina-speech`. Planning baseline: `6dfbbbf`; phase 1 started from `ab4a743`.

## Agreed outcome

Each participant runs microphone capture and wake-word detection on their own machine. After
"Hey TINA", that participant asks a question. One meeting-level dispatcher obtains an answer
from the meeting's approved transcript/Wiki sources. One TTS output speaks that answer into
the meeting. Ordinary meeting transcription continues throughout.

Use `lean-build`: reuse published boundaries, complete one narrow path, and stop when its
observable acceptance conditions pass. The objective is minimal coupling, not an arbitrary
one-file implementation.

The first supported room has one platform, one voice-enabled browser bot, one designated
operator/owner, and explicitly enrolled participants. Start with question answering; automatic
document edits, tool execution, personal agents, interruption while speaking, and additional
meeting platforms are later work. Wake detection is activation, not authentication or consent
to execute an action.

### Model baseline

- Wake-word: `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, INT8,
  with the English keyword `HEY TINA` tokenized using that model's BPE files. Run on each
  participant's CPU. Evaluate Vietnamese-accented pronunciation before accepting it.
- TTS implemented: Blaze VieNeu-TTS v3 Turbo Enhanced, ONNX CPU, SDK 3.8.3, female Trúc Ly preset
  (Northern Vietnamese, natural style). Standalone TINA is normalized to "ti na" only for
  synthesis. The optional service resamples 48 kHz output to the bot's 24 kHz PCM contract.
  Piper was dropped because eSpeak introduces GPL, conflicting with ADR-0004. The selected
  SDK, phonemizer and model/codec cards declare Apache-2.0. Vietnamese/English listening
  quality is still an operator acceptance check, not a validated bilingual claim.
- No paid cloud speech API is required. TTS revisions and checksums are fixed in
  [`model-assets.json`](../deploy/tts/model-assets.json), with hash-locked Python dependencies.
  Wake-word assets will be pinned in phase 2. No voice cloning or model training is enabled.
- Sources: [Sherpa KWS models](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html),
  [Enhanced model card](https://huggingface.co/blaze-voice-ai/vienue-v3-turbo-enhanced),
  [OpenMOSS codec card](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX).

## Verified starting points

| Capability | Existing implementation | Consequence |
| --- | --- | --- |
| Per-machine capture | `clients/desktop-native` is macOS-specific; `clients/speech` now provides an isolated Python host pilot | No macOS application prerequisite; real microphone validation remains on the participant's host |
| Sherpa KWS | `core/meetings/services/native-asr/vendor/sherpa-onnx/src/kws.rs` exports `KeywordSpotter` | This is a library capability, not a configured detector; keep vendored code untouched |
| STT | `deploy/transcription/docker-compose.cpu.yml`, existing OpenAI-compatible transcription API | Reuse Faster-Whisper; do not replace the meeting buffers or confirmation engine |
| Gateway-only client | `clients/slim/tina_slim/client.py` and `sse.py` | Reuse these boundary conventions, not domain internals; its chat helper is not a complete voice-turn controller |
| Grounded Wiki Q&A | `core/agent/control_plane/meeting_knowledge.py`, `shared/meeting_knowledge.py` | Reuse source selection, citations, ownership and stale-source checks; do not create a competing RAG index |
| Common speech output | `lifecycle/speak_router.py`, `bot_spawn/service.py`, bot `tts-playback.ts` | Use existing `POST`/`DELETE /bots/{platform}/{native}/speak`; do not publish directly to Redis |
| Playback cancellation | `createSpeakController`, `TtsPlayback.stop()` | Reuse; protect each turn from late synthesis/results |
| Playback completion | Speak returns `accepted`, and bot playback errors are currently best-effort logs | HTTP acceptance does not prove synthesis or audible playback; automated room sequencing needs completion/error evidence |

Operational snapshot when preparing this plan:

- Windows checkout: branch `feat/tina-speech`, revision `6dfbbbf`.
- WSL checkout used to build the stack: `a4eed12`. Updating Windows does not update WSL or built images.
- At planning time `tina-local` had no TTS configuration. Phase 1 configured the private
  endpoint/token and recreated only Meeting API. Build/deployment use the Windows source;
  the separate WSL checkout remains untouched.
- Earlier synthetic agent checks succeeded for independent questions but failed two memory-recall
  checks. Use source-grounded questions for this MVP; do not depend on conversational memory.
- Earlier STT `/health` checks passed; CLI `asr verify` expects `/status`, which this Faster-Whisper
  server does not implement. Do not treat that check alone as an inference verdict.

## Minimal architecture

```text
Participant's machine (explicit Start/Stop)
  microphone -> normalized PCM -> Sherpa KWS
                                  |
                              wake event
                                  v
                       bounded question capture + VAD
                                  |
                     authenticated request + short WAV
                                  v
Meeting-level coordinator (one instance for the pilot)
  participant authentication + explicit room enrollment
    -> one active turn per room
    -> existing STT endpoint
    -> Gateway: existing meeting Knowledge /ask
    -> validate source policy and freshness
    -> Gateway: existing bot /speak
    -> playback outcome -> release turn -> re-arm clients
                                  |
Existing meeting bot: TTS service -> PulseAudio -> meeting microphone
```

Capture/detection must run on the participant's host. WSL runs the current backend, but microphone
availability inside WSL is not assumed. Test the host client on its actual operating system.
No new bot capture hooks or changes to Google Meet/Teams segmentation are needed for this topology.

The coordinator is a small application above the domains, initially planned under `clients/speech/`.
It consumes Gateway APIs; it must not import meetings/agent internals or hold a Redis URL.
Its externally consumed request/event schemas remain core-owned, as required by `AGENTS.md`.
It holds the operator's server credentials privately. Local clients receive no bot-owner, LLM,
shared STT or TTS service secret.

Important access constraint: the current Q&A and Speak endpoints are owner-scoped. A common session
string does not create shared access. For the pilot, an operator explicitly enrolls authenticated
TINA users into one room and approves the transcript and linked Wiki documents that may be spoken
to that room. Validate participant identity through Gateway `/auth/me`; never trust a caller's
`user_id` field. The coordinator's operator identity must own the configured meeting/bot.
Reject unenrolled users and meeting/document substitutions. This explicit pilot delegation does
not change core meeting ownership or imply arbitrary shared-workspace support.

## Ordered work and exit gates

### 0. Establish one development source and test fixtures

- [x] Preserve `note.txt`, existing output artifacts, local WSL changes and private env files.
- [x] Select the Windows `feat/tina-speech` checkout as phase 1's build source. Build from it
      directly; leave the older WSL checkout intact rather than blindly mirroring directories.
- [x] Keep the running `tina-local` stack and the private Terminal development overlay; use a
      dedicated speech test room/config. Do not use `docker compose down -v` or rotate existing keys.
- [ ] Prepare consented positive and negative audio: several speakers saying "Hey TINA", near-match
      names/phrases, normal conversation, noise, silence, and TINA's own synthesized speech.
- [x] Keep TTS model files/audio outside source control. Record model URL, revision, SHA-256, language
      coverage and redistribution terms in an asset manifest before deployment.

Exit: one identified source revision, recoverable local config, and reproducible audio fixtures.

### 1. Prove text -> TTS -> meeting before adding wake-word

- [ ] Select one self-hosted TTS backend and voice that passes Vietnamese/English listening checks
      on the actual CPU hardware. Do not add several providers or train a voice for the MVP.
- [x] Implement an adapter only if the selected backend cannot expose the existing bot contract:
      `POST {TTS_SERVICE_URL}/v1/audio/speech`, JSON
      `{model:"tts-1", input:text, voice:"auto", response_format:"pcm"}`,
      `X-API-Key: <TTS_API_TOKEN>` when configured.
- [x] Verify headerless PCM16 little-endian, mono, **24 kHz**; resample exactly once if needed.
      A WAV header, a different sample rate, or Bearer-only auth cannot silently pass as compatible.
- [x] Use a private env file and optional deployment overlay. Configure the endpoint/token for
      Meeting API, then spawn a **new** voice-enabled bot; old bot environments are not updated.
- [ ] Send a bounded text through the Gateway Speak endpoint, then test DELETE Speak cancellation.
      Current text limit is 4,000 characters; reject or deliberately shorten oversized answers.
- [ ] Verify actual received audio from a second participant/test recording. HTTP 200/`accepted`
      and generated PCM alone are insufficient proof.

Exit: audible, intelligible speech and working Stop on one platform. The ordinary transcript path
continues to work. No changes to the LLM worker, transcript schema, or meeting capture modules.

Phase 1 evidence (2026-11-04):

- Added only the optional [`deploy/tts`](../deploy/tts/README.md) runtime, tests, configuration
  and supporting CI/architecture/license documentation. Existing core Speak/Stop code is reused.
- Nine offline regression tests pass, including authentication, bounded concurrency, input
  validation, PCM resampling and pinned offline asset verification.
- Three real CPU syntheses returned HTTP 200: 2.354, 1.666 and 1.618 seconds for respectively
  3.92, 3.68 and 3.60 seconds of speech. This small smoke sample is not a latency benchmark.
- The shipped bot adapter and real PulseAudio virtual microphone produced non-silent audio;
  Stop during playback settled in 17 ms and re-muted the source. An automated STT round trip
  recognized the test sentence but misrecognized the name TINA; human intelligibility remains open.
- Two controlled Google Meet attempts failed before admission with HTTP 403 and
  `awaiting_admission_rejected`, including after the operator reported accepting the bot.
  Gateway Speak/Stop in an admitted meeting and remote-participant listening remain unchecked.
- Main Meeting API reaches both TTS and existing STT health endpoints successfully. Synthetic
  WAVs and content-free timing reports are kept under ignored `output/tts-stage1/`.
- README, architecture/dataflow seal, CALM validation and existing image-license gates pass;
  CALM retains advisory warnings for existing nodes. The raw Windows checkout's contract-version
  gate fails because schema hashes include CRLF bytes. A disposable Git HEAD snapshot and a
  disposable LF-normalized working snapshot both pass all 40 sealed contracts; no contract files
  or contract seals were changed to hide this checkout issue.

Do not mark phase 1's meeting acceptance gate complete until a second participant hears the
speech and verifies Stop in a room that admits the bot.

Voice correction after the initial pilot: explicitly select the female Trúc Ly preset instead
of the SDK's male default and normalize the standalone name TINA to "ti na" before inference.
Ten regression tests pass. A new real synthesis produced 3.36 seconds of non-silent audio in
2.056 seconds; the listening sample is ignored `output/tts-stage1/tina-female.wav`.

### 2. Prove local wake detection without agent/network actions

- [x] Add the isolated `clients/speech/` package with one CLI entry point and an explicit microphone
      device selector. Start with Python 3.11, Sherpa-ONNX Python bindings and a host audio adapter;
      pin the versions proven by the fixture run. Do not extend the native-ASR HTTP server for
      frame-by-frame detection or modify its vendored Rust bindings.
- [ ] Select one English-capable KWS model and configure "HEY TINA" with that model's tokenizer.
      Test Vietnamese-accented speakers. A supported model language is not proof of this phrase's
      accuracy; "TINA oi" is not silently accepted as equivalent language support.
- [x] Normalize incoming audio once to the selected model format, typically 16 kHz mono PCM.
      Use a dedicated capture/inference queue so native audio callbacks never block on HTTP.
- [x] Keep a short bounded ring buffer. Record the wake boundary so the immediate following question
      is not clipped; only remove the wake prefix at that boundary, never arbitrary words in text.
- [x] Emit one local wake event per utterance; add cooldown/reset and isolate detector state per
      microphone. Question-ending VAD remains phase 3; it must not replace wake detection.
- [ ] Measure detection misses, false triggers, wake latency and CPU on held-out human audio.
      Do not count TTS-generated fixtures alone as human wake-word validation.

Exit: repeatable local wake events without sending audio to STT/LLM or playing speech.

Phase 2 evidence (2026-11-04):

- [`clients/speech`](../clients/speech/README.md) has explicit setup/devices/listen/file commands,
  pinned Sherpa-ONNX 2.0.1 CPU, sounddevice and SentencePiece dependencies, and a universal uv lock.
  Model archive/file hashes are pinned; startup only validates local files. Model tokenizer gives
  `▁HE Y ▁T IN A @HEY_TINA`. Core source/API/event contracts and the running stack are unchanged.
- PortAudio is requested at 16 kHz mono float32. The callback enqueues <=20 ms frames into a
  one-second bounded queue; inference is outside the callback. A two-second pre-roll retains the
  detection boundary, not an exact word-end alignment. Overflow/disconnect stops/disarms capture;
  Ctrl+C closes it. Question endpointing/VAD and upload belong to phase 3.
- Nineteen deterministic tests cover gating, cooldown, isolated state, bounded memory, Stop,
  device failure, WAV format, offline operation and corrupt assets. The real INT8 model detects
  all three Microsoft Zira English synthetic calls and no near-match/ordinary-speech triggers.
  A shared Trúc Ly response without the wake phrase also has zero triggers.
- The synthetic **Trúc Ly Vietnamese-accented wake phrase is missed: 0/3**. This is retained as a
  known failing acoustic fixture, not hidden by lowering the threshold. The English-model choice
  remains provisional pending the user's real voice/accent pilot; do not enable meeting actions
  or claim release accuracy from these synthetic results.
- Artifacts and per-file timings/hashes live under ignored `output/speech-stage2/`.
  `make-fixtures.ps1` reproducibly creates the English positive/negative fixtures on Windows.
  The user requested synthetic validation first and will perform the microphone pilot later;
  no real microphone recording was started in this phase. Trúc Ly / "ti na" remains the approved
  default for shared TTS.

### 3. Connect one authorized participant end to end

- [x] Implement the coordinator and its narrow request/status contract. Proposed local state:
      `OFF -> ARMED -> CAPTURING -> WAITING -> SPEAKING -> ARMED`, with explicit error/cancel paths.
      Apply a bounded no-speech timeout, question duration and audio/text size limit.
- [x] Authenticate/enroll the participant and accept one bounded WAV with a stable request ID.
      The coordinator uses the already-running STT service with server-held credentials. Do not
      distribute the shared transcription token or use Terminal's cookie-based `/api/stt` as if it
      were a machine API accepting arbitrary `X-API-Key` headers.
- [x] Call `POST /agent/workspace/meeting-knowledge/{meeting_id}/ask` through Gateway using the
      configured operator identity and approved linked document paths. Reuse its existing
      `{question, documents}` body, omitting unused empty cross-meeting fields for older APIs.
      Restrict the pilot to one meeting.
- [x] Check the returned answer/source IDs, approved source paths and `stale` state. Speak the
      validated `claims[].text` only. Empty claims produce a fixed "not enough information" reply.
      A network/model/source error never falls through to raw JSON, logs, tool output or an
      unrelated personal-chat answer. A read-only question may store an answer snapshot as the
      existing API does; it never calls Wiki Apply or document-edit endpoints automatically.
- [x] Tie the request lifecycle to real synthesis/playback outcome. The original bot Speak path
      had no completion acknowledgement. Added the smallest correlated started/completed/failed/
      stopped status seam under meetings ownership, with existing Gateway authorization and
      optional command correlation for legacy callers. Define exact wire shape in the contract
      change, then update affected callers/goldens/seals. Do not infer playback completion from
      HTTP acceptance, a log string, or a character-count sleep.
- [x] Ignore a late result after cancellation and return to ARMED on bounded failure.

Exit: one real microphone -> wake -> STT -> grounded answer -> audible shared TTS, including
cancel/error recovery. No requirement for multi-turn LLM memory or automatic business actions.

### 4. Add the remaining enrolled participants

- [x] Maintain one active turn per room centrally, from question capture through playback completion.
      Use a bounded busy response first, rather than an unbounded queue of stale spoken questions.
- [x] Deduplicate a participant retry by authenticated identity + request ID; preserve the same ID
      on retry. Do not automatically repeat an ambiguously accepted Speak command.
- [x] Pause wake-triggered dispatch on **every enrolled client** during a shared reply. A missing
      coordinator/status connection disarms dispatch; microphone recording permission remains a
      local explicit choice. Re-arm only after terminal playback status or operator recovery.
- [ ] Test one spoken call heard by two nearby microphones. Request IDs alone do not deduplicate
      physical cross-talk; the central capture grant must allow only one winning client.
- [x] Handle disconnect/restart explicitly. The first single-process coordinator may keep volatile
      state, but restart invalidates grants and requires re-arming; do not claim durable exactly-once
      playback or silently replay requests. Add persistent delivery state only if acceptance needs it.
- [x] Simulated two-client simultaneous capture, disconnect/restart and STT/LLM/TTS/bot failures
      with no second shared answer on retry.
- [ ] Physical headphones/loudspeakers, two microphones and a truly muted/disconnected Meet bot.
      Simulated tests cannot prove remote audibility or acoustic cross-talk behavior.

Implemented handshake: [speech-room.v1](../core/meetings/contracts/speech-room.v1/README.md).
All hosts independently poll occupancy; stale status/epoch change requires explicit participant
restart. Capture revisions reject late losing wakes even after the previous turn finishes.
BUSY/terminal release requires 800 ms local quiet and acoustic-history reset before ARMED.
No main-stack image rebuild, new service/dependency or source/voice policy change is needed.

Native smoke on 2026-11-04: two independent local KWS/Silero clients over real loopback
HTTP, with simulated upstream services, admitted one shared call, suppressed a repeated wake WAV
while busy, then admitted the other participant. Exactly two STT/Speak calls for two turns; both
clients returned to ARMED. Evidence: ignored `output/speech-stage4/native-proof.json` (26.16 s).
This used one physical machine and no microphone/Meet; it is not physical cross-talk acceptance.

Exit: two separate host clients can ask in turn, only one answer plays, and room audio cannot
cause repeated wake -> answer loops.

## Change budget and ownership

| Area | Planned change |
| --- | --- |
| `clients/speech/` (new) | Local audio/KWS adapter, bounded turn controller, coordinator, Gateway/TTS clients, focused tests and README; split by responsibility only as needed |
| `deploy/tts/` (implemented) | One optional TTS deployment and private configuration example; no new default startup services |
| Core contracts | New speech-turn/status boundary owned by the appropriate core domain; additive correlation for the existing Speak path only when implementing playback status |
| Meeting API + bot | Minimal playback lifecycle/status bridge, preserving existing Speak/Stop behavior; no direct agent imports |
| Agent/Knowledge | Reuse the current published endpoint; no second prompt/retrieval pipeline |
| Architecture/config | Update `architecture.calm.json`, declarations/examples and matching seals in the same implementation change |

Do not edit `transcribe-buffer`, LocalAgreement, speaker attribution, transcript storage, the
Dispatcher, model-provider adapters, identity policies or existing user tables for this feature.
If a genuine owner/access restriction prevents the intended room policy, stop treating it as a
client bug: document the exact missing authorization contract before expanding core behavior.

The architecture model now includes the implemented optional TTS service and bot HTTP edge.
Add the remaining proposed nodes/flows when their code actually exists, not in advance.

## Focused acceptance and stop condition

- Deterministic tests: no wake -> no request; one wake -> one capture; VAD timeout; cooldown;
  cancellation; empty STT; malformed/stale/unauthorized Wiki answers; TTS failure; no re-entrance
  while speaking; late responses discarded; stable retry identity; two-client capture arbitration.
- Contract/seam tests: existing Speak/Stop compatibility, correct PCM/auth, status correlation,
  current-user authentication and room enrollment, zero private-document fallthrough.
- Human pilot: at least 100 held-out wake attempts across at least five speakers and an eight-hour
  negative/cross-talk corpus. Proposed release gate: >=95/100 detections and zero observed false
  dispatches in that negative run. These are sample gates, not a statistical reliability guarantee.
- Measure p50/p95 wake-to-capture and question-end-to-first-audio latency plus idle/active CPU on
  the target host. Set the latency budget from the first real run; publish the results rather than
  promise model/vendor benchmark numbers on unrelated hardware.
- After implementation, run relevant existing bot/Meeting API tests, new speech tests, and affected
  config/contract/architecture/isolation gates. Existing STT fixture results must not regress.

Stop after two-client, one-room, grounded question answering with one common TTS output passes
these checks. Deferred work: barge-in, arbitrary shared/personal agents, new platforms, wake model
training, voice cloning, semantic search replacement, and automatic external actions.

## Source references

- [Sherpa KWS mechanism and supported model families](https://k2-fsa.github.io/sherpa/onnx/kws/index.html).
- [Existing Speak route](../core/meetings/services/meeting-api/src/meeting_api/lifecycle/speak_router.py).
- [Existing TTS playback adapter](../core/meetings/services/bot/src/tts-playback.ts).
- [Knowledge Q&A and ownership](../core/agent/control_plane/meeting_knowledge.py).
- [Gateway-only client](../clients/slim/tina_slim/client.py).
- [Current STT CPU deployment](../deploy/transcription/docker-compose.cpu.yml).
