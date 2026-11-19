# Shared native voice runtime

Pinned CPU KWS/Silero assets and bounded capture are used by the host pilot and in-bot worker. `bot.py` accepts bounded content-free control plus transient PCM over stdin; it emits state and a single bounded captured WAV. Native runtime downloads nothing.

`--kws` runs the separate LiveKit WakeWord 2.1.1 CPU worker. It verifies livekit-models.json,
shares sessions across channel-local streams and emits model/score/channel/source-clock detections.
Participant identity is transient IPC metadata for channel fencing, never logged or used as account
authentication. The TypeScript controller accepts KWS evidence and existing ASR question text; native
inference never calls LLM/TTS itself. Busy/quiet/Stop clear streams, and runtime downloads nothing.
