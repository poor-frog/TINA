# Shared local speech primitives

Host pilot: pinned Sherpa KWS and Silero question capture remain available through the legacy CLI.
Bot mode: `python -m tina_meeting_voice.bot /models/meeting-voice --vad-only` loads only Silero,
then reports per-channel activity/endpoints over bounded PCM IPC. No keyword model or ASR call
runs in this child. `--vad-only --setup` downloads/verifies only the pinned VAD asset.

A separate `bot /models/meeting-voice/livekit-tina-v1 --kws` child detects the two retained calls
(`hey_tina`, `tina_oi`) while LISTENING. It verifies model hashes, loads CPU ONNX sessions once
per bot and keeps independent channel streams (up to 32, idle eviction after 20 seconds).
64 ms packets are buffered into 80 ms inference steps. The TypeScript controller alone dispatches
turns, using the same selected ASR for question text. Busy/quiet/Stop clear and gate KWS; failure
makes voice unavailable without interrupting transcript. See [setup](../../../../deploy/wakeword/README.md).

Name aliases only clean a question copy after acoustic confirmation; they do not activate a new bot.
Raw ASR and canonical transcript remain unchanged. The legacy host pilot is independent.

VAD continues endpoint reporting in THINKING/SPEAKING so the TypeScript controller can validate
explicit same-caller interruption through the existing ASR. Native VAD never decides to interrupt
or re-arms KWS while busy; ordinary speech/backchannels cannot dispatch a new turn by themselves.

Temporary absence of Meet participant metadata preserves the channel's KWS history. A different
known participant ID, backwards source clock or sample gap still resets the stream. Participant
metadata is not account authentication; meeting source permissions remain server-owned.

The bot controller may preserve a caller while a different known ID speaks on another fresh
channel. KWS itself still emits channel-local detections. Both `hey_tina` and `tina_oi` use a
runtime score threshold of 0.4, also enforced by the bot controller; per-model cooldown stays 1.5s.
A fresh known caller can take an idle follow-up slot only, not preempt a question or playback.

## Smart Turn and Namo observations

`TINA_VOICE_TURN_SHADOW=1` starts an isolated CPU process in new voice bots. It uses pinned
Smart Turn v3.2 INT8 and Namo v1 Multilingual INT8 plus tokenizer. `make all` installs hash-verified
assets into the existing model volume; inference mounts them read-only and never downloads them.
Scores never authorize a voice turn or introduce a wait. Stop, resumed speech and source/identity
changes fence old results. Only content-free scores/timing are logged; text/audio stay in bounded
memory and IPC. A slow/failed observer is retired independently of VAD/ASR.
See [deployment and interpretation](../../../../docs/tina-turn-shadow.md).
