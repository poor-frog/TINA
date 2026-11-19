# Local LiveKit wake-word activation

New voice-capable Google Meet bots use LiveKit WakeWord 2.1.1 CPU ONNX detectors for **TINA ơi**
and **hey TINA**. Standalone TINA and ê TINA detectors/checkpoints were deleted. Each bot shares
loaded model sessions across bounded channel-local streams; 64 ms capture packets feed 80 ms
inference steps. No cloud wake-word service is used.

KWS authorizes one caller; the existing selected VieGem + KenLM + FSMN-VAD or Gipformer 1.5 +
FSMN-VAD still supplies question text and the uninterrupted meeting transcript. A corrected copy
may remove recognized name variants after acoustic confirmation. Raw ASR/transcript is unchanged.
ASR text alone cannot activate a new KWS bot. Cached hypotheses handle ASR arriving before KWS;
source clocks, channel identity and Stop generations fence older audio and late responses.
Meet may omit participant metadata between adjacent packets. This does not erase KWS acoustic
history on a continuous channel; conflicting known participant IDs or source discontinuities still
reset it. A missing identity never becomes an account identity or grants additional sources.

The controller follows LISTENING → CAPTURING → THINKING → SPEAKING → QUIET. KWS is gated after
accepting a call, and resumes after received room quiet (~800 ms). A standalone recognized name
gets “Dạ, em nghe.”, then a bounded same-caller continuation. Stop/leave cancel the turn and release
native state. Missing/invalid KWS assets or worker failure make voice unavailable while transcript
ASR continues; there is no automatic ASR-name fallback.

## Short conversations

After successful answer playback (including a clarification), the identified caller gets a
15-second follow-up window without another wake phrase. Both capture channel and known transport
participant ID must match; absent identity requires calling the bot again. The absolute deadline
starts after playback, is not extended by waiting for room quiet, and Stop/leave/policy changes or
playback failure cancel the window. KWS/ASR models, transcript and source permissions are unchanged.

A standalone name still gets “Dạ, em nghe.”. A question with a fast answer speaks directly;
only a new request still waiting after 900 ms gets that cached acknowledgment. Follow-ups never
repeat it. Fast errors/Stop cancel the delayed acknowledgment. Completed, source-validated history
keeps at most three turns. A recent clarification is explicitly marked for interpreting a short
answer such as “Production”; history is context, never evidence, and revoked sources invalidate it.

## Multiple participants

Only one question/answer is active per room. Distinct channels with distinct known transport IDs
and recent audio may overlap without cancelling the selected caller's capture. Other channels'
ASR hypotheses never become that caller's question. Missing/stale IDs, duplicate IDs across channels
or conflicting bindings still refuse ambiguous overlap. This is routing evidence, not speaker
separation: already mixed audio is not disentangled, and display names never grant account access.

After answer playback and received room quiet, a fresh KWS call from another identified participant
can replace the idle 15-second follow-up slot. The previous caller's pending ASR/question, THINKING,
SPEAKING and QUIET states cannot be preempted this way. Unidentified handoffs and source-clock-old
wakes are refused. The new turn gets its own participant-derived conversation key; the old caller
must call again rather than append to the new person's turn. Source permissions remain meeting-owned.

`smoke_multiparty.mjs` checks native KWS/VAD with two simultaneous synthetic channels, preservation
of the selected question, post-answer handoff and distinct speaker keys. ASR/LLM/playback are fakes;
real multi-person Meet identity coverage, mixed audio, accents and echo need meeting acceptance.

## Pauses and explicit interruptions

The first turn-ending implementation is local and lexical, not an extra semantic model/LLM call.
Incomplete endings (ellipsis, conjunctions, “giúp tôi”, “về”, etc.) wait up to two seconds from the
source speech endpoint; complete questions and short clarification answers keep the prior cadence.
Resumed speech clears that endpoint, and the existing 20-second question bound remains.

While thinking or speaking, native VAD still tracks audio and advances the same selected ASR window.
Only the identified current caller on the same channel can interrupt with “Khoan”, “Dừng lại”,
“Ngừng lại”, “Ý tôi là…” (also stop/wait/I mean). A final ASR result or agreeing drafts is required;
old/unaligned windows, another identity/channel, backchannels and command phrases present in the
bot's spoken text are refused. KWS remains locked. This is not general speech barge-in or acoustic
echo cancellation. Missing caller identity keeps voice interruption off; the existing Stop button works.

“Dừng lại” stops the turn. “Khoan” opens a bounded same-caller continuation; a correction already
captured with the command is retained across room quiet and confirmed through the existing ASR.
Local playback is stopped before reporting cancellation. Successful sentence playback sends a
monotonic played-text prefix; interrupted history and cards use only whole completed sentences.
The in-progress sentence is omitted because word/audio playback alignment is not available.
The full generated proposal remains separate from played text and never overwrites transcript.

`smoke_turns.mjs` covers real native KWS/VAD during fake playback, explicit caller correction,
backchannel/other-speaker rejection and preservation of the completed prefix. Its ASR, LLM and
playback are fakes; meeting echo, accents and interruption latency still require real-user trials.

## Install local models

Build the current bot image first, then provision the operator-owned cache (Silero is preserved):

```sh
docker --context orbstack run --rm --network none --entrypoint /opt/tina-voice/bin/python \
  --mount type=bind,source="$PWD/output/wakeword-training/tina-v1/models",target=/source,readonly \
  --mount type=bind,source="$PWD/deploy/wakeword/install_local.py",target=/installer.py,readonly \
  --mount type=volume,source=tina-production_meeting-voice-models,target=/models/meeting-voice \
  tina/tina-bot:kws-activation-v1 /installer.py /source /models/meeting-voice
```

Both ONNX hashes are checked before loading. LICENSE/NOTICE travel with the cache. Reinstallation
removes the explicitly retired tina.onnx/e_tina.onnx files. Runtime mounts the cache read-only;
joining a meeting never downloads weights or requires a new credential. A fresh clone needs these
same artifacts or the local [training recipe](training/README.md); make all does not recreate them.

## Readiness and testing

Settings → Voice assistant shows LiveKit/version/CPU, the two calls, selected question ASR and
owner-only per-bot readiness. No active bot is distinct from a verified loaded model; old/missing/
expired session heartbeats never count as ready. Refresh status reads the current bot reports.

Bot Docker logs contain content-free type=kws, mode=activation records: ready/failed and accepted
wake model, score, channel, source-frame end, receipt time and inference duration. Participant IDs
travel only over local PCM IPC for channel fencing; they, recognized words and audio are not logged.
Source-frame end is a packet boundary, not forced keyword alignment.

Content-free candidate/metrics records report pre-gate scores, source age, an identity-conflict boolean
and per-channel peak/reset counters every three seconds. No participant IDs, audio or question text
are logged. These distinguish a low score from a rejected event.

The receive sink `meeting_rx` is separate from `tts_sink`. The virtual microphone stays available
to Chromium; the TTS sink and verified Meet mute button gate speech. System-muting the virtual
source makes Meet show a microphone problem and can block UI unmute. `smoke_audio.mjs` tests real
Chromium/PulseAudio locally: receive audio cannot enter the mic, TTS can, and Stop mutes its sink
while keeping the device available.

The conversation image is tagged tina/tina-bot:voice-dialogue-v1 and the runtime's tina/tina-bot:dev;
only newly created bots get it. Existing in-room bots keep their image and behavior.

smoke_bot.mjs checks real native KWS/VAD over 64 ms synthetic PCM, an authorized ASR question and
a same-caller follow-up without another wake or redundant acknowledgment,
LLM/TTS dispatch, silence isolation, playback gating and refusal with missing KWS assets. ASR/API/
playback are fakes in this check: it does not establish meeting accuracy or actual remote audibility.
Test real accented voices, immediate questions, overlap, echo and Stop; measure the two-model union
on labeled real audio before interpreting synthetic recall or false-alarm rates as meeting results.
