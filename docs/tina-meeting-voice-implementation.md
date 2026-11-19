# Current voice mode: local LiveKit KWS

New Google Meet bot images use the two pinned local LiveKit WakeWord 2.1.1 models (TINA ơi,
hey TINA) for activation. Selected ASR supplies bounded same-channel question text and the
unchanged transcript. Silero endpoints, one room turn, source-clock/Stop fencing, shared TTS and
800 ms received quiet remain in place. Missing KWS makes voice unavailable; no silent text-name
fallback. Settings reports owner-scoped, current-session KWS readiness. Legacy ASR aliases clean
only a question copy after an acoustic call. See [setup](../deploy/wakeword/README.md).

The older validation snapshots below describe preceding increments, not live meeting acceptance
of the new acoustic trigger.

- [x] Original ASR observer preserves channel/source span and raw transcript, even when voice observer fails.
- [x] Name confirmation, source-bounded assembly, corrected drafts, standalone-name continuation,
  ambiguous-window refusal, duplicate/late fencing and shared room state.
- [x] Fixed acknowledgment prewarmed/cached in local TTS; private answers never cached.
- [x] Source-validated Vietnamese sentence playback, policy check before each sentence, Stop cancels tail.
- [x] Built-in name variants, owner-scoped API policy and deployment documentation.
- [x] New bot image and API/Gateway/Terminal/TTS images built; changed services activated and healthy.
- [ ] Real participant meeting acceptance (accent recall, false calls, remote audibility, overlap/echo).

Verification: 11 voice controller/assembly regressions, full bot and per-channel pipeline suites,
8 native engine tests, 53 host-client regressions, 19 focused Meeting API speech/contracts tests,
24 TTS tests plus subtests, 3 voice UI tests, related meeting/Knowledge UI tests, TypeScript compilation,
and schema/config/dataflow/isolation/contracts checks passed. Native Linux-container smoke used real
Silero with synthetic PCM and injected ASR/Knowledge/player: exactly one original ASR call, one
question, three spoken parts, original transcript preserved and started/completed receipt order.
Actual authenticated local TTS HTTP synthesis passed separately. This is not live meeting proof.

Default HTTP ASR cadence/minimum buffers remain unchanged. Short names spoken alone can wait for an
existing idle/turn-close flush; measure before changing transcript scheduling. Local speech does not
imply a local LLM; the existing model selection remains in force.

See [current operator guide](tina-meeting-voice.md).

## Owner diagnostics API

The owner-only voice API returns actionable reason codes for incoming speech
waiting on ASR, unmatched/unconfirmed names, utterance endpoint/ASR-tail waits, timeout/overlap,
service readiness, insufficient evidence, answer/playback failure, Stop and completion. At most
three initial ASR words are shown to the meeting owner; this diagnostic path never logs full questions/provider errors. Heard text and reason snapshots expire within 30 seconds of the original observation;
heartbeats and retries do not renew the text. Old sessions and ended meetings expose no details.
Terminal no longer renders the per-meeting voice controls or diagnostics panel. Settings retains the
new-bot default and TTS status.

The active API/Gateway/Terminal images were built and activated before promoting the bot image.
`dev` and `voice-diagnostics` bot tags refer to the same verified image. This deployment note is
historical; the Terminal meeting panel described above has since been removed.

Focused checks: 17 bot voice tests, 27 Meeting API voice/speech/contracts checks and 7 voice UI
component tests passed. Full bot suite and TypeScript compilation were also exercised. One related
Fact Review UI test had a timing failure in a combined run and passed in isolation; no Fact Review
code was changed. The final combined run passed all 28 related UI tests; no Fact Review code was changed.

Isolated HTTP proof used the actual bot and Meeting API images with a synthetic room, in-memory
Redis and network-isolated containers. It verified three-word truncation, no full-question exposure,
owner-only access, bot capability authentication and unchanged absolute expiry after heartbeats.
Production owner GET also rejected another account and hid ended-session details. Data volumes,
ASR backends, model selection and existing source policies were preserved. No commit/push.

Live microphone/meeting behavior remains an operator acceptance check: create a new bot, call
TINA and inspect the actual diagnostic transition. Synthetic HTTP/component checks do not prove
real-world recall or remote audibility.

---

## Historical implementation snapshot (superseded bot KWS mode)

# In-bot Google Meet voice assistant

Owner-approved implementation: tee PCM without changing transcript ASR; one CPU KWS model per bot and independent speaker streams; bounded Silero capture; same resolved ASR backend; room-scoped source policy; shared TTS with bounded scheduling. No personal participant key is required.

- [x] Shared native engine and per-bot state machine, bounded IPC and lifecycle.
- [x] Meeting/session-scoped API capability, owner policy, source validation and cancellation.
- [x] Google Meet capture tee and existing Speak/Stop integration.
- [x] Read-only shared model cache, image/runtime/Compose startup wiring.
- [x] Owner Voice assistant control and explicit shared-source selection.
- [x] TTS bounded queue, regressions, contract/architecture updates and operator guide.

Physical meeting acceptance: real accented voices, immediate question after wake, overlapping speakers, TTS echo, Stop during each state, departure during inference, multiple concurrent meetings. Synthetic tests do not establish audibility or KWS accuracy.

## Verification snapshot

- Host speech pilot: 53 tests passed after shared-engine extraction.
- Native core voice engine: 6 tests passed; one model/shared streams, source identity reset, overlap refusal, quiet gate and wall timeout.
- Bot: full existing suite plus seven focused voice orchestration regressions passed; TypeScript compile passed.
- Meeting API focused spawn/voice/speech/contracts: 92 tests passed.
- Agent Knowledge and voice authorization/freshness: 23 tests passed.
- Gateway route ownership/scope matrix: 304 tests passed.
- Terminal meeting/Knowledge/voice controls: 47 tests passed; TypeScript compile passed.
- Compose entrypoint and ASR controller: 56 tests plus 4 subtests passed; runtime model mount: 2 tests passed.
- TTS host tests: 23 tests plus 5 subtests passed; TTS image server tests: 14 passed.
- Bot and TTS images built with review tags, without replacing running production containers.
- Pinned native model cache prepared in `tina-production_meeting-voice-models`; native startup from read-only volume passed inside Linux ARM64 bot image.
- Pinned TTS model/codec cache prepared in `tina-production_tts-models`; real offline Trúc Ly synthesis from a read-only volume produced 130560 PCM bytes (2.72 seconds at 24 kHz), non-silent. No audio was played into a real meeting.
- Synthetic Samantha sample at normal speed did not trigger KWS; a slower sample with separated calls triggered the unchanged KWS baseline three times and the bot captured one bounded question, then stayed THINKING. These are functional checks, not human/accent benchmarks.

## Remaining activation and acceptance

- [x] Created a separate machine-local encrypted token/key pair under `~/.config/tina/tts-local/` with owner-only permissions; kept shared `deploy/tts/.env` unchanged. Activated the changed API/Gateway/Runtime/Terminal images and speech profile. Verified API and TTS credentials match, authenticated synthesis works, and new bot configuration inherits the same token and voice capability. No real bot was spawned by this verification.
- [ ] Validate an admitted Google Meet with real participants, actual audibility/Stop and speakerphone echo; measure false triggers/misses and multiple concurrent rooms.

The local production stack now runs the updated images and shared TTS. Unrelated working-tree files are preserved; no commit, push or merge was performed.

Final container smoke used real KWS/Silero and the actual TypeScript controller over PCM IPC. It made one injected ASR call, one injected Knowledge call and one injected playback call, reported started/completed, then re-armed after quiet and stopped cleanly. STT/Knowledge/playback upstreams were synthetic fakes in this smoke; actual TTS inference was verified separately. This is not a live meeting E2E claim. CALM validation passed with existing advisory warnings; isolation, Python graph, contracts, config, dataflow, license and image-license gates passed.

Machine-local activation verification: shared repo ciphertext unchanged, encrypted local files mode 0600 and directory mode 0700, API/TTS token equality verified without logging values, real authenticated HTTP synthesis returned 99840 non-silent PCM bytes at 24 kHz, and ASR controller health passed. Bootstrap now skips registry pulls for locally built initializer image aliases and preserves selected Compose profiles across ASR-controller restart without storing the TTS token there. A regression also covers the bot constructor's default signing-key fallback.
