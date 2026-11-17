# bot — the meetings ephemeral join+capture worker (Node/TS)

Fixed voice notices rotate independently within each bot/meeting: four name-only acknowledgments,
four generic question-wait phrases and four recap-wait phrases in `VOICE_NOTICES`. A completed
question never uses the name-only group. Fast answers skip filler, including a result arriving while
the notice's policy check is pending. Slow new questions receive at most one notice after 900ms;
ordinary follow-ups keep their existing no-extra-ack behavior. Every fixed phrase bypasses the busy
Agents session and pure normalized notice echoes are ignored during caller continuation. The TTS
`WAKE_TEXTS`/`WAIT_TEXTS`/`SUMMARY_TEXTS` catalog must match these phrases. No LLM chooses filler.
After acoustic KWS confirmation, the assembled ASR question copy starts after the located invocation,
including names split across windows and punctuation after “hey”. Pre-roll speech before that name
is context only, including cached ASR replayed when KWS fires. If ASR omits the name, only complete
intervals starting after detection (with one 64 ms capture frame of slack) supply a question.
Uncertain boundaries or multiple possible calls take the name acknowledgment path and wait for the
caller; they never dispatch old speech as a request. Original ASR text, source timing, caller ownership
and the requirement for acoustic confirmation stay unchanged.

`voice_timing` logs retain only request UUID/channel, timestamps and durations. Speech timing is
split into `ack_*` (name acknowledgment), `notice_*` (question/recap wait) and `answer_*`.
Each group records `tts_requested`, `pcm_received`, `buffer_ready` and `playback_started`;
durations include `first_pcm`, `prebuffer` and `mic_start_after_buffer`. Answer timestamps retain
the first sentence rather than being overwritten by lookahead. `answer_pcm_after_end` and
`answer_playback_after_end` start at the final question speech-end timestamp. Playback starts only
after the meeting mic is verified, the player spawns and its first PCM write succeeds. This proves
local microphone injection, not receipt or audibility at another participant's speaker.

Slow whole-meeting recap requests receive one fixed, prewarmed waiting notice instead of the
ordinary acknowledgment. Transcript capture continues; the same voice turn waits for the verified
result and plays it automatically. Stop/departure, caller correction, generation replacement and
policy revision fence late results. The notice is not a factual answer or a heard-history turn.
It uses direct shared TTS to avoid the busy Agents session, with a six-second notice deadline. Service wait is bounded to 170 seconds
and the whole turn to 330 seconds, inside the 360-second server reservation. Only one voice turn
runs per meeting; this does not enable simultaneous questions or unbounded background playback.

## Purpose

The disposable meeting-joining browser bot (P7 worker). It boots from a single `invocation.v1`
config in `TINA_BOT_CONFIG`, joins a Google Meet / Zoom / Teams call over a humanized browser,
captures audio, transcribes it (`@tina/transcribe-whisper`), and publishes confirmed
`transcript.v1` segments + `lifecycle.v1` status — then dies. Node/TS because the join+capture
domain lives in the browser/Playwright ecosystem; it's a modular monolith behind ports — the
orchestrator core is offline-provable, while browser/redis/http are adapters wired only at the
composition root (`src/index.ts`).

## Seams

| Direction | Neighbour | Via | What crosses |
|---|---|---|---|
| consumes | scheduler / meeting-api (spawner) | `invocation.v1` in `TINA_BOT_CONFIG` env | boot config: meeting URL, platform, ids, callback/upload URLs, secrets |
| spawns-over | `@tina/join` + `@tina/remote-browser` | in-process port (`JoinDriver`) | join/leave/removal over a humanized browser page |
| publishes | collector [Py] | redis stream `transcription_segments` (XADD) | `transcript.v1` durable segment feed |
| publishes | gateway → dashboard | redis pub/sub `tc:meeting:{id}:mutable` | live mutable `transcript.v1` segment |
| produces | meeting-api | HTTP POST → `inv.meetingApiCallbackUrl` | `lifecycle.v1` status events (retry/backoff) |
| produces | meeting-api | HTTP POST → `inv.recordingUploadUrl` | assembled recording master (multipart) |
| consumes | gateway (commands) | redis pub/sub `bot_commands:meeting:{id}` | `acts.v1` commands (e.g. `speak` / `speak_stop`) |

### Pre-join reachability gate (#530)

Before any meeting navigation, the orchestrator makes the FIRST `joining` emit **load-bearing**
(`orchestrator.ts` → `emitJoining`): the HTTP sink's `emitReachable` reports whether the meeting-api
callback answered at all (any HTTP status = reachable; only an all-attempts network failure — the
fresh-node CNI-lag signature — is `unreachable`). Reachable ⇒ the join proceeds with **zero added
latency** (the secondary channel is never probed). Unreachable ⇒ it probes the secondary channel
(redis PING); **either channel up ⇒ proceed** (the bot can still report), **both down ⇒ refuse to
join** and terminate fast with a typed, attributed outcome instead of an opaque crashloop.

**Exit codes** (the terminal signal on k8s, where each bot is a bare Pod, `--restart=Never`):

| Code | Meaning |
|---|---|
| `0` | clean terminal (`completed`, or a user `stop` withdraw) |
| `1` | join / runtime failure (`join_failure`, `validation_error`, admission rejected/timeout) |
| `3` | **control plane unreachable** — both the meeting-api callback and redis were unreachable at boot; the bot refused to join (`failed`, `failure_stage: requested`, `infra_fault: control_plane_unreachable`). Distinguishes a **broken node** from a **broken join** in one `kubectl describe`. |

## Contracts

**Owns:** none — the bot is a worker that implements published meetings contracts.
**Consumes:** [`invocation.v1`](../../contracts/invocation.v1) (boot config),
[`acts.v1`](../../contracts/acts.v1) (inbound commands),
[`lifecycle.v1`](../../contracts/lifecycle.v1) (status it produces),
[`transcript.v1`](../../contracts/transcript.v1) (segments it publishes). All four are TS-mirrored
in `src/contracts.ts` and validated against the sealed registry goldens (`contracts.seal.json`).

## Isolated evaluation

Voice diagnostics and `voice_timing` outcomes distinguish service failures (`answer_failed`) from
missing or unverifiable evidence (`no_evidence`), even when the spoken recovery audio completes.
The playback receipt still records the audio as completed; it does not imply a factual answer.

Unit/integration: `pnpm test` (chained `tsx` runs — no build step). Levels:
**L1** config ajv goldens · **L2** orchestrator `lifecycle.v1` state machine (fake ports) — incl. the
#530 reachability gate (both-channels-down ⇒ no join, exit 3, `control_plane_unreachable`; either-channel
up ⇒ proceed) · **L3** transport adapters (lifecycle-http `emitReachable` reachability verdict ·
transcript-redis · acts-redis), pipeline lane, recording
assembler, replay tape. **L4** (browser/capture/speak/upload legs) runs via the standalone harness in
[`eval/`](./eval): `make -C eval run MEETING=<id>` drives a live Meet with synthetic speakers and an
autonomous PASS/FAIL verdict (`make -C eval verify` for the offline oracle self-test).

## Status

- ✅ delivered — `invocation.v1` boot config (parse + ajv-validate, fail-fast)
- ✅ delivered — orchestrator `lifecycle.v1` state machine (joining → admission → active → completed/failed)
- ✅ delivered — `transcript.v1` egress (redis stream + mutable pub/sub)
- ✅ delivered — `lifecycle.v1` HTTP callback (retry/backoff, never crashes the bot)
- ✅ delivered — `acts.v1` ingress (redis subscriber; unknown acts dropped, never thrown)
- ✅ delivered — recording assembler core (webm/wav/seq, L2/L3)
- 🟡 partial — browser join + capture + recording-upload + speak (wired; L4-gated, proven on VM via `eval/`, not unit tests)

### Source ring and archived range recovery

The per-channel lane now uses the shared bounded sample ring; capture time/sample counters cross
the browser bridge together. Captured-signal.v1 remains frozen: optional source-clock annotations
ride the existing observations sidecar as `source: audio-timeline`, `observation.type: source-frame`,
with frame_seq, speakerIndex, start_sample, end_sample, sample_rate. No PCM is duplicated into that
sidecar. Capture-signal recording must be enabled and its upload must have succeeded to recover
an isolated source after the bot exits; a mixed recording alone cannot reconstruct an isolated track.

After downloading the existing capture + observations sidecars, extract an exact interval:

```sh
node core/meetings/services/bot/dist/audio-archive.js capture.jsonl observations.jsonl 0 0 16000 output.wav
```

The reader is bounded to 30 seconds, keeps channels separate, and refuses missing/overlapping data
rather than filling silence. Existing recordings lacking source-clock annotations still have their
original playback/replay path, but cannot claim exact sample-index recovery through this reader.

Voice audio uses separate PulseAudio sinks: meeting_rx receives browser playback, while tts_sink
feeds virtual_mic. The source stays unmuted so Meet sees a usable device; TTS sink mute plus the
verified meeting UI gate speech. This does not change captured PCM or either ASR backend.
The TTS sink starts at 70% volume for all bot speech, independently of meeting receive audio.

VoiceInterruption uses caller identity, source-clock/ASR agreement, final soft-correction timing and a bounded recent-playback text echo fence. MeetingVoice mutes locally and persists the completed-sentence prefix before remote cancellation; failed receipt/release prevents automatic continuation. See docs/tina-voice-speaking-interruption.md.

After a spoken prompt, the same caller has five seconds to begin a reply. A primary VAD onset
with matching recent transport identity reserves that reply while ASR completes, bounded by the
existing 20-second capture limit. Other callers, stale audio, Stop and policy changes cannot extend it.
