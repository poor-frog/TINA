# @tina/bot — src

The bot worker's source. Hexagonal: the orchestrator core depends only on ports + contract
types; transports are adapters wired at the composition root.

**Status: 2b adapters wired (L1/L2/L3 green); the browser-resident legs are L4-pending → O6 (VM).**

Voice turn handling uses `voice-trigger.ts` for bounded lexical pause waits and source-clock
assembly; `voice-interruption.ts` verifies explicit same-caller commands and rejects echo text,
backchannels and stale ASR. `meeting-voice.ts` owns cancellation, correction continuation and
completed-sentence playback progress. Canonical ASR text and backend choice remain unchanged.

Name-only calls receive a short acknowledgment; complete questions and follow-ups go straight to
the answer. A name followed only by vocative/polite particles also receives an acknowledgment;
acoustic KWS permits known ASR name variants without changing the saved transcript or enabling
ASR-only activation. A slow turn gets at most one waiting phrase. Specific transcript/document/web/context
or draft notices require fresh core tool progress matching the request and policy revision;
otherwise the bot uses neutral wording. Progress never authorizes a source or changes the answer.

Expired idle follow-ups remain silent and distinguish quiet capture, missing capture and speech
without enough ASR. Recovery pauses/service failures require a new wake. A current answer-service
failure may play one cached public notice; unavailable/failed TTS is UI-only and never retried as
another spoken error. Late policy/Stop changes fence this optional speech too.

`livekit-stt.ts` sends accepted per-turn PCM16 frames over the private audio bridge, then references
source-aligned windows instead of retransmitting overlapping audio. The existing lane selects
windows and confirms drafts. Stream failures/cache misses retain the original HTTP window fallback;
late socket replies cannot publish directly. `livekit-stt.test.ts` covers transport and lane wiring.

`vad-shadow.ts` optionally tees filtered audio/state to hosted Silero and compares source-stamped
events and candidate readiness. Its failure/disagreement never enters the primary controller;
current KWS, turn/quiet/ASR-tail rules remain authoritative. Tests cover generation fences and
unchanged question dispatch on observer disagreement/failure.

| File | Role |
|---|---|
| `index.ts` | **composition root** — validates config, launches the browser, wires the REAL adapters, runs the orchestrator, exits. Speak acts are tee'd to a voice handler (orchestrator core untouched). The container entrypoint (`main`). |
| `config.ts` | `invocation.v1` boot config — parse + ajv-validate `TINA_BOT_CONFIG`, fail-fast (P14). Exports the typed `Invocation`. |
| `ports.ts` | the port interfaces the core depends on: `JoinDriver · Pipeline · TranscriptSink · LifecycleSink · ActsSource · RecordingSink`. Pure (no transport types). |
| `test-doubles.ts` | shared L2 port doubles (`noopAloneness`, `noopActs`, `noopPipeline`, …) — one export site for every orchestrator construction in tests. |
| `orchestrator.ts` | the `lifecycle.v1` state machine (`createOrchestrator`) — joining → awaiting_admission → active → (completed \| failed). Depends only on ports. |
| `contracts.ts` | TS mirrors of the published `lifecycle.v1 · acts.v1 · transcript.v1` schemas + the executable `canTransition` machine. |
| `join-driver.ts` | **JoinDriver** — wraps `@tina/join` `joinMeeting`/leave/removal (guest + authenticated); maps `JoinState`→`BotStatus`. |
| `pipeline.ts` | **Pipeline** — `google_meet`→`@tina/gmeet-pipeline` (per-channel, glow-named) · `zoom`/`teams`→`@tina/mixed-pipeline`; STT via `@tina/transcribe-whisper`; lane sink → bot `TranscriptSink.publish`. Exposes `feedAudio`. |
| `recording.ts` | **RecordingSink** — `@tina/recording` assembler (`buildRecordingMaster` on `is_final`/`close`) → upload (`RecordingService`). |
| `capture-bridge.ts` | **L4-pending (O6)** — browser launch (+ S3 auth profile), page-side capture inject + PCM pump → `pipeline.feedAudio`, and the speak controller. Browser-resident; not unit-provable — validated on the VM. |
| `*.test.ts` | L1/L2/L3 — config (ajv goldens) · orchestrator (lifecycle.v1 sequence, fake ports) · lifecycle-http/transcript-redis/acts-redis (transports) · **pipeline (L3: capture→lane→stt→publish, overlap no cross-mislabel)** · **recording (L3: webm/wav/seq)**. |

Tests run via `tsx` (no build step): `npx tsx src/<file>.test.ts`; all chained in `npm test`.

Voice cancellation fences every asynchronous stop/receipt boundary so a superseded interruption
cannot revive a continuation. Brief missing Meet participant metadata is retained only on a continuous
channel clock for at most 1.5 seconds; resets, contradictions and expiry drop the binding. Explicit
interruption echo checks compare the current spoken phrase, not any keyword in cumulative answers.
`voice-regression.test.mjs` reproduces the stop/receipt race and metadata loss; interruption tests
cover a real stop command when the answer merely mentions that keyword.

Google Meet microphone control accepts only self-microphone action labels and, when present, reads
`data-is-muted`. Remote participant mute/presentation controls cannot establish the bot's mic state.
The serialized browser helper lives in `meeting-microphone.ts`; tests include the remote-control
labels observed in the live Meet UI. Playback and Stop still require a verified self-mic state.

Voice caller continuation expires after five seconds following acknowledgment, completed reply or
resumable interruption; a later question requires a fresh acoustic wake.

Noise suppression fails open with each pending frame delivered once, then retries on a new valid
frame after five seconds. Old worker replies are generation-fenced; disabled/closed filters stay off.
The LiveKit noise endpoint keeps healthy idle connections open while periodically rechecking authority.

Transient config/ASR probe failures may rearm voice on the next healthy two-second poll only after
local playback stop, required receipt delivery and core turn release succeeded. Retired callbacks
remain fenced. Worker construction/control errors, existing safety errors, unconfirmed cleanup
and manual playback are not automatically cleared by a healthy probe.

Optional delayed acknowledgment failures are logged without discarding a verified main answer. A failed, unplayed TTS lookahead is cancelled and prepared once more at its actual playback turn, after current generation/policy checks; a failed primary attempt or any started playback is never retried. Existing turn deadlines, Stop fences, and two-handle limits remain unchanged.

PreparedSpeech.failedBeforePlayback reports current unplayed stream failure even after its ready Promise resolved. The voice controller retries a failed prefetched sentence at most once, including failures during mic setup, cancels later speculative audio before replacement, and never retries started playback. Optional and name-only acknowledgments carry a three-second per-call TTS deadline through SpeakController; answer synthesis keeps its existing deadline.

Mic UI recovery: each queued microphone request has a five-second caller deadline. The actual browser evaluation queue remains serialized because a timed-out evaluate can click late. Timeout stops local PCM and refuses new unmute until a queued mute is verified. Voice cancellation persists the heard prefix and releases the server turn independently of waiting for mic UI completion; an unverified mute leaves voice in ERROR.
